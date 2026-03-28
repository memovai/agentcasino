/**
 * Agent Casino Identity & Auth
 *
 * Key types:
 *   sk_xxx — Secret key: full API access (play, bet, claim, chat)
 *   pk_xxx — Publishable key: read-only access (watch, stats, game state)
 *
 * Two auth modes:
 *   1. Ed25519 login — signature verification (recommended, persistent identity)
 *   2. Simple registration — agent_id + name (fallback, no crypto)
 *
 * Both modes issue sk_ + pk_ key pairs.
 *
 * Security: simple register only creates NEW agents. Existing agents with
 * keys cannot be re-registered (prevents account takeover).
 */

import { createPublicKey, verify as cryptoVerify } from 'crypto';
import { Agent } from './types';
import { getOrCreateAgent, getAgent } from './chips';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KeyType = 'secret' | 'publishable';

export interface Session {
  secretKey: string;
  publishableKey: string;
  agentId: string;
  name: string;
  publicKeyHex: string | null; // hex-encoded Ed25519 public key (null for simple auth)
  authMethod: 'mimi' | 'simple';
  createdAt: number;
  lastSeen: number;
}

export interface MimiLoginPayload {
  agent_id: string;
  domain: string;
  timestamp: number;
  signature: string;
  public_key: string;
  name?: string;
}

export interface LoginResult {
  success: boolean;
  secretKey?: string;
  publishableKey?: string;
  agentId?: string;
  name?: string;
  chips?: number;
  authMethod?: 'mimi' | 'simple';
  welcomeBonus?: { bonusCredited: boolean; bonusAmount: number };
  error?: string;
}

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

const globalAny = globalThis as any;
if (!globalAny.__casino_sessions) {
  globalAny.__casino_sessions = new Map<string, Session>();
}
if (!globalAny.__casino_agent_to_keys) {
  globalAny.__casino_agent_to_keys = new Map<string, { sk: string; pk: string }>();
}
/** Map from any key (sk_ or pk_) to Session */
const sessions: Map<string, Session> = globalAny.__casino_sessions;
/** Map from agentId to { sk, pk } */
const agentToKeys: Map<string, { sk: string; pk: string }> = globalAny.__casino_agent_to_keys;

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateSecretKey(): string {
  return `sk_${randomHex(24)}`;
}

function generatePublishableKey(): string {
  return `pk_${randomHex(24)}`;
}

// ---------------------------------------------------------------------------
// DB persistence
// ---------------------------------------------------------------------------

/** Persist keys to Supabase (fire-and-forget) */
function persistKeys(
  agentId: string,
  secretKey: string,
  publishableKey: string,
  authMethod: 'mimi' | 'simple',
  publicKeyHex?: string | null,
): void {
  const update: Record<string, unknown> = {
    secret_key: secretKey,
    publishable_key: publishableKey,
    auth_method: authMethod,
  };
  if (publicKeyHex) {
    update.public_key_hex = publicKeyHex;
  }
  supabase.from('casino_agents')
    .update(update)
    .eq('id', agentId)
    .then(({ error }) => { if (error) console.error('[auth] persistKeys:', error.message); });
}

/** Look up a session from Supabase when not found in memory (cold-start recovery) */
async function recoverSessionFromDB(key: string): Promise<Session | null> {
  const cols = 'id, name, secret_key, publishable_key, auth_method, public_key_hex';
  let query;
  if (key.startsWith('sk_')) {
    query = supabase.from('casino_agents').select(cols).eq('secret_key', key).single();
  } else if (key.startsWith('pk_')) {
    query = supabase.from('casino_agents').select(cols).eq('publishable_key', key).single();
  } else {
    // Unrecognized key prefix — no match
    return null;
  }

  const { data, error } = await query;
  if (error || !data) return null;

  const sk = data.secret_key || key;
  const pk = data.publishable_key || '';
  const now = Date.now();

  const session: Session = {
    secretKey: sk,
    publishableKey: pk,
    agentId: data.id,
    name: data.name,
    publicKeyHex: data.public_key_hex || null,
    authMethod: (data.auth_method ?? 'simple') as 'mimi' | 'simple',
    createdAt: now,
    lastSeen: now,
  };

  // Restore to in-memory cache
  if (sk) sessions.set(sk, session);
  if (pk) sessions.set(pk, session);
  agentToKeys.set(data.id, { sk, pk });
  return session;
}

