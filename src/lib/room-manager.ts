import { Room, RoomInfo, StakeCategory, ClientGameState, ClientPlayer, GameState } from './types';
import { createGame, addPlayer, removePlayer, safeMidHandRemove, canStartGame, startNewHand, processAction, getValidActions } from './poker-engine';
import { deductChips, addChips, getAgent } from './chips';
import {
  saveRoomState, deleteRoomState,
  loadRoomState, loadAllRoomStates, saveRoomStateWithVersion, deductChipsAtomic, addChipsAtomic,
  saveAllHoleCards, loadHoleCards, loadAllHoleCards, deleteHandCards,
  saveChatMessage, loadChatMessages, trimChatMessages,
} from './casino-db';
import { calculateEquity } from './equity';
import { supabase } from './supabase';

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
    description: 'Blinds 10,000/20,000 · Buy-in 200k–1M',
    smallBlind: 10_000,
    bigBlind: 20_000,
    minBuyIn: 200_000,
    maxBuyIn: 1_000_000,
    maxPlayers: 6,
  },
];

// ─── Fixed table counts per category ─────────────────────────────────────────

const MIN_TABLES: Record<string, number> = {
  low:  2,
  mid:  2,
  high: 2,
};

const SCALE_UP_THRESHOLD = 0.7;

// ─── Fun deterministic table names ───────────────────────────────────────────

const TABLE_NAMES: Record<string, string[]> = {
  low: [
    '\u{1F0CF} Dead Man\'s Hand',
    '\u{1F319} Midnight Felt',
    '\u{1F3B2} Ante Up Alley',
    '\u{1F40D} Snake Eyes',
    '\u{1F340} Lucky River',
    '\u{1F30A} The Flop House',
  ],
  mid: [
    '\u{1F981} The Lion\'s Den',
    '\u{1F525} Blaze & Raise',
    '\u26A1 Thunder Pot',
    '\u{1F3AF} Sharpshooter\'s Table',
  ],
  high: [
    '\u{1F480} The Graveyard Shift',
    '\u{1F451} High Roller Throne',
    '\u{1F311} Dark Money Room',
  ],
};

// ─── Types ───────────────────────────────────────────────────────────────────

interface ChatMsg {
  agentId: string;
  name: string;
  message: string;
  timestamp: number;
}

interface ExtendedRoom extends Room {
  categoryId: string;
  tableNumber: number;
  stateVersion: number;
  turnDeadlineMs: number | null;
  chatLog?: ChatMsg[];
}

// ─── Turn timer constant ───────────────────────────────────────────────────────

const TURN_TIMEOUT_MS = 60_000;

// ─── Stale player eviction ──────────────────────────────────────────────────
const STALE_PLAYER_MS = 5 * 60 * 1000; // 5 minutes without interaction → ghost

// ─── Lone player timeout (waiting alone too long → kick) ─────────────────────
const LONE_PLAYER_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes alone → return chips and remove

// ─── Showdown delay (ms before next hand starts) ────────────────────────────
const SHOWDOWN_DELAY_MS = 3_000;

// ─── Chat (persisted to Supabase) ────────────────────────────────────────────

// Counter to trigger periodic trim (every ~50 messages per room)
const globalAny = globalThis as any;
if (!globalAny.__casino_chat_count) globalAny.__casino_chat_count = new Map<string, number>();
const chatCounters: Map<string, number> = globalAny.__casino_chat_count;

export function addChatMessage(roomId: string, agentId: string, name: string, message: string): ChatMsg | null {
  if (!parseRoomId(roomId)) return null;
  const msg: ChatMsg = { agentId, name, message, timestamp: Date.now() };

  // Fire-and-forget persist to Supabase
  saveChatMessage(roomId, agentId, name, message);

  // Periodic trim: every 50 messages, clean up old ones
  const count = (chatCounters.get(roomId) ?? 0) + 1;
  chatCounters.set(roomId, count);
  if (count % 50 === 0) {
    trimChatMessages(roomId);
  }

  return msg;
}

export async function getChatMessages(roomId: string, limit = 50): Promise<ChatMsg[]> {
  return loadChatMessages(roomId, limit);
}

// ─── Equity cache ──────────────────────────────────────────────────────────

const equityCache = new Map<string, { version: number; equity: Map<string, number> }>();

// ─── Room ID helpers ─────────────────────────────────────────────────────────

function makeRoomId(categoryId: string, tableNumber: number): string {
  return `casino_${categoryId}_${tableNumber}`;
}

/** Parse room ID like "casino_low_3" into { categoryId: "low", tableNumber: 3 } */
export function parseRoomId(id: string): { categoryId: string; tableNumber: number } | null {
  const m = id.match(/^casino_(\w+)_(\d+)$/);
  if (!m) return null;
  const categoryId = m[1];
  if (!STAKE_CATEGORIES.find(c => c.id === categoryId)) return null;
  return { categoryId, tableNumber: parseInt(m[2], 10) };
}

// ─── Build room from constants ────────────────────────────────────────────────

