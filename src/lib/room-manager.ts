import { v4 as uuid } from 'uuid';
import { Room, RoomInfo, StakeCategory, ClientGameState, ClientPlayer } from './types';
import { createGame, addPlayer, removePlayer, canStartGame, startNewHand, processAction, getValidActions } from './poker-engine';
import { getOrCreateAgent, deductChips, addChips, getAgent } from './chips';

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
  low: 5,
  mid: 3,
  high: 3,
};

// ─── Room store (global singleton) ───────────────────────────────────────────

interface ExtendedRoom extends Room {
  categoryId: string;
  tableNumber: number;
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

// ─── Init ─────────────────────────────────────────────────────────────────────

function createFixedTable(categoryId: string, tableNumber: number): ExtendedRoom {
  const cat = STAKE_CATEGORIES.find(c => c.id === categoryId)!;
  const room: ExtendedRoom = {
    id: uuid(),
    name: `Table ${tableNumber}`,
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
  };
  rooms.set(room.id, room);
  return room;
}

export function initDefaultRooms(): void {
  for (const cat of STAKE_CATEGORIES) {
    const existing = Array.from(rooms.values()).filter(r => r.categoryId === cat.id);
    const count = TABLES_PER_CATEGORY[cat.id] ?? 3;
    for (let i = existing.length + 1; i <= count; i++) {
      createFixedTable(cat.id, i);
    }
  }
}

// ─── Lookup ───────────────────────────────────────────────────────────────────

export function getRoom(id: string): ExtendedRoom | undefined {
  return rooms.get(id);
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

export function listCategories(): (Omit<StakeCategory, 'tables'> & { tables: RoomInfo[] })[] {
  return STAKE_CATEGORIES.map(cat => ({
    ...cat,
    tables: Array.from(rooms.values())
      .filter(r => r.categoryId === cat.id)
      .sort((a, b) => a.tableNumber - b.tableNumber)
      .map(toRoomInfo),
  }));
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

  // Cancel any pending timeout if there aren't enough players left
  if (!room.game || room.game.players.length < 2) {
    clearActionTimeout(roomId);
  }
}

// ─── Action timeout ───────────────────────────────────────────────────────────

export function clearActionTimeout(roomId: string): void {
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

  const timeout = setTimeout(() => {
    actionTimeouts.delete(roomId);
    console.log(`[auto-fold] ${currentPlayer.name} timed out in room ${roomId}`);
    handleAction(roomId, currentPlayer.agentId, 'fold');
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
  }, 30_000);

  actionTimeouts.set(roomId, timeout);
}

// ─── Game actions ─────────────────────────────────────────────────────────────

export function handleAction(roomId: string, agentId: string, action: string, amount?: number): string | null {
  const room = rooms.get(roomId);
  if (!room || !room.game) return 'No active game';

  const validActions = ['fold', 'check', 'call', 'raise', 'all_in'];
  if (!validActions.includes(action)) return 'Invalid action';

  const success = processAction(room.game, agentId, action as any, amount);
  if (!success) return 'Invalid action for current game state';

  return null;
}

export function tryStartGame(roomId: string): boolean {
  const room = rooms.get(roomId);
  if (!room || !room.game) return false;

  if (canStartGame(room.game)) {
    startNewHand(room.game, roomId, room.name);
    return true;
  }
  return false;
}

export function tryStartNextHand(roomId: string): boolean {
  const room = rooms.get(roomId);
  if (!room || !room.game) return false;

  if (room.game.phase !== 'showdown') return false;
  if (room.game.players.length < 2) return false;

  const bustedPlayers = room.game.players.filter(p => p.chips === 0);
  for (const p of bustedPlayers) {
    removePlayer(room.game, p.agentId);
  }

  if (room.game.players.length < 2) return false;

  startNewHand(room.game);
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
  };
}

export function getValidActionsForRoom(roomId: string): ReturnType<typeof getValidActions> {
  const room = rooms.get(roomId);
  if (!room || !room.game) return [];
  return getValidActions(room.game);
}