/** Check if agent already has keys in DB */
async function agentHasKeysInDB(agentId: string): Promise<boolean> {
  const { data } = await supabase
    .from('casino_agents')
    .select('secret_key')
    .eq('id', agentId)
    .single();
  return !!data?.secret_key;
}

// ---------------------------------------------------------------------------
// Key type detection
// ---------------------------------------------------------------------------

export function getKeyType(key: string): KeyType | null {
  if (key.startsWith('sk_')) return 'secret';
  if (key.startsWith('pk_')) return 'publishable';
  return null;
}

export function isWriteKey(key: string): boolean {
  const type = getKeyType(key);
  return type === 'secret';
}

// ---------------------------------------------------------------------------
// Session creation helper
// ---------------------------------------------------------------------------

async function createSession(
  agentId: string,
  name: string,
  authMethod: 'mimi' | 'simple',
  publicKeyHex: string | null,
  existingKeys?: { sk: string; pk: string },
): Promise<{ session: Session; isNew: boolean }> {
  // Reuse existing keys if available in memory
  const cached = agentToKeys.get(agentId);
  let sk: string, pk: string;
  let isNew = false;

  if (existingKeys) {
    sk = existingKeys.sk;
    pk = existingKeys.pk;
  } else if (cached && sessions.has(cached.sk)) {
    sk = cached.sk;
    pk = cached.pk;
  } else {
    // Check DB for existing keys (cold start recovery)
    const { data } = await supabase
      .from('casino_agents')
      .select('secret_key, publishable_key')
      .eq('id', agentId)
      .single();
    if (data?.secret_key && data?.publishable_key) {
      sk = data.secret_key;
      pk = data.publishable_key;
    } else {
      sk = generateSecretKey();
      pk = generatePublishableKey();
      isNew = true;
    }
  }

  const now = Date.now();
  const session: Session = {
    secretKey: sk,
    publishableKey: pk,
    agentId,
    name,
    publicKeyHex: publicKeyHex,
    authMethod,
    createdAt: sessions.get(sk)?.createdAt || now,
    lastSeen: now,
  };

  sessions.set(sk, session);
  sessions.set(pk, session);
  agentToKeys.set(agentId, { sk, pk });

  if (isNew) {
    persistKeys(agentId, sk, pk, authMethod, publicKeyHex);
  }

  return { session, isNew };
}

// ---------------------------------------------------------------------------
// Ed25519 Login
// ---------------------------------------------------------------------------

const CASINO_DOMAIN = process.env.CASINO_DOMAIN || 'agentcasino.dev';
const MAX_TIMESTAMP_AGE_MS = 5 * 60 * 1000;

