/**
 * Behavioral metrics — VPIP, PFR, AF, WTSD, W$SD, C-Bet.
 *
 * Tracked per agent across all hands. Used by GET ?action=stats.
 */

import type { PlayerAction } from './types';
import { saveAgentStats, loadAgentStats } from './casino-db';

// ---------------------------------------------------------------------------
// Raw counters (persisted across hands)
// ---------------------------------------------------------------------------

interface AgentRawStats {
  handsPlayed: number;
  vpipHands: number;          // voluntarily put in pot preflop
  pfrHands: number;           // preflop raise
  aggressiveActions: number;  // raise + all_in (when aggressive)
  passiveActions: number;     // call + check
  showdownHands: number;
  showdownWins: number;
  cbetOpportunities: number;  // was preflop aggressor, flop was dealt
  cbetMade: number;           // bet on flop as preflop aggressor
  // Streak tracking
  currentStreak: number;      // >0 = win streak, <0 = loss streak
  bestWinStreak: number;
  worstLossStreak: number;    // stored as positive number
}

// ---------------------------------------------------------------------------
// Per-hand transient state (cleared after hand resolves)
// ---------------------------------------------------------------------------

interface HandTracking {
  agentIds: string[];
  smallBlindId: string;
  bigBlindId: string;
  preflopAggressorId: string | null;
  // per-agent state for this hand
  agents: Map<string, {
    vpip: boolean;
    pfr: boolean;
    inHand: boolean;  // hasn't folded yet
    seenFlop: boolean;
  }>;
}

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

const g = globalThis as any;
if (!g.__casino_agent_stats) g.__casino_agent_stats = new Map<string, AgentRawStats>();
if (!g.__casino_hand_tracking) g.__casino_hand_tracking = new Map<string, HandTracking>();

const agentStats: Map<string, AgentRawStats> = g.__casino_agent_stats;
const handTracking: Map<string, HandTracking> = g.__casino_hand_tracking;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getOrCreate(agentId: string): AgentRawStats {
  if (!agentStats.has(agentId)) {
    agentStats.set(agentId, {
      handsPlayed: 0, vpipHands: 0, pfrHands: 0,
      aggressiveActions: 0, passiveActions: 0,
      showdownHands: 0, showdownWins: 0,
      cbetOpportunities: 0, cbetMade: 0,
      currentStreak: 0, bestWinStreak: 0, worstLossStreak: 0,
    });
  }
  return agentStats.get(agentId)!;
}

// ---------------------------------------------------------------------------
// Tracking hooks — called from poker-engine
// ---------------------------------------------------------------------------

/**
 * Called when a new hand starts.
 * players: ordered array (index 0 = dealer on heads-up, or seat order)
 * sbIdx / bbIdx: indices into players array
 */
export function trackHandStart(
  handId: string,
  agentIds: string[],
  sbIdx: number,
  bbIdx: number,
): void {
  // Increment handsPlayed for everyone seated
  for (const id of agentIds) {
    getOrCreate(id).handsPlayed++;
  }

  const tracking: HandTracking = {
    agentIds,
    smallBlindId: agentIds[sbIdx] ?? '',
    bigBlindId: agentIds[bbIdx] ?? '',
    preflopAggressorId: null,
    agents: new Map(),
  };
  for (const id of agentIds) {
    tracking.agents.set(id, { vpip: false, pfr: false, inHand: true, seenFlop: false });
  }
  handTracking.set(handId, tracking);
}

/**
 * Called after each player action in poker-engine.processAction.
 */
export function trackAction(
  handId: string,
  agentId: string,
  action: PlayerAction,
  phase: string,
): void {
  const h = handTracking.get(handId);
  if (!h) return;
  const s = getOrCreate(agentId);
  const a = h.agents.get(agentId);
  if (!a) return;

  if (phase === 'preflop') {
    const isBlindCheck = (agentId === h.bigBlindId && action === 'check');

    switch (action) {
      case 'call':
        if (!a.vpip) { a.vpip = true; s.vpipHands++; }
        s.passiveActions++;
        break;
      case 'raise':
      case 'all_in':
        if (!a.vpip) { a.vpip = true; s.vpipHands++; }
        if (!a.pfr) { a.pfr = true; s.pfrHands++; }
        s.aggressiveActions++;
        h.preflopAggressorId = agentId;
        break;
      case 'check':
        if (!isBlindCheck) s.passiveActions++;
        break;
      case 'fold':
        a.inHand = false;
        break;
    }
  } else if (phase === 'flop') {
    // Track c-bet opportunity / made
    if (!a.seenFlop) {
      a.seenFlop = true;
      if (h.preflopAggressorId === agentId && a.inHand) {
        s.cbetOpportunities++;
        if (action === 'raise' || action === 'all_in') {
          s.cbetMade++;
        }
      }
    }

    switch (action) {
      case 'raise': case 'all_in': s.aggressiveActions++; break;
      case 'call': s.passiveActions++; break;
      case 'check': s.passiveActions++; break;
      case 'fold': a.inHand = false; break;
    }
  } else if (phase === 'turn' || phase === 'river') {
    switch (action) {
      case 'raise': case 'all_in': s.aggressiveActions++; break;
      case 'call': s.passiveActions++; break;
      case 'check': s.passiveActions++; break;
      case 'fold': a.inHand = false; break;
    }
  }
}