function buildRoomShell(categoryId: string, tableNumber: number): ExtendedRoom {
  const cat = STAKE_CATEGORIES.find(c => c.id === categoryId)!;
  const names = TABLE_NAMES[categoryId] ?? [];
  const name = names[tableNumber - 1] ?? `Table ${tableNumber}`;
  return {
    id: makeRoomId(categoryId, tableNumber),
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
}

// ─── Load room from DB ────────────────────────────────────────────────────────

/**
 * Loads a room by building its shell from constants and overlaying DB state.
 * Returns null only if the room ID is invalid.
 */
async function loadRoom(roomId: string): Promise<ExtendedRoom | null> {
  const parsed = parseRoomId(roomId);
  if (!parsed) return null;

  const room = buildRoomShell(parsed.categoryId, parsed.tableNumber);

  // Load game state from DB
  const saved = await loadRoomState(roomId);
  if (saved?.game) {
    const savedGame = saved.game as any;
    if (savedGame.phase && savedGame.phase !== 'waiting') {
      const { _turnDeadlineMs, _timeoutCounts, _nextHandAt, ...gameState } = savedGame;
      room.game = gameState;
      room.stateVersion = saved.stateVersion;
      if (_turnDeadlineMs && _turnDeadlineMs > Date.now()) {
        room.turnDeadlineMs = _turnDeadlineMs;
      }

      // Restore hole cards from per-agent table (stripped from game_json for security)
      const restoredGame = room.game!;
      if (restoredGame.id && restoredGame.players?.length > 0) {
        const allCards = await loadAllHoleCards(restoredGame.id);
        for (const p of restoredGame.players) {
          p.holeCards = allCards[p.agentId] ?? [];
        }
      }
    } else if (savedGame.phase === 'waiting') {
      // Restore waiting state with players
      const { _turnDeadlineMs, _timeoutCounts, _nextHandAt, ...gameState } = savedGame;
      room.game = gameState;
      room.stateVersion = saved.stateVersion;
    }

    // Backward compat: ensure new Player fields exist on restored data
    // Use 0 (not Date.now()) so legacy players without lastSeenAt are immediately stale
    if (room.game?.players) {
      for (const p of room.game.players) {
        p.lastSeenAt = p.lastSeenAt ?? 0;
        p.pendingLeave = p.pendingLeave ?? false;
      }
    }
  }

  return room;
}

// ─── Optimistic lock save with retry ─────────────────────────────────────────

async function saveWithRetry(
  roomId: string,
  buildState: (room: ExtendedRoom) => Promise<{ game: GameState | null; error?: string }>,
  maxRetries = 3,
): Promise<{ success: boolean; room?: ExtendedRoom; error?: string }> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const room = await loadRoom(roomId);
    if (!room) return { success: false, error: 'Room not found' };

    const result = await buildState(room);
    if (result.error) return { success: false, error: result.error };

    if (!result.game) {
      // No game to save — delete room state
      await deleteRoomState(roomId);
      return { success: true, room };
    }

    // Build snapshot with metadata — strip hole cards (they live in casino_hand_cards)
    const snapshot: any = { ...result.game };
    if (snapshot.players) {
      snapshot.players = snapshot.players.map((p: any) => ({ ...p, holeCards: [] }));
    }
    if (room.turnDeadlineMs) snapshot._turnDeadlineMs = room.turnDeadlineMs;

    const saveResult = await saveRoomStateWithVersion(roomId, snapshot, room.stateVersion);
    if (saveResult.success) {
      room.game = result.game;
      room.stateVersion = saveResult.newVersion;
      // Push spectator state to all subscribers (fire-and-forget)
      broadcastSpectatorState(roomId, room).catch(() => {});
      return { success: true, room };
    }

    // Version conflict — retry
    console.log(`[rooms] version conflict on ${roomId}, attempt ${attempt + 1}/${maxRetries}`);
  }

  return { success: false, error: 'Conflict: too many concurrent updates, please retry' };
}

// ─── Enforce timeout (deadline-based) ─────────────────────────────────────────

interface TimeoutResult {
  changed: boolean;
  pendingChipReturn?: { agentId: string; amount: number };
}

/**
 * Check if the current player's turn has expired. If so, auto-fold or kick.
 * Returns changed=true if a timeout was enforced, plus any chip return info.
 * Chip returns must be applied by the caller AFTER a successful DB save.
 */
function enforceTimeout(room: ExtendedRoom): TimeoutResult {
  if (!room.game || room.game.phase === 'waiting' || room.game.phase === 'showdown') return { changed: false };

  const gameAny = room.game as any;
  const deadline = gameAny._turnDeadlineMs ?? room.turnDeadlineMs;
  if (!deadline || Date.now() < deadline) return { changed: false };

  const currentPlayer = room.game.players[room.game.currentPlayerIndex];
  if (!currentPlayer) return { changed: false };

  // Track consecutive timeouts
  const timeoutCounts: Record<string, number> = gameAny._timeoutCounts ?? {};
  const key = currentPlayer.agentId;
  timeoutCounts[key] = (timeoutCounts[key] ?? 0) + 1;

  let pendingChipReturn: { agentId: string; amount: number } | undefined;

  if (timeoutCounts[key] >= 3) {
    // Kick after 3 consecutive timeouts — fold + mark pendingLeave
    console.log(`[kick] ${currentPlayer.name} kicked from ${room.id} after ${timeoutCounts[key]} consecutive timeouts`);
    delete timeoutCounts[key];

    const outcome = safeMidHandRemove(room.game, currentPlayer.agentId);
    if (outcome === 'removed') {
      // Race: phase changed — immediate removal
      const totalReturn = currentPlayer.chips + currentPlayer.currentBet;
      if (totalReturn > 0) {
        room.game.pot = Math.max(0, room.game.pot - currentPlayer.currentBet);
        pendingChipReturn = { agentId: currentPlayer.agentId, amount: totalReturn };
      }
    }
    // 'folded_pending' or 'pending' → removed in tryStartNextHand
  } else {
    // Auto-fold
    console.log(`[auto-fold] ${currentPlayer.name} timed out in ${room.id} (${timeoutCounts[key]}/3)`);
    processAction(room.game, currentPlayer.agentId, 'fold');
  }

  // Update timeout tracking and new deadline in game state
  (room.game as any)._timeoutCounts = timeoutCounts;

  // Set new deadline for next player if game is still active
  const phase = room.game.phase as string;
  if (phase !== 'waiting' && phase !== 'showdown') {
    room.turnDeadlineMs = Date.now() + TURN_TIMEOUT_MS;
    (room.game as any)._turnDeadlineMs = room.turnDeadlineMs;
  } else {
    room.turnDeadlineMs = null;
  }

  return { changed: true, pendingChipReturn };
}

