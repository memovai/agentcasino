/**
 * web-auth.ts — Browser-side identity & API key management
 *
 * Flow:
 *  1. On load: restore agent_id + apiKey from localStorage
 *  2. If ?auth=mimi_xxx in URL: validate + adopt that key (agent link-in)
 *  3. If no apiKey: auto-register → receive apiKey → store in localStorage
 *  4. All API calls include Authorization: Bearer mimi_xxx
 */

const KEY_AGENT_ID  = 'agent_id';
const KEY_API_KEY   = 'agent_api_key';
const KEY_NAME      = 'agent_name';

export interface WebIdentity {
  agentId:  string;
  agentName: string;
  apiKey:   string;
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
  // 1. Check ?auth= URL param — agent-generated link
  const urlParams = new URLSearchParams(window.location.search);
  const urlKey = urlParams.get('auth');
  if (urlKey && urlKey.startsWith('mimi_')) {
    const identity = await validateAndAdoptKey(urlKey);
    if (identity) {
      // Strip ?auth= from URL without reload
      urlParams.delete('auth');
      const newUrl = window.location.pathname + (urlParams.toString() ? '?' + urlParams.toString() : '');
      window.history.replaceState({}, '', newUrl);
      return identity;
    }
  }

  // 2. Restore from localStorage
  const storedKey   = localStorage.getItem(KEY_API_KEY);
  const storedId    = localStorage.getItem(KEY_AGENT_ID);
  const storedName  = localStorage.getItem(KEY_NAME);

  if (storedKey && storedKey.startsWith('mimi_') && storedId) {
    // Validate stored key is still alive (best-effort, skip if offline)
    try {
      const res = await fetch('/api/casino?action=me', {
        headers: { 'Authorization': `Bearer ${storedKey}` },
      });
      if (res.ok) {
        const data = await res.json();
        const name = data.name ?? storedName ?? storedId;
        localStorage.setItem(KEY_NAME, name);
        return { agentId: storedId, agentName: name, apiKey: storedKey };
      }
    } catch { /* offline, proceed with stored values */ }
    // Session expired on server (cold start) — re-register same id
    return register(storedId, storedName ?? randomName());
  }

  // 3. First time — generate id + name and register
  const id   = storedId   || randomId();
  const name = storedName && storedName !== id ? storedName : randomName();
  return register(id, name);
}

async function validateAndAdoptKey(apiKey: string): Promise<WebIdentity | null> {
  try {
    const res = await fetch('/api/casino?action=me', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const identity: WebIdentity = {
      agentId:   data.agent_id,
      agentName: data.name,
      apiKey,
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
    if (data.apiKey) {
      const identity: WebIdentity = { agentId, agentName: name, apiKey: data.apiKey };
      persist(identity);
      return identity;
    }
  } catch { /* fall through */ }
  // Offline fallback — no key, limited functionality
  const identity: WebIdentity = { agentId, agentName: name, apiKey: '' };
  localStorage.setItem(KEY_AGENT_ID, agentId);
  localStorage.setItem(KEY_NAME, name);
  return identity;
}

function persist(identity: WebIdentity) {
  localStorage.setItem(KEY_AGENT_ID,  identity.agentId);
  localStorage.setItem(KEY_NAME,      identity.agentName);
  localStorage.setItem(KEY_API_KEY,   identity.apiKey);
}

/** Save updated name (after rename) */
export function persistName(name: string) {
  localStorage.setItem(KEY_NAME, name);
}

/** Build a ?auth= link that lets an agent open the browser pre-authenticated */
export function buildAuthLink(baseUrl: string, apiKey: string): string {
  return `${baseUrl}?auth=${apiKey}`;
}
