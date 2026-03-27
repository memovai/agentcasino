import { Room, RoomInfo, StakeCategory, ClientGameState, ClientPlayer } from './types';
import { createGame, addPlayer, removePlayer, canStartGame, startNewHand, processAction, getValidActions } from './poker-engine';
import { getOrCreateAgent, deductChips, addChips, getAgent } from './chips';
import { loadRoomPlayers, saveRoomPlayer, removeRoomPlayer, STALE_MS, cleanStaleRoomPlayers } from './casino-db';

// ─── Stake categories (fixed) ────────────────────────────────────────────────

export const STAKE_CATEGORIES: Omit<StakeCategory, 'tables'>[] = [
  {
    id: 'low',
    name: 'Low Stakes',
    description: 'Blinds 500/1,000 · Buy-in 20k–100k',
    smallBlind: 500,
    bigBlind: 1_000,
    minBuyIn: 20_000,
    maxBuyIn: 100_000,
    maxPlayers: 9,
  },
  {
    id: 'mid',
    name: 'Mid Stakes',
    description: 'Blinds 2,500/5,000 · Buy-in 100k–500k',
    smallBlind: 2_500,
    bigBlind: 5_000,
    minBuyIn: 100_000,
    maxBuyIn: 500_000,
    maxPlayers: 6,
  },
  {
    id: 'high',
    name: 'High Roller',
    description: 'Blinds 10,000/20,000 · Buy-in 400k–2M',
    smallBlind: 10_000,
    bigBlind: 20_000,
    minBuyIn: 400_000,
    maxBuyIn: 2_000_000,
    maxPlayers: 6,
  },
];

// ─── Fixed table counts per category ─────────────────────────────────────────

const TABLES_PER_CATEGORY: Record<string, number> = {
  low:  6,
  mid:  4,
  high: 3,
};

// ─── Fun deterministic table names ───────────────────────────────────────────

const TABLE_NAMES: Record<string, string[]> = {
  low: [
    '🃏 Dead Man\'s Hand',
    '🌙 Midnight Felt',
    '🎲 Ante Up Alley',
    '🐍 Snake Eyes',
    '🍀 Lucky River',
    '🌊 The Flop House',
  ],
  mid: [
    '🦁 The Lion\'s Den',
    '🔥 Blaze & Raise',
    '⚡ Thunder Pot',
    '🎯 Sharpshooter\'s Table',
  ],
  high: [
    '💀 The Graveyard Shift',
    '👑 High Roller Throne',
    '🌑 Dark Money Room',
  ],
};

// ─── Room store (global singleton) ───────────────────────────────────────────

interface ExtendedRoom extends Room {
  categoryId: string;
  tableNumber: number;
  stateVersion: number;
  turnDeadlineMs: number | null;
}

const globalAny = globalThis as any;
if (!globalAny.__casino_rooms) {
  globalAny.__casino_rooms = new Map<string, ExtendedRoom>();
}
const rooms: Map<string, ExtendedRoom> = globalAny.__casino_rooms;

// ─── Action timeout store (global singleton, survives hot reloads) ────────────

const globalAny2 = globalThis as any;
if (!globalAny2.__casino_timeouts) {
  globalAny2.__casino_timeouts = new Map<string, NodeJS.Timeout>();
}
const actionTimeouts: Map<string, NodeJS.Timeout> = globalAny2.__casino_timeouts;

// ─── Consecutive timeout tracking ─────────────────────────────────────────────

if (!globalAny2.__casino_consec_timeouts) {
  globalAny2.__casino_consec_timeouts = new Map<string, number>();
}
const consecutiveTimeouts: Map<string, number> = globalAny2.__casino_consec_timeouts;

// ─── Turn timer constant ───────────────────────────────────────────────────────

const TURN_TIMEOUT_MS = 30_000;

// ─── Init ─────────────────────────────────────────────────────────────────────

/** Deterministic room ID — stable across cold starts */
function roomId(categoryId: string, tableNumber: number): string {
  return `casino_${categoryId}_${tableNumber}`;
}