/**
 * Public enforceTimeout: loads room from DB, enforces, saves.
 * Called from route.ts before returning game_state or processing play.
 */
export async function enforceTimeoutForRoom(roomId: string): Promise<void> {
  const room = await loadRoom(roomId);
  if (!room || !room.game) return;

  let result = enforceTimeout(room);
  // Might need multiple consecutive timeouts if multiple players timed out
  while (result.changed) {
    // Save intermediate state — strip hole cards
    const snapshot: any = { ...room.game };
    if (snapshot.players) {
      snapshot.players = snapshot.players.map((p: any) => ({ ...p, holeCards: [] }));
    }
    if (room.turnDeadlineMs) snapshot._turnDeadlineMs = room.turnDeadlineMs;
    const saveResult = await saveRoomStateWithVersion(roomId, snapshot, room.stateVersion);
    if (saveResult.success) {
      room.stateVersion = saveResult.newVersion;
      // Apply chip return only after successful save
      if (result.pendingChipReturn) {
        const { agentId, amount } = result.pendingChipReturn;
        await addChipsAtomic(agentId, amount);
      }
    }
    result = enforceTimeout(room);
  }
}

// ─── Join / Leave ─────────────────────────────────────────────────────────────

export async function joinRoom(roomId: string, agentId: string, agentName: string, buyIn: number): Promise<string | null> {
  const parsed = parseRoomId(roomId);
  if (!parsed) return 'Room not found';

  const cat = STAKE_CATEGORIES.find(c => c.id === parsed.categoryId);
  if (!cat) return 'Room not found';

  if (!Number.isFinite(buyIn) || buyIn < cat.minBuyIn || buyIn > cat.maxBuyIn) {
    return `Buy-in must be between ${cat.minBuyIn.toLocaleString()} and ${cat.maxBuyIn.toLocaleString()}`;
  }

  const agent = await getAgent(agentId);
  if (!agent) return 'Agent not found. Register first.';
  if (agent.chips < buyIn) {
    return `Not enough chips. You have ${agent.chips.toLocaleString()}, need ${buyIn.toLocaleString()}`;
  }

  // Deduct chips atomically FIRST
  const newBalance = await deductChipsAtomic(agentId, buyIn);
  if (newBalance === null) return 'Failed to deduct chips (insufficient balance or conflict)';

  const result = await saveWithRetry(roomId, async (room) => {
    if (!room.game) {
      room.game = createGame(room.smallBlind, room.bigBlind);
    }

    if (room.game.players.length >= room.maxPlayers) {
      return { game: null, error: 'Room is full' };
    }

    if (room.game.players.find(p => p.agentId === agentId)) {
      return { game: null, error: 'Already at this table' };
    }

    const takenSeats = new Set(room.game.players.map(p => p.seatIndex));
    let seatIndex = -1;
    for (let i = 0; i < room.maxPlayers; i++) {
      if (!takenSeats.has(i)) { seatIndex = i; break; }
    }
    if (seatIndex === -1) return { game: null, error: 'No seats available' };

    if (!addPlayer(room.game, agentId, agentName, buyIn, seatIndex)) {
      return { game: null, error: 'Failed to join table' };
    }

    return { game: room.game };
  });

  if (!result.success) {
    // Refund chips on failure
    await addChipsAtomic(agentId, buyIn);
    return result.error || 'Failed to join';
  }

  // Player data persisted in game_json via saveWithRetry above

  // Auto-scale check
  await autoScaleUp(parsed.categoryId);

  return null;
}

