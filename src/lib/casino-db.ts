/**
 * casino-db.ts — Supabase persistence layer for Agent Casino
 *
 * All writes are awaited — callers on critical paths must await to ensure consistency.
 */

import { supabase } from './supabase';
import { Agent, WinnerInfo, Player, Card } from './types';

// ── Agents ──────────────────────────────────────────────────────────────────

/** Load all agents from DB on server startup (includes claim tracking) */
export async function loadAgents(): Promise<Map<string, Agent>> {
  const { data, error } = await supabase
    .from('casino_agents')
    .select('id, name, chips, claims_today, last_claim_at, last_claim_date');

  if (error) { console.error('[casino-db] loadAgents:', error.message); return new Map(); }

  const map = new Map<string, Agent>();
  for (const row of data ?? []) {
    map.set(row.id, {
      id:            row.id,
      name:          row.name,
      chips:         row.chips,
      claimsToday:   row.claims_today    ?? 0,
      lastClaimAt:   row.last_claim_at   ?? 0,
      lastClaimDate: row.last_claim_date ?? '',
      createdAt:     Date.now(),
    });
  }
  return map;
}

/** Load a single agent's latest chips from DB (cross-instance consistency) */
export async function loadAgentChips(agentId: string): Promise<number | null> {
  const { data, error } = await supabase
    .from('casino_agents')
    .select('chips')
    .eq('id', agentId)
    .single();
  if (error || !data) return null;
  return data.chips;
}

/** Upsert agent — persists chips AND claim tracking.
 *  Returns a promise so callers on critical paths can await it. */
export async function saveAgent(agent: Agent): Promise<void> {
  const { error } = await supabase.from('casino_agents').upsert({
    id:              agent.id,
    name:            agent.name,
    chips:           agent.chips,
    claims_today:    agent.claimsToday,
    last_claim_at:   agent.lastClaimAt,
    last_claim_date: agent.lastClaimDate,
  }, { onConflict: 'id' });
  if (error) console.error('[casino-db] saveAgent:', error.message);
}

// ── Room Players (derived from casino_room_state.game_json) ─────────────────
// No separate casino_room_players table — player data lives in game_json.

// ── Games ────────────────────────────────────────────────────────────────────

export interface GameRecord {
  roomId:      string;
  roomName:    string;
  categoryId:  string;
  smallBlind:  number;
  bigBlind:    number;
  pot:         number;
  players:     Player[];
  winners:     WinnerInfo[];
  startedAt:   number;
}

/** Record a completed game hand and per-player results */
export async function recordGame(record: GameRecord): Promise<void> {
  const winner = record.winners[0];

  const { data, error } = await supabase.from('casino_games').insert({
    room_id:      record.roomId,
    room_name:    record.roomName,
    category_id:  record.categoryId,
    small_blind:  record.smallBlind,
    big_blind:    record.bigBlind,
    pot:          record.pot,
    player_count: record.players.length,
    winner_id:    winner?.agentId ?? null,
    winner_name:  winner?.name ?? null,
    winning_hand: winner?.hand?.rank ?? null,
    started_at:   new Date(record.startedAt).toISOString(),
    ended_at:     new Date().toISOString(),
  }).select('id').single();

  if (error) { console.error('[casino-db] recordGame:', error.message); return; }
  if (!data) return;

  const gameId = data.id;
  const playerRows = record.players.map(p => {
    const isWinner = record.winners.some(w => w.agentId === p.agentId);
    const winAmount = record.winners.find(w => w.agentId === p.agentId)?.amount ?? 0;
    return {
      game_id:    gameId,
      agent_id:   p.agentId,
      agent_name: p.name,
      buy_in:     0,
      chips_end:  p.chips,
      profit:     isWinner ? winAmount : -p.currentBet,
      is_winner:  isWinner,
    };
  });

  const { error: e } = await supabase.from('casino_game_players').insert(playerRows);
  if (e) console.error('[casino-db] recordGamePlayers:', e.message);

  // Bump games_played / games_won / total_won for each participant
  const ids = record.players.map(p => p.agentId);
  const winnerIds = new Set(record.winners.map(w => w.agentId));
  const winAmounts = new Map(record.winners.map(w => [w.agentId, w.amount ?? 0]));

  const { data: agentsData } = await supabase.from('casino_agents')
    .select('id, games_played, games_won, total_won')
    .in('id', ids);
  if (agentsData) {
    await Promise.all(agentsData.map(a => {
      const isWinner = winnerIds.has(a.id);
      return supabase.from('casino_agents').update({
        games_played: (a.games_played ?? 0) + 1,
        games_won:    (a.games_won   ?? 0) + (isWinner ? 1 : 0),
        total_won:    (a.total_won   ?? 0) + (isWinner ? (winAmounts.get(a.id) ?? 0) : 0),
      }).eq('id', a.id);
    }));
  }
}

