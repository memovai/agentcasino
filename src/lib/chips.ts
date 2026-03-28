import { Agent } from './types';
import { saveAgent, loadAgents } from './casino-db';

const CLAIM_AMOUNT = 50_000;         // chips per claim
const CLAIM_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour between claims
const MAX_CLAIMS_PER_DAY = 12;       // max 12 claims/day = 600k/day

// Global singleton to share state between API routes
const globalAny = globalThis as any;
if (!globalAny.__casino_agents) {
  globalAny.__casino_agents = new Map<string, Agent>();
  // Hydrate from Supabase on first boot
  loadAgents().then(persisted => {
    for (const [id, agent] of persisted) {
      if (!globalAny.__casino_agents.has(id)) {
        globalAny.__casino_agents.set(id, agent);
      }
    }
  });
}
const agents: Map<string, Agent> = globalAny.__casino_agents;

function todayStr(): string {
  return new Date().toISOString().split('T')[0];
}

export function getOrCreateAgent(id: string, name: string): Agent {
  let agent = agents.get(id);
  if (!agent) {
    agent = {
      id,
      name,
      chips: 0,
      claimsToday: 0,
      lastClaimAt: 0,
      lastClaimDate: '',
      createdAt: Date.now(),
    };
    agents.set(id, agent);
    saveAgent(agent);
  }
  // Reset daily claims if new day
  const today = todayStr();
  if (agent.lastClaimDate !== today) {
    agent.claimsToday = 0;
    agent.lastClaimDate = today;
  }
  return agent;
}

export function getAgent(id: string): Agent | undefined {
  const agent = agents.get(id);
  if (agent) {
    const today = todayStr();
    if (agent.lastClaimDate !== today) {
      agent.claimsToday = 0;
      agent.lastClaimDate = today;
    }
  }
  return agent;
}

export interface ClaimResult {
  success: boolean;
  message: string;
  chips: number;
  claimsToday?: number;
  maxClaims?: number;
  nextClaimIn?: number; // seconds until next claim available
}

export function claimChips(agentId: string): ClaimResult {
  const agent = agents.get(agentId);
  if (!agent) {
    return { success: false, message: 'Agent not found. Register first.', chips: 0 };
  }

  const today = todayStr();
  if (agent.lastClaimDate !== today) {
    agent.claimsToday = 0;
    agent.lastClaimDate = today;
  }

  // Check daily limit
  if (agent.claimsToday >= MAX_CLAIMS_PER_DAY) {
    return {
      success: false,
      message: `🎰 Daily limit reached (${MAX_CLAIMS_PER_DAY}/${MAX_CLAIMS_PER_DAY}). Come back tomorrow!`,
      chips: agent.chips,
      claimsToday: agent.claimsToday,
      maxClaims: MAX_CLAIMS_PER_DAY,
    };
  }

  // Check cooldown
  const now = Date.now();
  const elapsed = now - agent.lastClaimAt;
  if (elapsed < CLAIM_COOLDOWN_MS) {
    const remainSec = Math.ceil((CLAIM_COOLDOWN_MS - elapsed) / 1000);
    const remainMin = Math.ceil(remainSec / 60);
    return {
      success: false,
      message: `⏰ Cooldown: ${remainMin} min remaining. Claims: ${agent.claimsToday}/${MAX_CLAIMS_PER_DAY} today.`,
      chips: agent.chips,
      claimsToday: agent.claimsToday,
      maxClaims: MAX_CLAIMS_PER_DAY,
      nextClaimIn: remainSec,
    };
  }

  // Claim!
  agent.claimsToday += 1;
  agent.lastClaimAt = now;
  agent.chips += CLAIM_AMOUNT;
  saveAgent(agent);

  return {
    success: true,
    message: `💰 +${CLAIM_AMOUNT.toLocaleString()} chips! (${agent.claimsToday}/${MAX_CLAIMS_PER_DAY} today)`,
    chips: agent.chips,
    claimsToday: agent.claimsToday,
    maxClaims: MAX_CLAIMS_PER_DAY,
  };
}

export function getChipBalance(agentId: string): number {
  return agents.get(agentId)?.chips ?? 0;
}

export function deductChips(agentId: string, amount: number): boolean {
  const agent = agents.get(agentId);
  if (!agent || agent.chips < amount) return false;
  agent.chips -= amount;
  saveAgent(agent);
  return true;
}

export function addChips(agentId: string, amount: number): void {
  const agent = agents.get(agentId);
  if (agent) {
    agent.chips += amount;
    saveAgent(agent);
  }
}

export function getAllAgents(): Agent[] {
  return Array.from(agents.values());
}

export function listAgents(): Agent[] {
  return Array.from(agents.values());
}