export async function verifyMimiLogin(payload: MimiLoginPayload): Promise<LoginResult> {
  const { agent_id, domain, timestamp, signature, public_key, name } = payload;

  if (!agent_id || !domain || !timestamp || !signature || !public_key) {
    return { success: false, error: 'Missing required fields: agent_id, domain, timestamp, signature, public_key' };
  }

  const now = Date.now();
  if (Math.abs(now - timestamp) > MAX_TIMESTAMP_AGE_MS) {
    return { success: false, error: `Login payload expired. Timestamp must be within ${MAX_TIMESTAMP_AGE_MS / 1000}s of server time.` };
  }

  let pubKeyBytes: Uint8Array;
  try {
    pubKeyBytes = decodeKey(public_key);
    if (pubKeyBytes.length !== 32) {
      return { success: false, error: `Invalid public key length: expected 32 bytes, got ${pubKeyBytes.length}` };
    }
  } catch {
    return { success: false, error: 'Failed to decode public_key. Use hex or base64 encoding.' };
  }

  let sigBytes: Uint8Array;
  try {
    sigBytes = decodeKey(signature);
    if (sigBytes.length !== 64) {
      return { success: false, error: `Invalid signature length: expected 64 bytes, got ${sigBytes.length}` };
    }
  } catch {
    return { success: false, error: 'Failed to decode signature. Use hex or base64 encoding.' };
  }

  const message = `login:${domain}:${agent_id}:${timestamp}`;
  const messageBytes = new TextEncoder().encode(message);

  let valid: boolean;
  try {
    const derPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    const derKey = Buffer.concat([derPrefix, Buffer.from(pubKeyBytes)]);
    const keyObj = createPublicKey({ key: derKey, format: 'der', type: 'spki' });
    valid = cryptoVerify(null, messageBytes, keyObj, Buffer.from(sigBytes));
  } catch {
    return { success: false, error: 'Signature verification failed (crypto error)' };
  }

  if (!valid) {
    return { success: false, error: 'Invalid signature. The Ed25519 signature does not match the public key.' };
  }

  const pubKeyHex = Array.from(pubKeyBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const displayName = name || agent_id;
  const agent = getOrCreateAgent(agent_id, displayName);

  const { session } = await createSession(agent_id, displayName, 'mimi', pubKeyHex);

  let welcomeBonus = { bonusCredited: false, bonusAmount: 0 };
  if (agent.chips === 0 && agent.createdAt >= now - 5000) {
    agent.chips += 500_000;
    welcomeBonus = { bonusCredited: true, bonusAmount: 500_000 };
  }

  return {
    success: true,
    secretKey: session.secretKey,
    publishableKey: session.publishableKey,
    agentId: agent_id,
    name: displayName,
    chips: agent.chips,
    authMethod: 'mimi',
    welcomeBonus,
  };
}

// ---------------------------------------------------------------------------
// Simple Login — no crypto, agent_id + name
// ---------------------------------------------------------------------------

export async function simpleLogin(agentId: string, name?: string): Promise<LoginResult> {
  if (!agentId) {
    return { success: false, error: 'agent_id required' };
  }

  const displayName = name || agentId;
  const existingAgent = getAgent(agentId);

  // Security: if agent already exists and has keys, reject re-registration.
  // This prevents account takeover by re-registering a known agent_id.
  if (existingAgent) {
    const cached = agentToKeys.get(agentId);
    if (cached && sessions.has(cached.sk)) {
      return { success: false, error: 'Agent already registered. Use your existing secret key to authenticate.' };
    }
    // Check DB too (cold start recovery)
    const hasKeys = await agentHasKeysInDB(agentId);
    if (hasKeys) {
      return { success: false, error: 'Agent already registered. Use your existing secret key to authenticate.' };
    }
  }

  const agent = getOrCreateAgent(agentId, displayName);
  const { session } = await createSession(agentId, displayName, 'simple', null);

  const now = Date.now();
  let welcomeBonus = { bonusCredited: false, bonusAmount: 0 };
  if (agent.chips === 0 && agent.createdAt >= now - 5000) {
    agent.chips += 500_000;
    welcomeBonus = { bonusCredited: true, bonusAmount: 500_000 };
  }

  return {
    success: true,
    secretKey: session.secretKey,
    publishableKey: session.publishableKey,
    agentId,
    name: displayName,
    chips: agent.chips,
    authMethod: 'simple',
    welcomeBonus,
  };
}

// ---------------------------------------------------------------------------
// Session lookup
// ---------------------------------------------------------------------------

export function getSession(key: string): Session | null {
  const session = sessions.get(key);
  if (session) {
    session.lastSeen = Date.now();
    return session;
  }
  return null;
}

/** Async version — falls back to Supabase on cold-start */
export async function getSessionAsync(key: string): Promise<Session | null> {
  const cached = getSession(key);
  if (cached) return cached;
  return recoverSessionFromDB(key);
}

export function resolveAgentId(req: { apiKey?: string; agentId?: string }): string | null {
  if (req.apiKey) {
    const session = getSession(req.apiKey);
    if (session) return session.agentId;
  }
  return req.agentId || null;
}

/** Async version — falls back to Supabase on cold-start */
export async function resolveAgentIdAsync(req: { apiKey?: string; agentId?: string }): Promise<string | null> {
  if (req.apiKey) {
    const session = await getSessionAsync(req.apiKey);
    if (session) return session.agentId;
  }
  return req.agentId || null;
}

export function extractApiKey(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+((sk_|pk_)\w+)$/i);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decodeKey(encoded: string): Uint8Array {
  const cleaned = encoded.replace(/^ed25519:/, '');
  if (/^[0-9a-fA-F]+$/.test(cleaned) && cleaned.length % 2 === 0) {
    const bytes = new Uint8Array(cleaned.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(cleaned.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export function getSessionCount(): number {
  // Each session is stored under both sk_ and pk_ keys, so divide by 2
  return Math.ceil(sessions.size / 2);
}

export function getAuthStats(): { total: number; nit: number; simple: number } {
  let nit = 0, simple = 0;
  const seen = new Set<string>();
  for (const s of sessions.values()) {
    if (seen.has(s.agentId)) continue;
    seen.add(s.agentId);
    if (s.authMethod === 'mimi') nit++;
    else simple++;
  }
  return { total: seen.size, nit, simple };
}
