// Supabase Edge Function: looks up plant care data with OpenAI.
// The OpenAI key lives only in the OPENAI_API_KEY secret and never reaches the browser.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const MODEL = Deno.env.get('OPENAI_MODEL') || 'gpt-4o-mini';
const DAILY_LIMIT = Number(Deno.env.get('AUTOFILL_DAILY_LIMIT') || 100);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['found', 'color', 'bloomFrom', 'bloomTo', 'water', 'sun', 'notes'],
  properties: {
    found: { type: 'boolean' },
    color: { type: 'string' },
    bloomFrom: { type: 'integer' },
    bloomTo: { type: 'integer' },
    water: { type: 'string', enum: ['', 'low', 'medium', 'high'] },
    sun: { type: 'string', enum: ['', 'sun', 'partial', 'shade'] },
    notes: { type: 'string' },
  },
};

const PROMPT = `You are a horticulture assistant for a garden planning app used in Flanders, Belgium (temperate maritime climate).
Given a plant name (common name in any language, or Latin name), return its typical garden data.
- found: false if the text is not a recognisable plant; then use empty values.
- color: the main flower colour (or foliage colour if it is grown for foliage) as a #rrggbb hex.
- bloomFrom / bloomTo: first and last flowering month as numbers 1-12 for Belgian conditions; 0 and 0 if it does not flower noticeably. A range may wrap around the year end.
- water: "low" (drought tolerant), "medium" or "high" (likes moist soil).
- sun: "sun" (full sun), "partial" (partial shade) or "shade" (full shade).
- notes: one or two short English sentences with the most useful care tips (height, pruning, soil). Plain text, max 200 characters.`;

const clean = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: auth, error: authError } = await admin.auth.getUser(token);
  if (authError || !auth.user) return json({ error: 'Sign in to use autofill.' }, 401);
  const userId = auth.user.id;

  let name = '';
  try {
    name = clean((await req.json()).name, 80);
  } catch {
    return json({ error: 'Send a JSON body with a plant name.' }, 400);
  }
  if (name.length < 2) return json({ error: 'Enter a plant name first.' }, 400);
  const key = name.toLowerCase().replace(/\s+/g, ' ');

  const { data: cached } = await admin.from('plant_autofill_cache').select('result').eq('name_key', key).maybeSingle();
  if (cached?.result) return json({ ...cached.result, cached: true });

  const day = new Date().toISOString().slice(0, 10);
  const { data: usage } = await admin.from('plant_autofill_usage').select('count').eq('user_id', userId).eq('day', day).maybeSingle();
  const used = usage?.count ?? 0;
  if (used >= DAILY_LIMIT) return json({ error: `Daily autofill limit (${DAILY_LIMIT}) reached. Try again tomorrow.` }, 429);

  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) return json({ error: 'Autofill is not configured on the server.' }, 500);

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      max_tokens: 300,
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: name },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'plant', strict: true, schema: SCHEMA } },
    }),
  });
  if (!response.ok) return json({ error: 'The plant lookup service failed. Try again later.' }, 502);

  let parsed;
  try {
    parsed = JSON.parse((await response.json()).choices[0].message.content);
  } catch {
    return json({ error: 'The plant lookup returned an unreadable answer.' }, 502);
  }

  const month = (n: unknown) => (Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 12 ? (n as number) : 0);
  let bloomFrom = month(parsed.bloomFrom);
  let bloomTo = month(parsed.bloomTo);
  if (!bloomFrom || !bloomTo) bloomFrom = bloomTo = 0;
  const result = {
    found: !!parsed.found,
    color: /^#[0-9a-fA-F]{6}$/.test(parsed.color) ? parsed.color.toLowerCase() : '',
    bloomFrom,
    bloomTo,
    water: ['low', 'medium', 'high'].includes(parsed.water) ? parsed.water : '',
    sun: ['sun', 'partial', 'shade'].includes(parsed.sun) ? parsed.sun : '',
    notes: clean(parsed.notes, 300),
  };

  await admin.from('plant_autofill_usage').upsert({ user_id: userId, day, count: used + 1 });
  if (result.found) await admin.from('plant_autofill_cache').upsert({ name_key: key, result });
  return json(result);
});