/**
 * Called when a hand ends (showdown or last-player win).
 * winners: array of agentIds who won something.
 * atShowdown: true for showdown, false for last-player win.
 */
export function trackHandEnd(
  handId: string,
  winnerIds: string[],
  atShowdown: boolean,
): void {
  const h = handTracking.get(handId);
  if (!h) return;

  if (atShowdown) {
    for (const [id, a] of h.agents) {
      if (a.inHand) {
        const s = getOrCreate(id);
        s.showdownHands++;
        if (winnerIds.includes(id)) s.showdownWins++;
      }
    }
  }

  // Streak tracking for all players in the hand
  for (const id of h.agentIds) {
    const s = getOrCreate(id);
    const isWinner = winnerIds.includes(id);
    if (isWinner) {
      s.currentStreak = s.currentStreak > 0 ? s.currentStreak + 1 : 1;
      if (s.currentStreak > s.bestWinStreak) s.bestWinStreak = s.currentStreak;
    } else {
      s.currentStreak = s.currentStreak < 0 ? s.currentStreak - 1 : -1;
      const lossLen = -s.currentStreak;
      if (lossLen > s.worstLossStreak) s.worstLossStreak = lossLen;
    }
  }

  handTracking.delete(handId);

  // Persist stats for every participant
  for (const id of h.agentIds) {
    const s = agentStats.get(id);
    if (s) saveAgentStats(id, s).catch(e => console.error('[stats] saveAgentStats:', e));
  }
}

// hydrateAgentStats removed — DB-first architecture reads on demand

// ---------------------------------------------------------------------------
// Computed stats for API
// ---------------------------------------------------------------------------

export interface ComputedStats {
  agent_id: string;
  hands_played: number;
  vpip_pct: number;
  pfr_pct: number;
  af: number;
  wtsd_pct: number;
  w_sd_pct: number;
  cbet_pct: number;
  style: string; // classification
  current_streak: number;
  best_win_streak: number;
  worst_loss_streak: number;
  raw: AgentRawStats;
}

function pct(n: number, d: number): number {
  if (d === 0) return 0;
  return Math.round((n / d) * 1000) / 10; // 1 decimal
}

function classifyStyle(vpip: number, af: number): string {
  if (vpip < 25 && af > 1.5) return 'TAG';
  if (vpip >= 25 && af > 1.5) return 'LAG';
  if (vpip < 25 && af <= 1.5) return 'Rock';
  return 'Calling Station';
}

function computeStats(agentId: string, r: AgentRawStats): ComputedStats {
  const vpip = pct(r.vpipHands, r.handsPlayed);
  const pfr = pct(r.pfrHands, r.handsPlayed);
  const af = r.passiveActions === 0
    ? r.aggressiveActions > 0 ? 99 : 0
    : Math.round((r.aggressiveActions / r.passiveActions) * 100) / 100;
  return {
    agent_id: agentId,
    hands_played: r.handsPlayed,
    vpip_pct: vpip,
    pfr_pct: pfr,
    af,
    wtsd_pct: pct(r.showdownHands, r.handsPlayed),
    w_sd_pct: pct(r.showdownWins, r.showdownHands),
    cbet_pct: pct(r.cbetMade, r.cbetOpportunities),
    style: classifyStyle(vpip, af),
    current_streak: r.currentStreak,
    best_win_streak: r.bestWinStreak,
    worst_loss_streak: r.worstLossStreak,
    raw: { ...r },
  };
}

export function getStats(agentId: string): ComputedStats {
  return computeStats(agentId, getOrCreate(agentId));
}

/**
 * DB-authoritative version of getStats — reads persisted counters from Supabase
 * and merges the volatile currentStreak from in-memory (not persisted).
 * Use this in API handlers to avoid cross-instance staleness.
 */
export async function getStatsFromDB(agentId: string): Promise<ComputedStats> {
  const dbRow = await loadAgentStats(agentId);
  if (!dbRow) return getStats(agentId); // fallback to memory if no DB row

  // Merge: use DB for all persistent counters; keep in-memory streak (volatile)
  const inMem = agentStats.get(agentId);
  const merged: AgentRawStats = {
    ...dbRow,
    currentStreak:   inMem?.currentStreak   ?? 0,
    bestWinStreak:   Math.max(dbRow.bestWinStreak,  inMem?.bestWinStreak  ?? 0),
    worstLossStreak: Math.max(dbRow.worstLossStreak, inMem?.worstLossStreak ?? 0),
  };
  // Update in-memory map so subsequent in-process calls are also accurate
  agentStats.set(agentId, merged);
  return computeStats(agentId, merged);
}

export function getAllStats(): ComputedStats[] {
  return Array.from(agentStats.keys()).map(getStats);
}
