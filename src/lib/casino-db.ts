/**
 * casino-db.ts — Supabase persistence layer for Agent Casino
 *
 * All writes are fire-and-forget (non-blocking) so DB latency never affects gameplay.
 */

import { supabase } from './supabase';
import { Agent, WinnerInfo, Player } from './types';

// ── Agents ──────────────────────────────────────────────────────────────────

/** Load all agent chip balances from DB on server startup */
export async function loadAgents(): Promise<Map<string, Agent>> {
  const { data, error } = await supabase
    .from('casino_agents')
    .select('id, name, chips');

  if (error) { console.error('[casino-db] loadAgents:', error.message); return new Map(); }

  const map = new Map<string, Agent>();
  for (const row of data ?? []) {
    map.set(row.id, {
      id: row.id,
      name: row.name,
      chips: row.chips,
      claimsToday:    0,
      lastClaimAt:    0,
      lastClaimDate:  '',
      createdAt:      Date.now(),
    });
  }
  return map;
}

/** Upsert agent after any chip change */
export function saveAgent(agent: Agent): void {
  supabase.from('casino_agents').upsert({
    id:    agent.id,
    name:  agent.name,
    chips: agent.chips,
  }, { onConflict: 'id' }).then(({ error }) => {
    if (error) console.error('[casino-db] saveAgent:', error.message);
  });
}

/** Increment wins + total_won when an agent wins a hand */
export function recordAgentWin(agentId: string, amount: number): void {
  supabase.rpc('casino_record_win', { p_agent_id: agentId, p_amount: amount })
    .then(({ error }) => {
      if (error) {
        // Fallback: manual increment
        supabase.from('casino_agents')
          .update({ games_won: supabase.rpc as any })
          .eq('id', agentId);
      }
    });
}

// ── Room Players ─────────────────────────────────────────────────────────────

export interface RoomPlayerRecord {
  agentId:   string;
  agentName: string;
  chips:     number;
  updatedAt: number; // ms since epoch
}

const STALE_MS = 20 * 60 * 1000; // 20 minutes — players idle longer than this are treated as disconnected

/** Load all seated players for a room (used on cold-start hydration) */
export async function loadRoomPlayers(roomId: string): Promise<RoomPlayerRecord[]> {
  const { data, error } = await supabase
    .from('casino_room_players')
    .select('agent_id, agent_name, chips_at_table, updated_at')
    .eq('room_id', roomId);
  if (error) { console.error('[casino-db] loadRoomPlayers:', error.message); return []; }
  return (data ?? []).map(row => ({
    agentId:   row.agent_id,
    agentName: row.agent_name,
    chips:     row.chips_at_table,
    updatedAt: new Date(row.updated_at).getTime(),
  }));
}

export { STALE_MS };

/** Load ALL room players across all rooms (for cold-start table discovery) */
export async function loadAllRoomPlayers(): Promise<(RoomPlayerRecord & { roomId: string })[]> {
  const { data, error } = await supabase
    .from('casino_room_players')
    .select('room_id, agent_id, agent_name, chips_at_table, updated_at');
  if (error) { console.error('[casino-db] loadAllRoomPlayers:', error.message); return []; }
  return (data ?? []).map(row => ({
    roomId:    row.room_id,
    agentId:   row.agent_id,
    agentName: row.agent_name,
    chips:     row.chips_at_table,
    updatedAt: new Date(row.updated_at).getTime(),
  }));
}

/** Upsert a player's seat + chip count (call on join and after each hand) */
export function saveRoomPlayer(roomId: string, agentId: string, agentName: string, chips: number): void {
  supabase.from('casino_room_players').upsert({
    room_id:        roomId,
    agent_id:       agentId,
    agent_name:     agentName,
    chips_at_table: chips,
  }, { onConflict: 'room_id,agent_id' }).then(({ error }) => {
    if (error) console.error('[casino-db] saveRoomPlayer:', error.message);
  });
}

/** Delete all casino_room_players rows not updated within STALE_MS. Returns removed count. */
export async function cleanStaleRoomPlayers(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_MS).toISOString();
  const { data, error } = await supabase
    .from('casino_room_players')
    .delete()
    .lt('updated_at', cutoff)
    .select('agent_id');
  if (error) { console.error('[casino-db] cleanStaleRoomPlayers:', error.message); return 0; }
  return data?.length ?? 0;
}

/** Remove a player from the persistent seat list (call on leave) */
export function removeRoomPlayer(roomId: string, agentId: string): void {
  supabase.from('casino_room_players')
    .delete()
    .eq('room_id', roomId)
    .eq('agent_id', agentId)
    .then(({ error }) => {
      if (error) console.error('[casino-db] removeRoomPlayer:', error.message);
    });
}

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
export function recordGame(record: GameRecord): void {
  const winner = record.winners[0];

  supabase.from('casino_games').insert({
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
  }).select('id').single().then(({ data, error }) => {
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
        buy_in:     0,  // buy-in tracking not in current model
        chips_end:  p.chips,
        profit:     isWinner ? winAmount : -p.currentBet,
        is_winner:  isWinner,
      };
    });

    supabase.from('casino_game_players').insert(playerRows).then(({ error: e }) => {
      if (e) console.error('[casino-db] recordGamePlayers:', e.message);
    });

    // Bump games_played for each participant
    const ids = record.players.map(p => p.agentId);
    supabase.from('casino_agents')
      .select('id, games_played')
      .in('id', ids)
      .then(({ data: agents }) => {
        if (!agents) return;
        for (const a of agents) {
          supabase.from('casino_agents')
            .update({ games_played: a.games_played + 1 })
            .eq('id', a.id)
            .then(() => {});
        }
      });
  });
}

// ── Chat ─────────────────────────────────────────────────────────────────────

export function saveMessage(roomId: string, agentId: string, name: string, message: string): void {
  supabase.from('casino_chat_messages').insert({
    room_id:    roomId,
    agent_id:   agentId,
    agent_name: name,
    message,
  }).then(({ error }) => {
    if (error) console.error('[casino-db] saveMessage:', error.message);
  });
}

export async function getRecentMessages(roomId: string, limit = 50): Promise<{
  agentId: string; name: string; message: string; timestamp: number;
}[]> {
  const { data, error } = await supabase
    .from('casino_chat_messages')
    .select('agent_id, agent_name, message, created_at')
    .eq('room_id', roomId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) { console.error('[casino-db] getRecentMessages:', error.message); return []; }
  return (data ?? []).reverse().map(row => ({
    agentId:   row.agent_id,
    name:      row.agent_name,
    message:   row.message,
    timestamp: new Date(row.created_at).getTime(),
  }));
}

// ── Leaderboard ──────────────────────────────────────────────────────────────

export async function getLeaderboard(limit = 20) {
  const { data, error } = await supabase
    .from('casino_agents')
    .select('id, name, chips, games_played, games_won, total_won')
    .order('chips', { ascending: false })
    .limit(limit);

  if (error) { console.error('[casino-db] getLeaderboard:', error.message); return []; }
  return data ?? [];
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
