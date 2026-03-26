import { Agent } from './types';
import { saveAgent, loadAgents } from './casino-db';

const MORNING_CLAIM_START = 9;  // 9:00 AM
const MORNING_CLAIM_END = 10;   // 10:00 AM
const AFTERNOON_START = 12;     // 12:00 PM
const AFTERNOON_END = 23;       // 11:00 PM
const CLAIM_AMOUNT = 100_000;

// Global singleton to share state between API routes and Socket.IO
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

function currentHour(): number {
  return new Date().getHours();
}

export function getOrCreateAgent(id: string, name: string): Agent {
  let agent = agents.get(id);
  if (!agent) {
    agent = {
      id,
      name,
      chips: 0,
      morningClaimed: false,
      afternoonClaimed: false,
      lastClaimDate: '',
      createdAt: Date.now(),
    };
    agents.set(id, agent);
    saveAgent(agent);
  }
  // Reset daily claims if new day
  const today = todayStr();
  if (agent.lastClaimDate !== today) {
    agent.morningClaimed = false;
    agent.afternoonClaimed = false;
    agent.lastClaimDate = today;
  }
  return agent;
}

export function getAgent(id: string): Agent | undefined {
  const agent = agents.get(id);
  if (agent) {
    const today = todayStr();
    if (agent.lastClaimDate !== today) {
      agent.morningClaimed = false;
      agent.afternoonClaimed = false;
      agent.lastClaimDate = today;
    }
  }
  return agent;
}

export interface ClaimResult {
  success: boolean;
  message: string;
  chips: number;
  claimType?: 'morning' | 'afternoon';
}

export function claimChips(agentId: string): ClaimResult {
  const agent = agents.get(agentId);
  if (!agent) {
    return { success: false, message: 'Agent not found. Register first.', chips: 0 };
  }

  const today = todayStr();
  if (agent.lastClaimDate !== today) {
    agent.morningClaimed = false;
    agent.afternoonClaimed = false;
    agent.lastClaimDate = today;
  }

  const hour = currentHour();

  // Morning claim: 9:00 - 10:00
  if (hour >= MORNING_CLAIM_START && hour < MORNING_CLAIM_END) {
    if (agent.morningClaimed) {
      return { success: false, message: '🌅 You already claimed your morning chips today!', chips: agent.chips };
    }
    agent.morningClaimed = true;
    agent.chips += CLAIM_AMOUNT;
    saveAgent(agent);
    return {
      success: true,
      message: `🌅 Morning check-in! +${CLAIM_AMOUNT.toLocaleString()} chips`,
      chips: agent.chips,
      claimType: 'morning',
    };
  }

  // Afternoon claim: 12:00 - 23:00
  if (hour >= AFTERNOON_START && hour < AFTERNOON_END) {
    if (agent.afternoonClaimed) {
      return { success: false, message: '🌇 You already claimed your afternoon chips today!', chips: agent.chips };
    }
    agent.afternoonClaimed = true;
    agent.chips += CLAIM_AMOUNT;
    saveAgent(agent);
    return {
      success: true,
      message: `🌇 Afternoon check-in! +${CLAIM_AMOUNT.toLocaleString()} chips`,
      chips: agent.chips,
      claimType: 'afternoon',
    };
  }

  return {
    success: false,
    message: `⏰ Claim hours: Morning 9:00-10:00, Afternoon 12:00-23:00. Current time: ${hour}:00`,
    chips: agent.chips,
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