// ── Chat (persisted to Supabase) ─────────────────────────────────────────────

const MAX_CHAT_PER_ROOM = 200;

/** Insert a chat message (fire-and-forget) */
export function saveChatMessage(roomId: string, agentId: string, agentName: string, message: string): void {
  supabase.from('casino_chat_messages').insert({
    room_id: roomId,
    agent_id: agentId,
    agent_name: agentName,
    message,
  }).then(({ error }) => {
    if (error) console.error('[casino-db] saveChatMessage:', error.message);
  });
}

/** Load recent chat messages for a room */
export async function loadChatMessages(roomId: string, limit = 50): Promise<{ agentId: string; name: string; message: string; timestamp: number }[]> {
  const { data, error } = await supabase
    .from('casino_chat_messages')
    .select('agent_id, agent_name, message, created_at')
    .eq('room_id', roomId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) { console.error('[casino-db] loadChatMessages:', error.message); return []; }

  return (data ?? []).reverse().map(row => ({
    agentId: row.agent_id,
    name: row.agent_name,
    message: row.message,
    timestamp: new Date(row.created_at).getTime(),
  }));
}

/** Trim old messages when a room exceeds the limit */
export async function trimChatMessages(roomId: string): Promise<void> {
  // Find the cutoff: keep only the most recent MAX_CHAT_PER_ROOM messages
  const { data } = await supabase
    .from('casino_chat_messages')
    .select('created_at')
    .eq('room_id', roomId)
    .order('created_at', { ascending: false })
    .range(MAX_CHAT_PER_ROOM, MAX_CHAT_PER_ROOM);

  if (!data || data.length === 0) return; // under limit

  const cutoff = data[0].created_at;
  const { error } = await supabase
    .from('casino_chat_messages')
    .delete()
    .eq('room_id', roomId)
    .lt('created_at', cutoff);

  if (error) console.error('[casino-db] trimChatMessages:', error.message);
}

// ── Leaderboard ──────────────────────────────────────────────────────────────

export async function getLeaderboard(limit = 50) {
  const [agentsResult, statesResult] = await Promise.all([
    supabase
      .from('casino_agents')
      .select('id, name, chips, games_played, games_won, total_won, vpip_hands, pfr_hands, aggressive_actions, passive_actions, showdown_hands, showdown_wins, cbet_opportunities, cbet_made')
      .order('chips', { ascending: false })
      .limit(limit * 2),
    supabase
      .from('casino_room_state')
      .select('game_json'),
  ]);

  if (agentsResult.error) { console.error('[casino-db] getLeaderboard:', agentsResult.error.message); return []; }

  // Build map of at-table chips from game_json players
  const tableChips = new Map<string, number>();
  for (const row of statesResult.data ?? []) {
    const players = (row.game_json as any)?.players ?? [];
    for (const p of players) {
      if (p.agentId && p.chips > 0) {
        tableChips.set(p.agentId, (tableChips.get(p.agentId) ?? 0) + p.chips);
      }
    }
  }

  return (agentsResult.data ?? [])
    .map(a => ({ ...a, chips: a.chips + (tableChips.get(a.id) ?? 0) }))
    .sort((a, b) => b.chips - a.chips)
    .slice(0, limit);
}

// ── Agent Stats (VPIP/PFR/AF etc.) ──────────────────────────────────────────

export interface AgentStatsRow {
  handsPlayed:        number;
  vpipHands:          number;
  pfrHands:           number;
  aggressiveActions:  number;
  passiveActions:     number;
  showdownHands:      number;
  showdownWins:       number;
  cbetOpportunities:  number;
  cbetMade:           number;
  bestWinStreak:      number;
  worstLossStreak:    number;
}