export async function leaveRoom(roomId: string, agentId: string): Promise<{ success: boolean; error?: string }> {
  // Track what chips need returning — only refund AFTER save succeeds
  let chipsToReturn = 0;
  let pendingFlush: { agentId: string; chips: number }[] = [];

  const result = await saveWithRetry(roomId, async (room) => {
    if (!room.game) return { game: null };

    const player = room.game.players.find(p => p.agentId === agentId);
    if (!player) return { game: room.game };

    // Reset deferred amounts for this retry attempt
    chipsToReturn = 0;
    pendingFlush = [];

    const phase = room.game.phase;
    const isActiveHand = phase !== 'waiting' && phase !== 'showdown';

    if (isActiveHand) {
      // Mid-hand: fold + mark pendingLeave — chips returned (minus penalty) at hand end
      player.isConnected = false;
      const outcome = safeMidHandRemove(room.game, agentId);
      if (outcome === 'removed') {
        // Race: phase changed between check and call — return chips immediately
        chipsToReturn = player.chips + player.currentBet;
        room.game.pot = Math.max(0, room.game.pot - player.currentBet);
      } else if (outcome === 'folded_pending' || outcome === 'pending') {
        // Penalty for voluntary mid-hand exit: 1 BB added to pot
        const penalty = Math.min(player.chips, room.game.bigBlind);
        if (penalty > 0) {
          player.chips -= penalty;
          room.game.pot += penalty;
        }
      }
    } else {
      // Between hands: remove immediately, defer chip return
      const removed = removePlayer(room.game, agentId);
      if (removed) {
        chipsToReturn = removed.chips + removed.currentBet;
        room.game.pot = Math.max(0, room.game.pot - removed.currentBet);
      }
    }

    if (room.game.players.length === 0) return { game: null };

    // All remaining players are pendingLeave — no one to continue the hand
    const allPending = room.game.players.every(p => p.pendingLeave);
    if (allPending) {
      for (const p of [...room.game.players]) {
        const totalReturn = p.chips + p.currentBet;
        if (totalReturn > 0) pendingFlush.push({ agentId: p.agentId, chips: totalReturn });
        removePlayer(room.game, p.agentId);
      }
      return { game: null };
    }

    return { game: room.game };
  });

  if (!result.success) {
    return { success: false, error: result.error || 'Failed to leave table — please retry' };
  }

  // Save succeeded — now atomically return chips
  if (chipsToReturn > 0) {
    await addChipsAtomic(agentId, chipsToReturn);
  }
  for (const pf of pendingFlush) {
    await addChipsAtomic(pf.agentId, pf.chips);
  }

  return { success: true };
}

// ─── Game actions ─────────────────────────────────────────────────────────────

export async function handleAction(
  roomId: string,
  agentId: string,
  action: string,
  amount?: number,
  isTimeout = false,
): Promise<string | null> {
  const validActions = ['fold', 'check', 'call', 'raise', 'all_in'];
  if (!validActions.includes(action)) return 'Invalid action';

  let timeoutChipReturn: { agentId: string; amount: number } | undefined;
  const result = await saveWithRetry(roomId, async (room) => {
    timeoutChipReturn = undefined; // reset on each retry
    if (!room.game) return { game: null, error: 'No active game' };

    // Enforce timeout before processing action
    const timeoutResult = enforceTimeout(room);
    if (timeoutResult.pendingChipReturn) timeoutChipReturn = timeoutResult.pendingChipReturn;

    // Check if game ended due to timeout enforcement
    if (!room.game || room.game.phase === 'waiting' || room.game.phase === 'showdown') {
      // Return current state — the timeout changed things
      return { game: room.game };
    }

    const success = processAction(room.game, agentId, action as any, amount);
    if (!success) return { game: null, error: 'Invalid action for current game state' };

    // Real action resets consecutive timeout count + update lastSeenAt
    if (!isTimeout) {
      const timeoutCounts: Record<string, number> = (room.game as any)._timeoutCounts ?? {};
      delete timeoutCounts[agentId];
      (room.game as any)._timeoutCounts = timeoutCounts;

      const actingPlayer = room.game.players.find(p => p.agentId === agentId);
      if (actingPlayer) actingPlayer.lastSeenAt = Date.now();
    }

    // Set turn deadline for next player
    const actionPhase = room.game.phase as string;
    if (actionPhase !== 'waiting' && actionPhase !== 'showdown') {
      room.turnDeadlineMs = Date.now() + TURN_TIMEOUT_MS;
      (room.game as any)._turnDeadlineMs = room.turnDeadlineMs;
    } else {
      room.turnDeadlineMs = null;
      delete (room.game as any)._turnDeadlineMs;
    }

    // If showdown, set _nextHandAt deadline
    if (actionPhase === 'showdown') {
      (room.game as any)._nextHandAt = Date.now() + SHOWDOWN_DELAY_MS;
    }

    return { game: room.game };
  });

  if (result.success && timeoutChipReturn) {
    await addChipsAtomic(timeoutChipReturn.agentId, timeoutChipReturn.amount);
  }
  if (!result.success) return result.error || 'Action failed';
  return null;
}

/**
 * After startNewHand() deals cards into players[].holeCards,
 * persist them to casino_hand_cards and strip from the game blob
 * so they never appear in the shared game_json.
 */
async function isolateHoleCards(game: GameState, roomId: string): Promise<void> {
  const handId = game.id;
  const playersWithCards = game.players
    .filter(p => p.holeCards.length === 2)
    .map(p => ({ agentId: p.agentId, holeCards: [...p.holeCards] }));

  // Save to per-agent table
  await saveAllHoleCards(handId, roomId, playersWithCards);

  // Strip from shared game state — cards now only live in casino_hand_cards
  for (const p of game.players) {
    p.holeCards = [];
  }
}

export async function tryStartGame(roomId: string): Promise<boolean> {
  const result = await saveWithRetry(roomId, async (room) => {
    if (!room.game) return { game: null, error: 'no game' };
    if (!canStartGame(room.game)) return { game: null, error: 'cannot start' };

    startNewHand(room.game, roomId, room.name);

    // Isolate hole cards to per-agent table before saving game_json
    await isolateHoleCards(room.game, roomId);

    // Set turn deadline
    room.turnDeadlineMs = Date.now() + TURN_TIMEOUT_MS;
    (room.game as any)._turnDeadlineMs = room.turnDeadlineMs;
    (room.game as any)._timeoutCounts = {};

    return { game: room.game };
  });

  return result.success;
}