function createFixedTable(categoryId: string, tableNumber: number): ExtendedRoom {
  const cat = STAKE_CATEGORIES.find(c => c.id === categoryId)!;
  const names = TABLE_NAMES[categoryId] ?? [];
  const name = names[tableNumber - 1] ?? `Table ${tableNumber}`;
  const room: ExtendedRoom = {
    id: roomId(categoryId, tableNumber),
    name,
    categoryId,
    tableNumber,
    smallBlind: cat.smallBlind,
    bigBlind: cat.bigBlind,
    minBuyIn: cat.minBuyIn,
    maxBuyIn: cat.maxBuyIn,
    maxPlayers: cat.maxPlayers,
    game: null,
    spectators: [],
    createdAt: Date.now(),
    stateVersion: 0,
    turnDeadlineMs: null,
  };
  rooms.set(room.id, room);
  return room;
}

/** Re-seat a player from DB without deducting chips (cold-start recovery only) */
function rehydratePlayer(room: ExtendedRoom, agentId: string, agentName: string, chips: number): void {
  if (!room.game) room.game = createGame(room.smallBlind, room.bigBlind);
  if (room.game.players.find(p => p.agentId === agentId)) return; // already seated
  if (room.game.players.length >= room.maxPlayers) return;
  const taken = new Set(room.game.players.map(p => p.seatIndex));
  let seat = -1;
  for (let i = 0; i < room.maxPlayers; i++) { if (!taken.has(i)) { seat = i; break; } }
  if (seat === -1) return;
  // Ensure agent exists in memory
  getOrCreateAgent(agentId, agentName);
  addPlayer(room.game, agentId, agentName, chips, seat);
}

export function initDefaultRooms(): void {
  for (const cat of STAKE_CATEGORIES) {
    const existing = Array.from(rooms.values()).filter(r => r.categoryId === cat.id);
    const count = TABLES_PER_CATEGORY[cat.id] ?? 3;
    for (let i = existing.length + 1; i <= count; i++) {
      createFixedTable(cat.id, i);
    }
  }
  // Async: restore seated players from Supabase after a cold start
  hydrateFromDB();
}

async function hydrateFromDB(): Promise<void> {
  for (const room of rooms.values()) {
    try {
      const players = await loadRoomPlayers(room.id);
      const now = Date.now();
      // Discard records not updated in the last 2h — prevents ghost players on cold start
      const fresh = players.filter(p => p.chips > 0 && (now - p.updatedAt) < STALE_MS);
      const stale = players.filter(p => p.chips <= 0 || (now - p.updatedAt) >= STALE_MS);
      for (const p of fresh) {
        rehydratePlayer(room, p.agentId, p.agentName, p.chips);
      }
      for (const p of stale) {
        removeRoomPlayer(room.id, p.agentId);
      }
      if (fresh.length > 0) {
        console.log(`[rooms] Restored ${fresh.length} player(s) to ${room.id}`);
      }
    } catch (e) {
      console.error(`[rooms] hydrateFromDB failed for ${room.id}:`, e);
    }
  }
}

// ─── Lookup ───────────────────────────────────────────────────────────────────

export function getRoom(id: string): ExtendedRoom | undefined {
  return rooms.get(id);
}

/** Returns the roomId of the first room where agentId is seated, or null */
export function getAgentRoom(agentId: string): string | null {
  for (const [id, room] of rooms) {
    if (room.game?.players.some(p => p.agentId === agentId)) return id;
  }
  return null;
}

// ─── State version helpers ─────────────────────────────────────────────────────

export function bumpVersion(roomId: string): void {
  const room = rooms.get(roomId);
  if (room) room.stateVersion = (room.stateVersion ?? 0) + 1;
}

export function getRoomStateVersion(roomId: string): number {
  return rooms.get(roomId)?.stateVersion ?? 0;
}