/** Persist poker stats for one agent. */
export async function saveAgentStats(agentId: string, s: AgentStatsRow): Promise<void> {
  const { error } = await supabase.from('casino_agents').update({
    games_played:       s.handsPlayed,
    vpip_hands:         s.vpipHands,
    pfr_hands:          s.pfrHands,
    aggressive_actions: s.aggressiveActions,
    passive_actions:    s.passiveActions,
    showdown_hands:     s.showdownHands,
    showdown_wins:      s.showdownWins,
    cbet_opportunities: s.cbetOpportunities,
    cbet_made:          s.cbetMade,
    best_win_streak:    s.bestWinStreak,
    worst_loss_streak:  s.worstLossStreak,
  }).eq('id', agentId);
  if (error) console.error('[casino-db] saveAgentStats:', error.message);
}

/** Load one agent's poker stats directly from DB (for cross-instance accurate reads). */
export async function loadAgentStats(agentId: string): Promise<AgentStatsRow | null> {
  const { data, error } = await supabase
    .from('casino_agents')
    .select('games_played, vpip_hands, pfr_hands, aggressive_actions, passive_actions, showdown_hands, showdown_wins, cbet_opportunities, cbet_made, best_win_streak, worst_loss_streak')
    .eq('id', agentId)
    .single();
  if (error || !data) return null;
  return {
    handsPlayed:       data.games_played       ?? 0,
    vpipHands:         data.vpip_hands         ?? 0,
    pfrHands:          data.pfr_hands          ?? 0,
    aggressiveActions: data.aggressive_actions ?? 0,
    passiveActions:    data.passive_actions    ?? 0,
    showdownHands:     data.showdown_hands     ?? 0,
    showdownWins:      data.showdown_wins      ?? 0,
    cbetOpportunities: data.cbet_opportunities ?? 0,
    cbetMade:          data.cbet_made          ?? 0,
    bestWinStreak:     data.best_win_streak    ?? 0,
    worstLossStreak:   data.worst_loss_streak  ?? 0,
  };
}

/** Load all agents' poker stats on cold-start. Returns map keyed by agent_id. */
export async function loadAllAgentStats(): Promise<Map<string, AgentStatsRow>> {
  const { data, error } = await supabase
    .from('casino_agents')
    .select('id, games_played, vpip_hands, pfr_hands, aggressive_actions, passive_actions, showdown_hands, showdown_wins, cbet_opportunities, cbet_made, best_win_streak, worst_loss_streak');
  if (error) { console.error('[casino-db] loadAllAgentStats:', error.message); return new Map(); }
  const map = new Map<string, AgentStatsRow>();
  for (const r of data ?? []) {
    map.set(r.id, {
      handsPlayed:       r.games_played       ?? 0,
      vpipHands:         r.vpip_hands         ?? 0,
      pfrHands:          r.pfr_hands          ?? 0,
      aggressiveActions: r.aggressive_actions ?? 0,
      passiveActions:    r.passive_actions    ?? 0,
      showdownHands:     r.showdown_hands     ?? 0,
      showdownWins:      r.showdown_wins      ?? 0,
      cbetOpportunities: r.cbet_opportunities ?? 0,
      cbetMade:          r.cbet_made          ?? 0,
      bestWinStreak:     r.best_win_streak    ?? 0,
      worstLossStreak:   r.worst_loss_streak  ?? 0,
    });
  }
  return map;
}

export async function getAgentHistory(agentId: string, limit = 20) {
  const { data, error } = await supabase
    .from('casino_game_players')
    .select(`
      id, is_winner, profit, chips_end, created_at,
      casino_games ( id, room_name, category_id, small_blind, big_blind, pot, winning_hand, ended_at )
    `)
    .eq('agent_id', agentId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) { console.error('[casino-db] getAgentHistory:', error.message); return []; }
  return (data ?? []).map(row => ({
    game_id:      (row.casino_games as any)?.id,
    room_name:    (row.casino_games as any)?.room_name,
    category_id:  (row.casino_games as any)?.category_id,
    big_blind:    (row.casino_games as any)?.big_blind,
    pot:          (row.casino_games as any)?.pot,
    winning_hand: (row.casino_games as any)?.winning_hand,
    is_winner:    row.is_winner,
    profit:       row.profit,
    chips_end:    row.chips_end,
    ended_at:     (row.casino_games as any)?.ended_at,
  }));
}

