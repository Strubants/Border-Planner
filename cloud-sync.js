const CONFIG_KEY = 'borderplanner-cloud-config';
const SESSION_KEY = 'borderplanner-cloud-session';
const LINK_KEY = 'borderplanner-cloud-link';
const DIRTY_KEY = 'borderplanner-cloud-dirty-account';

function readJSON(key) {
  const raw = localStorage.getItem(key);
  return raw ? JSON.parse(raw) : null;
}

// Publishable keys are designed to be public; Row Level Security protects the data.
const DEFAULT_CONFIG = {
  url: 'https://mwqqhixsfljggsaxptqd.supabase.co',
  publicKey: 'sb_publishable_hOuoA5gEMr0bav9gl6bm_A__3q58tNu',
};

function config() {
  return readJSON(CONFIG_KEY) || DEFAULT_CONFIG;
}

function session() {
  return readJSON(SESSION_KEY);
}

function linkedAccount() {
  return readJSON(LINK_KEY);
}

function setSession(value) {
  if (value) localStorage.setItem(SESSION_KEY, JSON.stringify(value));
  else localStorage.removeItem(SESSION_KEY);
}

function setLinkedAccount(value) {
  if (value) localStorage.setItem(LINK_KEY, JSON.stringify(value));
  else localStorage.removeItem(LINK_KEY);
}

function normalizedSession(value) {
  return {
    ...value,
    expires_at: value.expires_at || Math.floor(Date.now() / 1000) + (value.expires_in || 3600),
  };
}

export function getCloudConfig() {
  return config();
}

export function getStoredSession() {
  return session();
}

export function getLinkedAccount() {
  return linkedAccount();
}

export function linkAccount(userId, revision) {
  setLinkedAccount({ userId, revision });
}

export function clearAccountLink() {
  setLinkedAccount(null);
}

export function getDirtyAccount() {
  return localStorage.getItem(DIRTY_KEY);
}

export function markAccountDirty(userId) {
  localStorage.setItem(DIRTY_KEY, userId);
}

export function clearAccountDirty(userId) {
  if (localStorage.getItem(DIRTY_KEY) === userId) localStorage.removeItem(DIRTY_KEY);
}

export function configureCloud(projectUrl, publicKey) {
  let url;
  try {
    url = new URL(projectUrl.trim());
  } catch {
    throw new Error('Enter a valid Supabase project URL.');
  }
  if (!['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('Use an HTTPS Supabase project URL.');
  }
  const key = publicKey.trim();
  if (!key) throw new Error('Enter the Supabase publishable or anon public key.');
  if (key.startsWith('sb_secret_')) throw new Error('Secret keys are not safe to use in the app. Use a publishable or anon key.');
  const payload = key.split('.')[1];
  if (payload) {
    try {
      const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
      const claims = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')));
      if (claims.role === 'service_role') throw new Error('Service-role keys are not safe to use in the app. Use a publishable or anon key.');
    } catch (error) {
      if (error.message.includes('Service-role keys')) throw error;
    }
  }
  const value = { url: url.origin, publicKey: key };
  const current = config();
  if (current?.url !== value.url || current?.publicKey !== value.publicKey) {
    setSession(null);
    setLinkedAccount(null);
    localStorage.removeItem(DIRTY_KEY);
  }
  localStorage.setItem(CONFIG_KEY, JSON.stringify(value));
  return value;
}

async function request(path, { method = 'GET', body, token, allowNoContent = false } = {}) {
  const settings = config();
  if (!settings?.url || !settings?.publicKey) throw new Error('Set up the Supabase project connection first.');
  let response;
  try {
    response = await fetch(`${settings.url}${path}`, {
      method,
      headers: {
        apikey: settings.publicKey,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      cache: 'no-store',
    });
  } catch (error) {
    throw new Error(`Could not reach Supabase: ${error.message}`);
  }
  if (allowNoContent && response.status === 204) return null;
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error('Supabase returned an unreadable response.');
    }
  }
  if (!response.ok) {
    const message = payload?.msg || payload?.message || payload?.error_description || payload?.error;
    throw new Error(message || `Supabase returned HTTP ${response.status}.`);
  }
  return payload;
}

function saveAuthSession(value) {
  const next = normalizedSession(value);
  setSession(next);
  return next;
}

export async function signUp(email, password) {
  const redirect = `${location.origin}${location.pathname}`;
  const result = await request(`/auth/v1/signup?redirect_to=${encodeURIComponent(redirect)}`, {
    method: 'POST',
    body: { email, password },
  });
  const next = result?.access_token ? saveAuthSession(result) : null;
  return { session: next, user: next?.user || result?.user || result };
}

export async function signIn(email, password) {
  const result = await request('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email, password },
  });
  return saveAuthSession(result);
}

export async function signOut() {
  const current = session();
  if (current?.access_token) {
    await request('/auth/v1/logout', { method: 'POST', token: current.access_token, allowNoContent: true });
  }
  setSession(null);
}

export async function restoreSession() {
  let current = session();
  if (!current?.refresh_token) return null;
  try {
    if (current.expires_at <= Math.floor(Date.now() / 1000) + 60) {
      current = saveAuthSession(await request('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        body: { refresh_token: current.refresh_token },
      }));
    }
    const user = await request('/auth/v1/user', { token: current.access_token });
    current.user = user;
    setSession(current);
  } catch (error) {
    // Stay signed in when offline; only a rejected session should sign the user out.
    if (!error.message.startsWith('Could not reach Supabase') || !current.user) throw error;
  }
  return current;
}

export async function getAccessToken() {
  let current = session();
  if (!current?.refresh_token) throw new Error('Sign in to sync your data.');
  if (current.expires_at <= Math.floor(Date.now() / 1000) + 60) {
    current = saveAuthSession(await request('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      body: { refresh_token: current.refresh_token },
    }));
  }
  return current.access_token;
}

export async function getUserData(userId, accessToken) {
  const rows = await request(`/rest/v1/user_data?select=data,revision,updated_at&user_id=eq.${encodeURIComponent(userId)}&limit=1`, {
    token: accessToken,
  });
  return rows?.[0] || null;
}

export async function saveUserData(data, expectedRevision, accessToken) {
  const rows = await request('/rest/v1/rpc/save_user_data', {
    method: 'POST',
    token: accessToken,
    body: { p_data: data, p_expected_revision: expectedRevision },
  });
  return rows?.[0] || null;
}

export async function autofillPlant(name) {
  const settings = config();
  const token = await getAccessToken();
  let response;
  try {
    response = await fetch(`${settings.url}/functions/v1/plant-autofill`, {
      method: 'POST',
      headers: { apikey: settings.publicKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  } catch (error) {
    throw new Error(`Could not reach the autofill service: ${error.message}`);
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(response.status === 404
      ? 'Autofill is not set up yet. Deploy the plant-autofill function in Supabase.'
      : payload?.error || payload?.message || `Autofill failed (HTTP ${response.status}).`);
  }
  return payload;
}

export function consumeAuthRedirect() {
  const params = new URLSearchParams(location.hash.slice(1));
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (!accessToken || !refreshToken || !params.get('type')) return false;
  saveAuthSession({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: Number(params.get('expires_in')) || 3600,
    user: null,
  });
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  return true;
}