/** Long-poll: wait up to maxWaitMs for stateVersion to exceed sinceVersion. */
export async function waitForStateChange(
  roomId: string,
  sinceVersion: number,
  maxWaitMs = 8_000,
): Promise<number> {
  const interval = 300;
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const current = getRoomStateVersion(roomId);
    if (current > sinceVersion) return current;
    await new Promise<void>(r => setTimeout(r, interval));
  }
  return getRoomStateVersion(roomId);
}

// ─── Listing ──────────────────────────────────────────────────────────────────

function toRoomInfo(r: ExtendedRoom): RoomInfo {
  return {
    id: r.id,
    name: r.name,
    playerCount: r.game?.players.length ?? 0,
    maxPlayers: r.maxPlayers,
    smallBlind: r.smallBlind,
    bigBlind: r.bigBlind,
    minBuyIn: r.minBuyIn,
    maxBuyIn: r.maxBuyIn,
    categoryId: r.categoryId,
    tableNumber: r.tableNumber,
    createdAt: r.createdAt,
  };
}

export function listRooms(): RoomInfo[] {
  return Array.from(rooms.values()).map(toRoomInfo);
}

/**
 * Recommended rooms for browser users:
 * - All rooms that have at least 1 player seated
 * - Plus 1 empty "open" table per category (the lowest-numbered empty one)
 */
export function listRecommendedRooms(): RoomInfo[] {
  const all = Array.from(rooms.values()).map(toRoomInfo);
  const active = all.filter(r => r.playerCount > 0);
  const activeIds = new Set(active.map(r => r.id));

  // Add 1 empty table per category as an "open seat" option
  const catsSeen = new Set<string>();
  const openSeats: RoomInfo[] = [];
  for (const cat of STAKE_CATEGORIES) {
    const empty = all
      .filter(r => r.categoryId === cat.id && !activeIds.has(r.id))
      .sort((a, b) => (a.tableNumber ?? 0) - (b.tableNumber ?? 0));
    if (empty.length > 0 && !catsSeen.has(cat.id)) {
      openSeats.push(empty[0]);
      catsSeen.add(cat.id);
    }
  }

  return [...active, ...openSeats].sort((a, b) => b.playerCount - a.playerCount);
}

export function listCategories(recommended = false): (Omit<StakeCategory, 'tables'> & { tables: RoomInfo[] })[] {
  return STAKE_CATEGORIES.map(cat => {
    let tables = Array.from(rooms.values())
      .filter(r => r.categoryId === cat.id)
      .sort((a, b) => a.tableNumber - b.tableNumber)
      .map(toRoomInfo);

    if (recommended) {
      // Active tables + 1 empty seat per category
      const active = tables.filter(t => t.playerCount > 0);
      const firstEmpty = tables.find(t => t.playerCount === 0);
      tables = active.length > 0
        ? (firstEmpty ? [...active, firstEmpty] : active)
        : (firstEmpty ? [firstEmpty] : []);
    }

    return { ...cat, tables };
  });
}

/** Remove in-memory players who are no longer in Supabase (used by cron after DB cleanup) */
export async function evictGhostPlayers(): Promise<number> {
  let evicted = 0;
  for (const room of rooms.values()) {
    if (!room.game || room.game.players.length === 0) continue;
    const dbPlayers = await loadRoomPlayers(room.id);
    const dbIds = new Set(dbPlayers.map(p => p.agentId));
    for (const p of [...room.game.players]) {
      if (!dbIds.has(p.agentId)) {
        removePlayer(room.game, p.agentId);
        evicted++;
        console.log(`[rooms] evicted ghost player ${p.agentId} from ${room.id}`);
      }
    }
    if (room.game.players.length === 0) room.game = null;
  }
  return evicted;
}

// ─── Join / Leave ─────────────────────────────────────────────────────────────