export async function tryStartNextHand(roomId: string): Promise<boolean> {
  const pendingChipsToReturn: { agentId: string; amount: number }[] = [];
  const result = await saveWithRetry(roomId, async (room) => {
    pendingChipsToReturn.length = 0; // reset on each retry
    if (!room.game) return { game: null, error: 'no game' };
    if (room.game.phase !== 'showdown') return { game: null, error: 'not showdown' };
    if (room.game.players.length < 2) return { game: null, error: 'not enough players' };

    // Check if showdown delay has passed
    const nextHandAt = (room.game as any)._nextHandAt;
    if (nextHandAt && Date.now() < nextHandAt) {
      return { game: null, error: 'showdown delay not elapsed' };
    }

    // Remove busted players
    const bustedPlayers = room.game.players.filter(p => p.chips <= 0);
    for (const p of bustedPlayers) {
      console.log(`[rooms] busted player ${p.name} (${p.agentId}) removed from ${roomId}`);
      removePlayer(room.game, p.agentId);
    }

    // Flush players who left mid-hand (pendingLeave)
    const pendingLeavePlayers = room.game.players.filter(p => p.pendingLeave);
    for (const p of pendingLeavePlayers) {
      console.log(`[rooms] pending-leave player ${p.name} (${p.agentId}) removed from ${roomId}`);
      const totalReturn = p.chips; // currentBet is 0 after showdown reset
      removePlayer(room.game, p.agentId);
      if (totalReturn > 0) pendingChipsToReturn.push({ agentId: p.agentId, amount: totalReturn });
    }

    if (room.game.players.length < 2) {
      // Not enough players for a new hand — reset to waiting but still return pendingLeave chips
      if (room.game.players.length > 0) room.game.phase = 'waiting' as any;
      return { game: room.game.players.length > 0 ? room.game : null };
    }

    // Clean up previous hand's cards
    const prevHandId = room.game.id;
    if (prevHandId) deleteHandCards(prevHandId);

    startNewHand(room.game);

    // Isolate hole cards to per-agent table before saving game_json
    await isolateHoleCards(room.game, roomId);

    // Set turn deadline
    room.turnDeadlineMs = Date.now() + TURN_TIMEOUT_MS;
    (room.game as any)._turnDeadlineMs = room.turnDeadlineMs;
    (room.game as any)._timeoutCounts = {};
    delete (room.game as any)._nextHandAt;

    return { game: room.game };
  });

  if (result.success) {
    for (const { agentId, amount } of pendingChipsToReturn) {
      await addChipsAtomic(agentId, amount);
    }
  }
  return result.success;
}

// ─── Stale player eviction ────────────────────────────────────────────────────

export async function evictStalePlayers(roomId: string): Promise<string[]> {
  const evicted: string[] = [];
  const chipsToReturn: { agentId: string; amount: number }[] = [];
  const now = Date.now();

  const saveResult = await saveWithRetry(roomId, async (room) => {
    evicted.length = 0; // reset on each retry
    chipsToReturn.length = 0;
    if (!room.game || room.game.players.length === 0) return { game: room.game };

    const stalePlayers = room.game.players.filter(p => {
      const lastSeen = p.lastSeenAt ?? 0;
      return (now - lastSeen) > STALE_PLAYER_MS;
    });

    if (stalePlayers.length === 0) return { game: room.game };

    for (const stale of stalePlayers) {
      console.log(`[rooms] evicting stale player ${stale.name} (${stale.agentId}) from ${roomId} — last seen ${Math.round((now - (stale.lastSeenAt ?? 0)) / 1000)}s ago`);

      const phase = room.game!.phase;
      const isActiveHand = phase !== 'waiting' && phase !== 'showdown';

      if (isActiveHand) {
        safeMidHandRemove(room.game!, stale.agentId);
        evicted.push(stale.agentId);
      } else {
        const removed = removePlayer(room.game!, stale.agentId);
        if (removed) {
          const totalReturn = removed.chips + removed.currentBet;
          if (totalReturn > 0) {
            chipsToReturn.push({ agentId: stale.agentId, amount: totalReturn });
            room.game!.pot = Math.max(0, room.game!.pot - removed.currentBet);
          }
          evicted.push(stale.agentId);
        }
      }
    }

    // If all players removed (or only pendingLeave left), flush remaining chips
    // before deleting the room — tryStartNextHand will never run on an empty room
    if (room.game!.players.length === 0) {
      return { game: null };
    }

    const allPending = room.game!.players.every(p => p.pendingLeave);
    if (allPending) {
      for (const p of [...room.game!.players]) {
        const totalReturn = p.chips + p.currentBet;
        if (totalReturn > 0) {
          await addChipsAtomic(p.agentId, totalReturn);
        }
        removePlayer(room.game!, p.agentId);
      }
      return { game: null };
    }

    // After eviction, ensure turn deadline is set for the current player
    if (evicted.length > 0 && room.game!.phase !== 'waiting' && room.game!.phase !== 'showdown') {
      room.turnDeadlineMs = Date.now() + TURN_TIMEOUT_MS;
      (room.game as any)._turnDeadlineMs = room.turnDeadlineMs;
    }

    // Lone player timeout: 1 player sitting alone in waiting/showdown too long → remove
    const phase = room.game!.phase;
    if ((phase === 'waiting' || phase === 'showdown') && room.game!.players.length === 1) {
      const lone = room.game!.players[0];
      const lastSeen = lone.lastSeenAt ?? 0;
      if ((now - lastSeen) > LONE_PLAYER_TIMEOUT_MS) {
        console.log(`[rooms] lone player ${lone.name} (${lone.agentId}) removed from ${roomId} — waited alone for ${Math.round((now - lastSeen) / 1000)}s`);
        const totalReturn = lone.chips + lone.currentBet;
        removePlayer(room.game!, lone.agentId);
        if (totalReturn > 0) {
          await addChipsAtomic(lone.agentId, totalReturn);
        }
        evicted.push(lone.agentId);
        return { game: null };
      }
    }

    return { game: room.game };
  });

  if (saveResult.success) {
    for (const { agentId, amount } of chipsToReturn) {
      await addChipsAtomic(agentId, amount);
    }
  }
  return evicted;
}