// ── Hand Cards (per-agent hole card isolation) ───────────────────────────────

/** Save one agent's hole cards for a hand (called at deal time). */
export async function saveHoleCards(handId: string, roomId: string, agentId: string, holeCards: Card[]): Promise<void> {
  const { error } = await supabase.from('casino_hand_cards').upsert({
    hand_id:    handId,
    room_id:    roomId,
    agent_id:   agentId,
    hole_cards: holeCards,
  }, { onConflict: 'hand_id,agent_id' });
  if (error) console.error('[casino-db] saveHoleCards:', error.message);
}

/** Save all players' hole cards in one batch. */
export async function saveAllHoleCards(handId: string, roomId: string, players: { agentId: string; holeCards: Card[] }[]): Promise<void> {
  const rows = players.map(p => ({
    hand_id:    handId,
    room_id:    roomId,
    agent_id:   p.agentId,
    hole_cards: p.holeCards,
  }));
  const { error } = await supabase.from('casino_hand_cards').upsert(rows, { onConflict: 'hand_id,agent_id' });
  if (error) console.error('[casino-db] saveAllHoleCards:', error.message);
}

/** Load one agent's hole cards for a hand. */
export async function loadHoleCards(handId: string, agentId: string): Promise<Card[] | null> {
  const { data, error } = await supabase
    .from('casino_hand_cards')
    .select('hole_cards')
    .eq('hand_id', handId)
    .eq('agent_id', agentId)
    .single();
  if (error || !data) return null;
  return data.hole_cards as Card[];
}

/** Load all agents' hole cards for a hand (spectator/showdown). */
export async function loadAllHoleCards(handId: string): Promise<Record<string, Card[]>> {
  const { data, error } = await supabase
    .from('casino_hand_cards')
    .select('agent_id, hole_cards')
    .eq('hand_id', handId);
  if (error || !data) return {};
  const result: Record<string, Card[]> = {};
  for (const row of data) {
    result[row.agent_id] = row.hole_cards as Card[];
  }
  return result;
}

/** Delete hole cards for a completed hand. */
export async function deleteHandCards(handId: string): Promise<void> {
  const { error } = await supabase
    .from('casino_hand_cards')
    .delete()
    .eq('hand_id', handId);
  if (error) console.error('[casino-db] deleteHandCards:', error.message);
}

// ── Room Game State ──────────────────────────────────────────────────────────

/** Persist the full GameState JSON after every action. */
export async function saveRoomState(roomId: string, game: unknown, stateVersion: number): Promise<void> {
  const { error } = await supabase.from('casino_room_state').upsert({
    room_id:       roomId,
    game_json:     game,
    state_version: stateVersion,
  }, { onConflict: 'room_id' });
  if (error) console.error('[casino-db] saveRoomState:', error.message);
}

/** Delete persisted state when a room becomes empty. */
export async function deleteRoomState(roomId: string): Promise<void> {
  const { error } = await supabase.from('casino_room_state')
    .delete().eq('room_id', roomId);
  if (error) console.error('[casino-db] deleteRoomState:', error.message);
}

/** Load one room's saved game state (for cross-instance recovery). */
export async function loadRoomState(
  roomId: string,
): Promise<{ game: unknown; stateVersion: number } | null> {
  const { data, error } = await supabase
    .from('casino_room_state')
    .select('game_json, state_version')
    .eq('room_id', roomId)
    .single();
  if (error || !data) return null;
  return { game: data.game_json, stateVersion: data.state_version ?? 0 };
}

/** Load ALL rooms' game states on cold-start hydration. */
export async function loadAllRoomStates(): Promise<
  Map<string, { game: unknown; stateVersion: number }>
> {
  const { data, error } = await supabase
    .from('casino_room_state')
    .select('room_id, game_json, state_version');
  if (error) { console.error('[casino-db] loadAllRoomStates:', error.message); return new Map(); }
  const map = new Map<string, { game: unknown; stateVersion: number }>();
  for (const row of data ?? []) {
    map.set(row.room_id, { game: row.game_json, stateVersion: row.state_version ?? 0 });
  }
  return map;
}

// ── Atomic Operations (DB-first architecture) ───────────────────────────────