export function joinRoom(roomId: string, agentId: string, agentName: string, buyIn: number): string | null {
  const room = rooms.get(roomId);
  if (!room) return 'Room not found';

  if (buyIn < room.minBuyIn || buyIn > room.maxBuyIn) {
    return `Buy-in must be between ${room.minBuyIn.toLocaleString()} and ${room.maxBuyIn.toLocaleString()}`;
  }

  const agent = getOrCreateAgent(agentId, agentName);
  if (agent.chips < buyIn) {
    return `Not enough chips. You have ${agent.chips.toLocaleString()}, need ${buyIn.toLocaleString()}`;
  }

  if (!room.game) {
    room.game = createGame(room.smallBlind, room.bigBlind);
  }

  if (room.game.players.length >= room.maxPlayers) {
    return 'Room is full';
  }

  if (room.game.players.find(p => p.agentId === agentId)) {
    return 'Already at this table';
  }

  const takenSeats = new Set(room.game.players.map(p => p.seatIndex));
  let seatIndex = -1;
  for (let i = 0; i < room.maxPlayers; i++) {
    if (!takenSeats.has(i)) { seatIndex = i; break; }
  }
  if (seatIndex === -1) return 'No seats available';

  if (!deductChips(agentId, buyIn)) return 'Failed to deduct chips';

  if (!addPlayer(room.game, agentId, agentName, buyIn, seatIndex)) {
    addChips(agentId, buyIn);
    return 'Failed to join table';
  }

  saveRoomPlayer(roomId, agentId, agentName, buyIn);
  bumpVersion(roomId);
  return null;
}

export function leaveRoom(roomId: string, agentId: string): void {
  const room = rooms.get(roomId);
  if (!room || !room.game) return;

  const player = removePlayer(room.game, agentId);
  if (player) {
    addChips(agentId, player.chips);
  }

  room.spectators = room.spectators.filter(id => id !== agentId);
  removeRoomPlayer(roomId, agentId);

  // Cancel any pending timeout if there aren't enough players left
  if (!room.game || room.game.players.length < 2) {
    clearActionTimeout(roomId);
  }

  bumpVersion(roomId);
}

// ─── Action timeout ───────────────────────────────────────────────────────────

export function clearActionTimeout(roomId: string): void {
  const room = rooms.get(roomId);
  if (room) room.turnDeadlineMs = null;
  const existing = actionTimeouts.get(roomId);
  if (existing !== undefined) {
    clearTimeout(existing);
    actionTimeouts.delete(roomId);
  }
}

export function scheduleActionTimeout(roomId: string): void {
  const room = rooms.get(roomId);
  if (!room || !room.game) {
    clearActionTimeout(roomId);
    return;
  }

  const game = room.game;

  if (game.phase === 'waiting' || game.phase === 'showdown') {
    clearActionTimeout(roomId);
    return;
  }

  const currentPlayer = game.players[game.currentPlayerIndex];
  if (!currentPlayer) {
    clearActionTimeout(roomId);
    return;
  }

  // Clear any existing timeout before setting a new one
  clearActionTimeout(roomId);

  // Expose deadline so agents can count down
  room.turnDeadlineMs = Date.now() + TURN_TIMEOUT_MS;
  bumpVersion(roomId);

  const timeout = setTimeout(() => {
    actionTimeouts.delete(roomId);
    if (room) room.turnDeadlineMs = null;

    const key = `${roomId}:${currentPlayer.agentId}`;
    const count = (consecutiveTimeouts.get(key) ?? 0) + 1;
    consecutiveTimeouts.set(key, count);

    if (count >= 3) {
      // Kick after 3 consecutive timeouts
      consecutiveTimeouts.delete(key);
      console.log(`[kick] ${currentPlayer.name} kicked from ${roomId} after ${count} consecutive timeouts`);
      leaveRoom(roomId, currentPlayer.agentId);
    } else {
      console.log(`[auto-fold] ${currentPlayer.name} timed out in ${roomId} (${count}/3)`);
      handleAction(roomId, currentPlayer.agentId, 'fold', undefined, true);
    }

    // Attempt to broadcast updated state via socket server if available
    try {
      const socketServer = require('./socket-server');
      if (typeof socketServer.broadcastRoomState === 'function') {
        socketServer.broadcastRoomState(roomId);
      }
    } catch {
      // socket-server not available, skip broadcast
    }
    // Schedule the next player's timeout
    scheduleActionTimeout(roomId);
  }, TURN_TIMEOUT_MS);

  actionTimeouts.set(roomId, timeout);
}

