/**
 * web-auth.ts — Browser-side identity & key management
 *
 * Flow:
 *  1. On load: restore agent_id + secretKey from localStorage
 *  2. If ?auth=xxx in URL: validate + adopt that key (agent link-in)
 *  3. If no key: auto-register → receive sk_ + pk_ keys → store
 *  4. All API calls include Authorization: Bearer sk_xxx
 *  5. Watch links use ?watch=<agent_id> (no secret exposed)
 */

const KEY_AGENT_ID  = 'agent_id';
const KEY_SECRET    = 'agent_secret_key';
const KEY_PUBLISH   = 'agent_publishable_key';
const KEY_NAME      = 'agent_name';
// Legacy key for migration
const KEY_API_KEY   = 'agent_api_key';

export interface WebIdentity {
  agentId:  string;
  agentName: string;
  apiKey:   string; // secret key (sk_) — used for Authorization header
  publishableKey?: string; // pk_ key — safe to share
  currentRoom?: string | null;
}

const ADJ  = ['Silver','Quantum','Iron','Neon','Blaze','Storm','Crypto','Vector','Binary','Prime','Void','Apex'];
const NOUN = ['Fox','Ace','Shark','King','Wolf','Hawk','Blade','Ghost','Knight','Raiser','Caller','Bluffer'];
function randomName() {
  return ADJ[Math.floor(Math.random()*ADJ.length)] + NOUN[Math.floor(Math.random()*NOUN.length)];
}
function randomId() {
  return 'agent_' + Math.random().toString(36).slice(2, 10);
}

/** Returns auth headers for all API calls */
export function authHeaders(apiKey: string): HeadersInit {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
}

/**
 * Load or create identity. Call once on page mount.
 * Handles ?auth= URL param (agent opens browser link).
 * Returns identity or null on error.
 */
export async function resolveIdentity(): Promise<WebIdentity> {
  // 1. Check ?auth= URL param — agent-generated link (backward compat)
  const urlParams = new URLSearchParams(window.location.search);
  const urlKey = urlParams.get('auth');
  if (urlKey && urlKey.startsWith('sk_')) {
    const identity = await validateAndAdoptKey(urlKey);
    if (identity) {
      urlParams.delete('auth');
      const newUrl = window.location.pathname + (urlParams.toString() ? '?' + urlParams.toString() : '');
      window.history.replaceState({}, '', newUrl);
      return identity;
    }
  }

  // 2. Restore from localStorage (try new keys first, then legacy)
  const storedSecret  = localStorage.getItem(KEY_SECRET) || localStorage.getItem(KEY_API_KEY);
  const storedId      = localStorage.getItem(KEY_AGENT_ID);
  const storedName    = localStorage.getItem(KEY_NAME);
  const storedPublish = localStorage.getItem(KEY_PUBLISH);

  if (storedSecret && storedId) {
    try {
      const res = await fetch('/api/casino?action=me', {
        headers: { 'Authorization': `Bearer ${storedSecret}` },
      });
      if (res.ok) {
        const data = await res.json();
        const name = data.name ?? storedName ?? storedId;
        const pk = data.publishable_key ?? storedPublish ?? '';
        localStorage.setItem(KEY_NAME, name);
        if (pk) localStorage.setItem(KEY_PUBLISH, pk);
        return { agentId: storedId, agentName: name, apiKey: storedSecret, publishableKey: pk };
      }
    } catch { /* offline, proceed with stored values */ }
    // Session expired on server — re-register same id
    return register(storedId, storedName ?? randomName());
  }

  // 3. First time — generate id + name and register
  const id   = storedId   || randomId();
  const name = storedName && storedName !== id ? storedName : randomName();
  return register(id, name);
}

async function validateAndAdoptKey(key: string): Promise<WebIdentity | null> {
  try {
    const res = await fetch('/api/casino?action=me', {
      headers: { 'Authorization': `Bearer ${key}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const identity: WebIdentity = {
      agentId:   data.agent_id,
      agentName: data.name,
      apiKey:    key,
      publishableKey: data.publishable_key ?? '',
      currentRoom: data.current_room ?? null,
    };
    persist(identity);
    return identity;
  } catch { return null; }
}

async function register(agentId: string, name: string): Promise<WebIdentity> {
  try {
    const res = await fetch('/api/casino', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'register', agent_id: agentId, name }),
    });
    const data = await res.json();
    const sk = data.secretKey;
    const pk = data.publishableKey || '';
    if (sk) {
      const identity: WebIdentity = { agentId, agentName: name, apiKey: sk, publishableKey: pk };
      persist(identity);
      return identity;
    }
  } catch { /* fall through */ }
  // Offline fallback
  const identity: WebIdentity = { agentId, agentName: name, apiKey: '' };
  localStorage.setItem(KEY_AGENT_ID, agentId);
  localStorage.setItem(KEY_NAME, name);
  return identity;
}

function persist(identity: WebIdentity) {
  localStorage.setItem(KEY_AGENT_ID,  identity.agentId);
  localStorage.setItem(KEY_NAME,      identity.agentName);
  localStorage.setItem(KEY_SECRET,    identity.apiKey);
  if (identity.publishableKey) {
    localStorage.setItem(KEY_PUBLISH, identity.publishableKey);
  }
  // Clean up legacy key
  localStorage.removeItem(KEY_API_KEY);
}

/** Save updated name (after rename) */
export function persistName(name: string) {
  localStorage.setItem(KEY_NAME, name);
}

/** Build a ?auth= link that lets an agent open the browser pre-authenticated */
export function buildAuthLink(baseUrl: string, apiKey: string): string {
  return `${baseUrl}?auth=${apiKey}`;
}

/** Build a safe watch link using agent_id (no secret exposed) */
export function buildWatchLink(baseUrl: string, agentId: string): string {
  return `${baseUrl}?watch=${agentId}`;
}

/** Resolve a ?watch= param to the agent's current room */
export async function resolveWatch(agentId: string): Promise<{ agent_id: string; name: string; current_room: string | null } | null> {
  try {
    const res = await fetch(`/api/casino?action=resolve_watch&agent_id=${encodeURIComponent(agentId)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}