// ─── Auto-scaling ──────────────────────────────────────────────────────────────

async function autoScaleUp(categoryId: string): Promise<string | null> {
  const allStates = await loadAllRoomStates();
  const cat = STAKE_CATEGORIES.find(c => c.id === categoryId);
  if (!cat) return null;

  const minCount = MIN_TABLES[categoryId] ?? 1;
  const tableNumbers = new Set<number>();
  for (let i = 1; i <= minCount; i++) tableNumbers.add(i);
  for (const [rid] of allStates) {
    const parsed = parseRoomId(rid);
    if (parsed && parsed.categoryId === categoryId) tableNumbers.add(parsed.tableNumber);
  }

  let allBusy = true;
  for (const num of tableNumbers) {
    const rid = makeRoomId(categoryId, num);
    const state = allStates.get(rid);
    const count = (state?.game as any)?.players?.length ?? 0;
    if (count / cat.maxPlayers < SCALE_UP_THRESHOLD) { allBusy = false; break; }
  }

  if (!allBusy) return null;
  const nextNum = Math.max(...tableNumbers) + 1;
  const newRoomId = makeRoomId(categoryId, nextNum);
  console.log(`[rooms] Auto-scaled: ${newRoomId}`);
  return newRoomId;
}

/**
 * Auto-scale down: remove empty tables beyond the minimum.
 * Called by the cleanup cron.
 */
export async function autoScaleDown(): Promise<number> {
  let removed = 0;
  const allStates = await loadAllRoomStates();

  for (const cat of STAKE_CATEGORIES) {
    const minCount = MIN_TABLES[cat.id] ?? 1;
    const tableNumbers = new Set<number>();
    for (const [rid] of allStates) {
      const parsed = parseRoomId(rid);
      if (parsed && parsed.categoryId === cat.id) tableNumbers.add(parsed.tableNumber);
    }
    for (let i = 1; i <= minCount; i++) tableNumbers.add(i);

    const sorted = [...tableNumbers].sort((a, b) => b - a);
    let currentCount = sorted.length;
    for (const num of sorted) {
      if (currentCount <= minCount) break;
      const rid = makeRoomId(cat.id, num);
      const state = allStates.get(rid);
      const hasPlayers = ((state?.game as any)?.players?.length ?? 0) > 0;
      if (!hasPlayers) {
        await deleteRoomState(rid);
        currentCount--;
        removed++;
      }
    }
  }

  if (removed > 0) console.log(`[rooms] Auto-scaled down: removed ${removed} empty table(s)`);
  return removed;
}

// ─── Lookup ───────────────────────────────────────────────────────────────────

export async function getRoom(id: string): Promise<ExtendedRoom | null> {
  return loadRoom(id);
}

/** Returns the roomId of the first room where agentId is seated, or null */
export async function getAgentRoom(agentId: string): Promise<string | null> {
  const allStates = await loadAllRoomStates();
  for (const [rid, state] of allStates) {
    const players = (state.game as any)?.players ?? [];
    if (players.some((p: any) => p.agentId === agentId)) return rid;
  }
  return null;
}

// ─── State version ────────────────────────────────────────────────────────────

export async function getRoomStateVersion(roomId: string): Promise<number> {
  const saved = await loadRoomState(roomId);
  return saved?.stateVersion ?? 0;
}

/** Long-poll: wait up to maxWaitMs for stateVersion to exceed sinceVersion. */
export async function waitForStateChange(
  roomId: string,
  sinceVersion: number,
  maxWaitMs = 8_000,
): Promise<number> {
  const interval = 500;
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const current = await getRoomStateVersion(roomId);
    if (current > sinceVersion) return current;
    await new Promise<void>(r => setTimeout(r, interval));
  }
  return await getRoomStateVersion(roomId);
}

// ─── Listing ──────────────────────────────────────────────────────────────────

function toRoomInfo(room: ExtendedRoom, playerCount: number): RoomInfo {
  const players = room.game?.players ?? [];
  return {
    id: room.id,
    name: room.name,
    playerCount,
    maxPlayers: room.maxPlayers,
    smallBlind: room.smallBlind,
    bigBlind: room.bigBlind,
    minBuyIn: room.minBuyIn,
    maxBuyIn: room.maxBuyIn,
    categoryId: room.categoryId,
    tableNumber: room.tableNumber,
    createdAt: room.createdAt,
    pot: room.game?.pot ?? 0,
    totalChips: players.reduce((s, p) => s + p.chips, 0),
  };
}