// ─── Game actions ─────────────────────────────────────────────────────────────

export function handleAction(
  roomId: string,
  agentId: string,
  action: string,
  amount?: number,
  isTimeout = false,
): string | null {
  const room = rooms.get(roomId);
  if (!room || !room.game) return 'No active game';

  const validActions = ['fold', 'check', 'call', 'raise', 'all_in'];
  if (!validActions.includes(action)) return 'Invalid action';

  const success = processAction(room.game, agentId, action as any, amount);
  if (!success) return 'Invalid action for current game state';

  // Real action resets consecutive timeout count
  if (!isTimeout) {
    consecutiveTimeouts.delete(`${roomId}:${agentId}`);
  }

  bumpVersion(roomId);
  return null;
}

export function tryStartGame(roomId: string): boolean {
  const room = rooms.get(roomId);
  if (!room || !room.game) return false;

  if (canStartGame(room.game)) {
    startNewHand(room.game, roomId, room.name);
    bumpVersion(roomId);
    return true;
  }
  return false;
}

export function tryStartNextHand(roomId: string): boolean {
  const room = rooms.get(roomId);
  if (!room || !room.game) return false;

  if (room.game.phase !== 'showdown') return false;
  if (room.game.players.length < 2) return false;

  // Persist chip counts after each completed hand (cold-start recovery)
  for (const p of room.game.players) {
    if (p.chips > 0) saveRoomPlayer(roomId, p.agentId, p.name, p.chips);
  }

  const bustedPlayers = room.game.players.filter(p => p.chips === 0);
  for (const p of bustedPlayers) {
    removePlayer(room.game, p.agentId);
    removeRoomPlayer(roomId, p.agentId);
  }

  if (room.game.players.length < 2) return false;

  startNewHand(room.game);
  bumpVersion(roomId);
  return true;
}

// ─── Client state ─────────────────────────────────────────────────────────────

export function getClientGameState(roomId: string, viewerAgentId: string): ClientGameState | null {
  const room = rooms.get(roomId);
  if (!room || !room.game) return null;

  const game = room.game;
  const isShowdown = game.phase === 'showdown';

  const players: ClientPlayer[] = game.players.map(p => ({
    agentId: p.agentId,
    name: p.name,
    seatIndex: p.seatIndex,
    chips: p.chips,
    holeCards: (p.agentId === viewerAgentId || isShowdown) ? p.holeCards : null,
    currentBet: p.currentBet,
    hasFolded: p.hasFolded,
    hasActed: p.hasActed,
    isAllIn: p.isAllIn,
    isConnected: p.isConnected,
  }));

  const now = Date.now();
  const deadline = room.turnDeadlineMs ?? null;
  const turnTimeRemaining = deadline !== null ? Math.max(0, Math.round((deadline - now) / 1000)) : null;

  return {
    id: game.id,
    phase: game.phase,
    players,
    communityCards: game.communityCards,
    pot: game.pot,
    sidePots: game.sidePots,
    currentPlayerIndex: game.currentPlayerIndex,
    dealerIndex: game.dealerIndex,
    smallBlind: game.smallBlind,
    bigBlind: game.bigBlind,
    minRaise: game.minRaise,
    winners: game.winners,
    lastAction: game.lastAction,
    stateVersion: room.stateVersion ?? 0,
    turnDeadline: deadline,
    turnTimeRemaining,
  };
}

export function getValidActionsForRoom(roomId: string): ReturnType<typeof getValidActions> {
  const room = rooms.get(roomId);
  if (!room || !room.game) return [];
  return getValidActions(room.game);
}

/** Heartbeat — refresh updated_at in Supabase so the player isn't treated as stale */
export function heartbeatPlayer(roomId: string, agentId: string): boolean {
  const room = rooms.get(roomId);
  if (!room?.game) return false;
  const player = room.game.players.find(p => p.agentId === agentId);
  if (!player) return false;
  saveRoomPlayer(roomId, agentId, player.name, player.chips);
  return true;
}
