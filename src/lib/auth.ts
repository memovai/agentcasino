/**
 * Agent Casino Identity & Auth
 *
 * Two auth modes:
 * 1. nit login — Ed25519 signature verification (recommended, persistent identity)
 * 2. Simple registration — just agent_id + name (fallback, no crypto)
 *
 * After login, an API key is issued. Use it via:
 *   Authorization: Bearer mimi_xxxxx
 *
 * API key is optional for backward compatibility — endpoints also accept
 * agent_id in the request body/query for simple mode.
 */

import { createPublicKey, verify as cryptoVerify, KeyObject } from 'crypto';
import { v4 as uuid } from 'uuid';
import { Agent } from './types';
import { getOrCreateAgent, getAgent } from './chips';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Session {
  apiKey: string;
  agentId: string;
  name: string;
  publicKey: string | null; // hex-encoded Ed25519 public key (null for simple auth)
  authMethod: 'mimi' | 'simple';
  createdAt: number;
  lastSeen: number;
}

export interface MimiLoginPayload {
  agent_id: string;
  domain: string;
  timestamp: number;
  signature: string; // hex-encoded Ed25519 signature
  public_key: string; // hex or base64 encoded Ed25519 public key
  name?: string;
}

export interface LoginResult {
  success: boolean;
  apiKey?: string;
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
if (!globalAny.__casino_agent_to_key) {
  globalAny.__casino_agent_to_key = new Map<string, string>();
}
const sessions: Map<string, Session> = globalAny.__casino_sessions;
const agentToKey: Map<string, string> = globalAny.__casino_agent_to_key;

// ---------------------------------------------------------------------------
// API Key generation
// ---------------------------------------------------------------------------

function generateApiKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `mimi_${hex}`;
}

// ---------------------------------------------------------------------------
// nit Login — Ed25519 signature verification
// ---------------------------------------------------------------------------

const CASINO_DOMAIN = process.env.CASINO_DOMAIN || 'agentcasino.dev';
const MAX_TIMESTAMP_AGE_MS = 5 * 60 * 1000; // 5 minutes