export async function listRooms(): Promise<RoomInfo[]> {
  const allStates = await loadAllRoomStates();
  const rooms: RoomInfo[] = [];

  for (const cat of STAKE_CATEGORIES) {
    const minCount = MIN_TABLES[cat.id] ?? 1;
    const tableNumbers = new Set<number>();
    for (let i = 1; i <= minCount; i++) tableNumbers.add(i);
    for (const [rid] of allStates) {
      const parsed = parseRoomId(rid);
      if (parsed && parsed.categoryId === cat.id) tableNumbers.add(parsed.tableNumber);
    }

    for (const num of [...tableNumbers].sort((a, b) => a - b)) {
      const rid = makeRoomId(cat.id, num);
      const shell = buildRoomShell(cat.id, num);
      const state = allStates.get(rid);
      if (state?.game) {
        shell.game = state.game as any;
        shell.stateVersion = state.stateVersion;
      }
      const playerCount = shell.game?.players?.length ?? 0;
      rooms.push(toRoomInfo(shell, playerCount));
    }
  }

  return rooms;
}

export async function listRecommendedRooms(): Promise<RoomInfo[]> {
  const all = await listRooms();
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

export async function listCategories(recommended = false): Promise<(Omit<StakeCategory, 'tables'> & { tables: RoomInfo[] })[]> {
  const all = await listRooms();

  return STAKE_CATEGORIES.map(cat => {
    let tables = all
      .filter(r => r.categoryId === cat.id)
      .sort((a, b) => (b.pot ?? 0) - (a.pot ?? 0) || (b.totalChips ?? 0) - (a.totalChips ?? 0) || (a.tableNumber ?? 0) - (b.tableNumber ?? 0));

    if (recommended) {
      const active = tables.filter(t => t.playerCount > 0);
      const firstEmpty = tables.find(t => t.playerCount === 0);
      tables = active.length > 0
        ? (firstEmpty ? [...active, firstEmpty] : active)
        : (firstEmpty ? [firstEmpty] : []);
    }

    return { ...cat, tables };
  });
}

// ─── Client state ─────────────────────────────────────────────────────────────

export async function getClientGameState(roomId: string, viewerAgentId: string): Promise<ClientGameState | null> {
  // Evict stale players (piggyback on every poll)
  await evictStalePlayers(roomId);

  const room = await loadRoom(roomId);
  if (!room || !room.game) return null;

  // Enforce any expired timeouts
  let changed = await enforceTimeout(room);
  while (changed) {
    const snapshot: any = { ...room.game };
    // Strip hole cards from snapshot (they live in casino_hand_cards)
    if (snapshot.players) {
      snapshot.players = snapshot.players.map((p: any) => ({ ...p, holeCards: [] }));
    }
    if (room.turnDeadlineMs) snapshot._turnDeadlineMs = room.turnDeadlineMs;
    const saveResult = await saveRoomStateWithVersion(roomId, snapshot, room.stateVersion);
    if (saveResult.success) room.stateVersion = saveResult.newVersion;
    changed = await enforceTimeout(room);
  }

  // ── Stuck game recovery ──
  if (room.game && room.game.phase !== 'waiting' && room.game.phase !== 'showdown') {
    const current = room.game.players[room.game.currentPlayerIndex];
    const gameAny = room.game as any;
    const hasDeadline = !!(gameAny._turnDeadlineMs ?? room.turnDeadlineMs);
    const isCurrentFolded = !current || current.hasFolded;
    const isCurrentAllInOnly = current?.isAllIn && room.game.players.filter(p => !p.hasFolded && !p.isAllIn).length <= 1;
    // Stuck: current player is folded/invalid, OR no deadline set (game will never timeout)
    const isStuck = isCurrentFolded || isCurrentAllInOnly || !hasDeadline;

    if (isStuck) {
      console.log(`[rooms] stuck game detected in ${roomId} — currentPlayerIndex=${room.game.currentPlayerIndex}, hasDeadline=${hasDeadline}, currentFolded=${isCurrentFolded}`);

      // If no deadline but current player is valid, just set a deadline
      if (!hasDeadline && current && !current.hasFolded && !isCurrentAllInOnly) {
        room.turnDeadlineMs = Date.now() + TURN_TIMEOUT_MS;
        (room.game as any)._turnDeadlineMs = room.turnDeadlineMs;
      } else {
        // Current player is folded/invalid — advance the game
        const { advancePhase: advancePhaseEngine } = await import('./poker-engine');
        const nonFolded = room.game.players.filter(p => !p.hasFolded);
        if (nonFolded.length === 1) {
          const winner = nonFolded[0];
          const potAmount = room.game.pot;
          winner.chips += potAmount;
          room.game.pot = 0;
          room.game.phase = 'showdown' as any;
          room.game.winners = [{ agentId: winner.agentId, name: winner.name, amount: potAmount, hand: null as any }];
        } else if (nonFolded.length === 0) {
          room.game.phase = 'showdown' as any;
        } else {
          advancePhaseEngine(room.game);
        }
      }

      // Save fixed state
      const snapshot: any = { ...room.game };
      if (snapshot.players) {
        snapshot.players = snapshot.players.map((p: any) => ({ ...p, holeCards: [] }));
      }
      if (room.turnDeadlineMs) snapshot._turnDeadlineMs = room.turnDeadlineMs;
      const saveResult = await saveRoomStateWithVersion(roomId, snapshot, room.stateVersion);
      if (saveResult.success) room.stateVersion = saveResult.newVersion;
    }
  }

  const game = room.game;
  if (!game) return null;

  const isSpectator = !viewerAgentId || viewerAgentId === '__spectator__';
  const isShowdown = game.phase === 'showdown';
  const handId = game.id;

  // ── Load hole cards from per-agent table ──
  // Spectator + showdown: load all; Agent: load only own
  let holeCardsByAgent: Record<string, import('./types').Card[]> = {};
  if (handId && game.phase !== 'waiting') {
    if (isSpectator || isShowdown) {
      holeCardsByAgent = await loadAllHoleCards(handId);
    } else if (viewerAgentId) {
      const myCards = await loadHoleCards(handId, viewerAgentId);
      if (myCards) holeCardsByAgent[viewerAgentId] = myCards;
    }
  }

  // ── Equity: only for spectators (agents think for themselves) ──
  let equity: Map<string, number> | null = null;
  if (isSpectator && game.phase !== 'waiting' && game.phase !== 'showdown') {
    const allCards = holeCardsByAgent;
    const hasCards = Object.values(allCards).some(c => c.length === 2);
    if (hasCards) {
      const cached = equityCache.get(roomId);
      if (cached && cached.version === room.stateVersion) {
        equity = cached.equity;
      } else {
        equity = calculateEquity(
          game.players.map(p => ({
            agentId: p.agentId,
            holeCards: allCards[p.agentId] ?? [],
            hasFolded: p.hasFolded,
          })),
          game.communityCards,
        );
        equityCache.set(roomId, { version: room.stateVersion, equity });
      }
    }
  }

  // ── Build client players with filtered hole cards ──
  const players: ClientPlayer[] = game.players.map(p => {
    let cards: import('./types').Card[] | null = null;

    if (isSpectator) {
      // Spectator sees all cards
      cards = holeCardsByAgent[p.agentId] ?? null;
    } else if (isShowdown && !p.hasFolded) {
      // Showdown: reveal non-folded players' cards to everyone
      cards = holeCardsByAgent[p.agentId] ?? null;
    } else if (p.agentId === viewerAgentId) {
      // Agent sees only own cards
      cards = holeCardsByAgent[p.agentId] ?? null;
    }

    return {
      agentId: p.agentId,
      name: p.name,
      seatIndex: p.seatIndex,
      chips: p.chips,
      holeCards: cards,
      currentBet: p.currentBet,
      hasFolded: p.hasFolded,
      hasActed: p.hasActed,
      isAllIn: p.isAllIn,
      isConnected: p.isConnected && (Date.now() - (p.lastSeenAt ?? 0)) < 60_000,
      winProbability: isSpectator ? (equity?.get(p.agentId) ?? null) : null,
    };
  });

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

/**
 * Build the spectator ClientGameState and broadcast it via Supabase Realtime.
 * Called after every state change so spectators get push updates with zero polling.
 */
async function broadcastSpectatorState(roomId: string, room: ExtendedRoom): Promise<void> {
  if (!room.game) return;

  const game = room.game;
  const handId = game.id;

  // Load all hole cards for spectator view
  let holeCardsByAgent: Record<string, import('./types').Card[]> = {};
  if (handId && game.phase !== 'waiting') {
    holeCardsByAgent = await loadAllHoleCards(handId);
  }

  // Calculate equity
  let equity: Map<string, number> | null = null;
  if (game.phase !== 'waiting' && game.phase !== 'showdown') {
    const hasCards = Object.values(holeCardsByAgent).some(c => c.length === 2);
    if (hasCards) {
      const cached = equityCache.get(roomId);
      if (cached && cached.version === room.stateVersion) {
        equity = cached.equity;
      } else {
        equity = calculateEquity(
          game.players.map(p => ({
            agentId: p.agentId,
            holeCards: holeCardsByAgent[p.agentId] ?? [],
            hasFolded: p.hasFolded,
          })),
          game.communityCards,
        );
        equityCache.set(roomId, { version: room.stateVersion, equity });
      }
    }
  }

  const now = Date.now();
  const deadline = room.turnDeadlineMs ?? null;
  const turnTimeRemaining = deadline !== null ? Math.max(0, Math.round((deadline - now) / 1000)) : null;

  const state: ClientGameState = {
    id: game.id,
    phase: game.phase,
    players: game.players.map(p => ({
      agentId: p.agentId,
      name: p.name,
      seatIndex: p.seatIndex,
      chips: p.chips,
      holeCards: holeCardsByAgent[p.agentId] ?? null,
      currentBet: p.currentBet,
      hasFolded: p.hasFolded,
      hasActed: p.hasActed,
      isAllIn: p.isAllIn,
      isConnected: p.isConnected && (now - (p.lastSeenAt ?? 0)) < 60_000,
      winProbability: equity?.get(p.agentId) ?? null,
    })),
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

  // Fire-and-forget broadcast to spectators
  supabase.channel(`room:${roomId}`).send({
    type: 'broadcast',
    event: 'game_state',
    payload: state,
  }).catch(() => {}); // never block on broadcast failure
}

export async function getValidActionsForRoom(roomId: string): Promise<ReturnType<typeof getValidActions>> {
  const room = await loadRoom(roomId);
  if (!room || !room.game) return [];
  return getValidActions(room.game);
}

// ─── Heartbeat ────────────────────────────────────────────────────────────────

export async function heartbeatPlayer(roomId: string, agentId: string): Promise<boolean> {
  const result = await saveWithRetry(roomId, async (room) => {
    if (!room.game) return { game: null, error: 'no game' };
    const player = room.game.players.find(p => p.agentId === agentId);
    if (!player) return { game: null, error: 'not seated' };
    player.lastSeenAt = Date.now();
    return { game: room.game };
  });
  return result.success;
}
