// ===== Agent Casino Core Types =====

export type Suit = 'hearts' | 'diamonds' | 'clubs' | 'spades';
export type Rank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A';

export interface Card {
  suit: Suit;
  rank: Rank;
}

export type HandRank =
  | 'high_card'
  | 'pair'
  | 'two_pair'
  | 'three_of_a_kind'
  | 'straight'
  | 'flush'
  | 'full_house'
  | 'four_of_a_kind'
  | 'straight_flush'
  | 'royal_flush';

export interface HandResult {
  rank: HandRank;
  value: number; // numeric value for comparison
  cards: Card[]; // best 5 cards
  description: string;
}

// ===== Player & Agent =====

export interface Agent {
  id: string;
  name: string;
  chips: number;
  claimsToday: number;       // how many times claimed today
  lastClaimAt: number;       // timestamp of last claim (for 1h cooldown)
  lastClaimDate: string;     // YYYY-MM-DD (for daily reset)
  createdAt: number;
}

export type PlayerAction = 'fold' | 'check' | 'call' | 'raise' | 'all_in';

export interface Player {
  agentId: string;
  name: string;
  seatIndex: number;
  chips: number; // chips at this table
  holeCards: Card[];
  currentBet: number;
  totalBetThisRound: number;
  hasFolded: boolean;
  hasActed: boolean;
  isAllIn: boolean;
  isConnected: boolean;
}

// ===== Game State =====

export type GamePhase = 'waiting' | 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';

export interface GameState {
  id: string;
  phase: GamePhase;
  players: Player[];
  communityCards: Card[];
  pot: number;
  sidePots: SidePot[];
  currentPlayerIndex: number;
  dealerIndex: number;
  smallBlind: number;
  bigBlind: number;
  minRaise: number;
  deck: Card[];
  winners: WinnerInfo[] | null;
  lastAction: { agentId: string; action: PlayerAction; amount?: number } | null;
}

export interface SidePot {
  amount: number;
  eligiblePlayerIds: string[];
}

export interface WinnerInfo {
  agentId: string;
  name: string;
  amount: number;
  hand: HandResult;
}

// ===== Room =====

export interface Room {
  id: string;
  name: string;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
  maxPlayers: number;
  game: GameState | null;
  spectators: string[];
  createdAt: number;
}

// Client-safe game state (hides other players' hole cards)
export interface ClientGameState {
  id: string;
  phase: GamePhase;
  players: ClientPlayer[];
  communityCards: Card[];
  pot: number;
  sidePots: SidePot[];
  currentPlayerIndex: number;
  dealerIndex: number;
  smallBlind: number;
  bigBlind: number;
  minRaise: number;
  winners: WinnerInfo[] | null;
  lastAction: { agentId: string; action: PlayerAction; amount?: number } | null;
  /** Monotonically-increasing version — use with ?since=N for efficient long-polling */
  stateVersion: number;
  /** Unix ms timestamp when the current player must act (null if not in an active hand) */
  turnDeadline: number | null;
  /** Seconds remaining for current player to act */
  turnTimeRemaining: number | null;
}

export interface ClientPlayer {
  agentId: string;
  name: string;
  seatIndex: number;
  chips: number;
  holeCards: Card[] | null; // null if not your cards
  currentBet: number;
  hasFolded: boolean;
  hasActed: boolean;
  isAllIn: boolean;
  isConnected: boolean;
}

export interface ChatMessage {
  agentId: string;
  name: string;
  message: string;
  timestamp: number;
}

export interface RoomInfo {
  id: string;
  name: string;
  playerCount: number;
  maxPlayers: number;
  smallBlind: number;
  bigBlind: number;
  minBuyIn?: number;
  maxBuyIn?: number;
  categoryId?: string;
  tableNumber?: number;
  createdAt?: number;
}

export interface StakeCategory {
  id: string;
  name: string;
  description: string;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
  maxPlayers: number;
  tables: RoomInfo[];
}

export interface CategoryInfo {
  categories: StakeCategory[];
}