export function verifyMimiLogin(payload: MimiLoginPayload): LoginResult {
  const { agent_id, domain, timestamp, signature, public_key, name } = payload;

  // Validate required fields
  if (!agent_id || !domain || !timestamp || !signature || !public_key) {
    return { success: false, error: 'Missing required fields: agent_id, domain, timestamp, signature, public_key' };
  }

  // Check timestamp freshness
  const now = Date.now();
  if (Math.abs(now - timestamp) > MAX_TIMESTAMP_AGE_MS) {
    return { success: false, error: `Login payload expired. Timestamp must be within ${MAX_TIMESTAMP_AGE_MS / 1000}s of server time.` };
  }

  // Decode public key (support both hex and base64)
  let pubKeyBytes: Uint8Array;
  try {
    pubKeyBytes = decodeKey(public_key);
    if (pubKeyBytes.length !== 32) {
      return { success: false, error: `Invalid public key length: expected 32 bytes, got ${pubKeyBytes.length}` };
    }
  } catch {
    return { success: false, error: 'Failed to decode public_key. Use hex or base64 encoding.' };
  }

  // Decode signature
  let sigBytes: Uint8Array;
  try {
    sigBytes = decodeKey(signature);
    if (sigBytes.length !== 64) {
      return { success: false, error: `Invalid signature length: expected 64 bytes, got ${sigBytes.length}` };
    }
  } catch {
    return { success: false, error: 'Failed to decode signature. Use hex or base64 encoding.' };
  }

  // Reconstruct the signed message: "login:<domain>:<agent_id>:<timestamp>"
  const message = `login:${domain}:${agent_id}:${timestamp}`;
  const messageBytes = new TextEncoder().encode(message);

  // Verify Ed25519 signature using Node.js crypto
  let valid: boolean;
  try {
    // Build Ed25519 public key in DER format for Node.js crypto
    // Ed25519 DER prefix: 302a300506032b6570032100 + 32 bytes of public key
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

  // Public key hex for storage
  const pubKeyHex = Array.from(pubKeyBytes).map(b => b.toString(16).padStart(2, '0')).join('');

  // Check if this public key is already registered under a different agent_id
  // (nit identity is tied to the public key, not the agent_id string)

  // Create or update agent
  const displayName = name || agent_id;
  const agent = getOrCreateAgent(agent_id, displayName);

  // Issue or reuse API key
  let apiKey = agentToKey.get(agent_id);
  if (!apiKey || !sessions.has(apiKey)) {
    apiKey = generateApiKey();
    agentToKey.set(agent_id, apiKey);
  }

  const session: Session = {
    apiKey,
    agentId: agent_id,
    name: displayName,
    publicKey: pubKeyHex,
    authMethod: 'mimi',
    createdAt: sessions.get(apiKey)?.createdAt || now,
    lastSeen: now,
  };
  sessions.set(apiKey, session);

  // Welcome bonus for first-time agents (if they have 0 chips)
  let welcomeBonus = { bonusCredited: false, bonusAmount: 0 };
  if (agent.chips === 0 && agent.createdAt >= now - 5000) {
    agent.chips += 100_000;
    welcomeBonus = { bonusCredited: true, bonusAmount: 100_000 };
  }

  return {
    success: true,
    apiKey,
    agentId: agent_id,
    name: displayName,
    chips: agent.chips,
    authMethod: 'mimi',
    welcomeBonus,
  };
}

// ---------------------------------------------------------------------------
// Simple Login — no crypto, just agent_id + name
// ---------------------------------------------------------------------------

export function simpleLogin(agentId: string, name?: string): LoginResult {
  if (!agentId) {
    return { success: false, error: 'agent_id required' };
  }

  const displayName = name || agentId;
  const agent = getOrCreateAgent(agentId, displayName);

  // Issue or reuse API key
  let apiKey = agentToKey.get(agentId);
  if (!apiKey || !sessions.has(apiKey)) {
    apiKey = generateApiKey();
    agentToKey.set(agentId, apiKey);
  }

  const now = Date.now();
  const session: Session = {
    apiKey,
    agentId,
    name: displayName,
    publicKey: null,
    authMethod: 'simple',
    createdAt: sessions.get(apiKey)?.createdAt || now,
    lastSeen: now,
  };
  sessions.set(apiKey, session);

  // Welcome bonus
  let welcomeBonus = { bonusCredited: false, bonusAmount: 0 };
  if (agent.chips === 0 && agent.createdAt >= now - 5000) {
    agent.chips += 100_000;
    welcomeBonus = { bonusCredited: true, bonusAmount: 100_000 };
  }

  return {
    success: true,
    apiKey,
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

export function getSession(apiKey: string): Session | null {
  const session = sessions.get(apiKey);
  if (session) {
    session.lastSeen = Date.now();
  }
  return session || null;
}

export function resolveAgentId(req: { apiKey?: string; agentId?: string }): string | null {
  // Try API key first
  if (req.apiKey) {
    const session = getSession(req.apiKey);
    if (session) return session.agentId;
  }
  // Fallback to agent_id param (backward compat)
  return req.agentId || null;
}

export function extractApiKey(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(mimi_\w+)$/i);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decodeKey(encoded: string): Uint8Array {
  // Strip prefix like "ed25519:" if present
  const cleaned = encoded.replace(/^ed25519:/, '');

  // Try hex first
  if (/^[0-9a-fA-F]+$/.test(cleaned) && cleaned.length % 2 === 0) {
    const bytes = new Uint8Array(cleaned.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(cleaned.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  // Try base64
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
  return sessions.size;
}

export function getAuthStats(): { total: number; nit: number; simple: number } {
  let nit = 0, simple = 0;
  for (const s of sessions.values()) {
    if (s.authMethod === 'mimi') nit++;
    else simple++;
  }
  return { total: sessions.size, nit, simple };
}
