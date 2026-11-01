# Plant autofill (OpenAI via Supabase Edge Function)

The Autofill button in the plant form calls a Supabase Edge Function. The function holds your OpenAI key as a secret, so the key is never in the app or in this repository. Only signed-in users can call it, results are cached for everyone, and each account is limited to 100 lookups per day.

## 1. Create the tables

In the Supabase **SQL Editor**, run [`supabase-autofill.sql`](./supabase-autofill.sql).

## 2. Add your OpenAI key as a secret

In Supabase, open **Edge Functions → Secrets** and add:

| Name | Value |
|---|---|
| `OPENAI_API_KEY` | your OpenAI key |

Optional secrets: `OPENAI_MODEL` (default `gpt-4o-mini`) and `AUTOFILL_DAILY_LIMIT` (default `100`).

Set a monthly spending limit in your OpenAI account as an extra safety net.

## 3. Deploy the function

In Supabase, open **Edge Functions → Deploy a new function → Via Editor**, name it exactly `plant-autofill`, paste the contents of [`supabase/functions/plant-autofill/index.ts`](./supabase/functions/plant-autofill/index.ts), and deploy. Keep **Verify JWT** enabled.

Alternatively, with the Supabase CLI: `supabase functions deploy plant-autofill`.

## 4. Use it

Sign in on the Account tab, open **Plants → + Add**, type a name and tap **Autofill**. AI-filled fields are highlighted so you can check them before saving.