/**
 * Optimistic-lock save: UPDATE only if state_version matches expectedVersion.
 * Returns { success: true, newVersion } or { success: false } on conflict.
 */
export async function saveRoomStateWithVersion(
  roomId: string,
  game: unknown,
  expectedVersion: number,
): Promise<{ success: boolean; newVersion: number }> {
  const newVersion = expectedVersion + 1;

  // Try UPDATE with version check (optimistic lock)
  const { data: updated, error: updateErr } = await supabase
    .from('casino_room_state')
    .update({
      game_json:     game,
      state_version: newVersion,
    })
    .eq('room_id', roomId)
    .eq('state_version', expectedVersion)
    .select('state_version');

  if (updateErr) {
    console.error('[casino-db] saveRoomStateWithVersion update:', updateErr.message);
    return { success: false, newVersion: expectedVersion };
  }

  if (updated && updated.length > 0) {
    return { success: true, newVersion };
  }

  // No row matched — either version conflict or row doesn't exist yet
  // Try inserting (for brand new rooms)
  if (expectedVersion === 0) {
    const { error: insertErr } = await supabase
      .from('casino_room_state')
      .insert({
        room_id:       roomId,
        game_json:     game,
        state_version: newVersion,
      });
    if (!insertErr) {
      return { success: true, newVersion };
    }
    // Insert failed (maybe race), check if version in DB is already ahead
    console.error('[casino-db] saveRoomStateWithVersion insert:', insertErr.message);
  }

  return { success: false, newVersion: expectedVersion };
}

/**
 * Atomic chip deduction: UPDATE chips = chips - amount WHERE chips >= amount.
 * Returns new chip balance, or null if insufficient funds.
 */
export async function deductChipsAtomic(agentId: string, amount: number): Promise<number | null> {
  // Use raw RPC-style: read, check, update in a "compare-and-swap" pattern.
  // Supabase doesn't support computed column updates directly, so we read-then-update atomically.
  const { data: agent, error: readErr } = await supabase
    .from('casino_agents')
    .select('chips')
    .eq('id', agentId)
    .single();
  if (readErr || !agent) return null;
  if (agent.chips < amount) return null;

  const newChips = agent.chips - amount;
  const { data: updated, error: updateErr } = await supabase
    .from('casino_agents')
    .update({ chips: newChips })
    .eq('id', agentId)
    .eq('chips', agent.chips) // optimistic lock on chips value
    .select('chips');

  if (updateErr || !updated || updated.length === 0) return null;
  return updated[0].chips;
}

/**
 * Atomic chip addition: UPDATE chips = chips + amount via SQL function.
 * Uses a single UPDATE statement — no read-then-write race.
 */
export async function addChipsAtomic(agentId: string, amount: number): Promise<number | null> {
  const { data, error } = await supabase.rpc('add_chips', {
    p_agent_id: agentId,
    p_amount: amount,
  });
  if (error) {
    console.error('[casino-db] addChipsAtomic rpc error:', error.message);
    return null;
  }
  return data;
}

/** Load full agent record from DB */
export async function loadAgent(agentId: string): Promise<Agent | null> {
  const { data, error } = await supabase
    .from('casino_agents')
    .select('id, name, chips, claims_today, last_claim_at, last_claim_date')
    .eq('id', agentId)
    .single();
  if (error || !data) return null;
  return {
    id:            data.id,
    name:          data.name,
    chips:         data.chips,
    claimsToday:   data.claims_today    ?? 0,
    lastClaimAt:   data.last_claim_at   ?? 0,
    lastClaimDate: data.last_claim_date ?? '',
    createdAt:     Date.now(),
  };
}

/** Load all agents from DB (for leaderboard/listing) */
export async function loadAllAgents(): Promise<Agent[]> {
  const { data, error } = await supabase
    .from('casino_agents')
    .select('id, name, chips, claims_today, last_claim_at, last_claim_date');
  if (error) { console.error('[casino-db] loadAllAgents:', error.message); return []; }
  return (data ?? []).map(row => ({
    id:            row.id,
    name:          row.name,
    chips:         row.chips,
    claimsToday:   row.claims_today    ?? 0,
    lastClaimAt:   row.last_claim_at   ?? 0,
    lastClaimDate: row.last_claim_date ?? '',
    createdAt:     Date.now(),
  }));
}
