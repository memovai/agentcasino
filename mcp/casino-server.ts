#!/usr/bin/env npx tsx
/**
 * Mimi MCP Server
 *
 * An MCP (Model Context Protocol) server that lets any AI agent play
 * Texas Hold'em at Mimi. Works with Claude Code, Cursor, Windsurf,
 * and any MCP-compatible client.
 *
 * Usage:
 *   npx tsx mcp/casino-server.ts
 *
 * Or add to your MCP config:
 *   {
 *     "mcpServers": {
 *       "mimi": {
 *         "command": "npx",
 *         "args": ["tsx", "/path/to/agentcasino/mcp/casino-server.ts"],
 *         "env": {
 *           "CASINO_URL": "https://www.agentcasino.dev"
 *         }
 *       }
 *     }
 *   }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const CASINO_URL = process.env.CASINO_URL || 'https://www.agentcasino.dev';
const API = `${CASINO_URL}/api/casino`;

// ---------------------------------------------------------------------------
// API key persistence — env var → file → in-memory
// ---------------------------------------------------------------------------

const KEY_FILE = path.join(os.homedir(), '.config', 'agentcasino', 'key');

/** Load stored secret key: env var takes priority, then file */
function loadStoredKey(): string {
  const envKey = process.env.CASINO_API_KEY || '';
  if (envKey.startsWith('sk_')) return envKey;
  try {
    const key = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (key.startsWith('sk_')) return key;
  } catch { /* file not found */ }
  return '';
}

/** Persist API key to ~/.config/agentcasino/key */
function persistKey(apiKey: string): void {
  try {
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    fs.writeFileSync(KEY_FILE, apiKey, 'utf8');
  } catch (e) {
    console.error('[Mimi MCP] Could not save key to file:', e);
  }
}

// In-memory key for this session (populated on register or loaded from storage)
let sessionApiKey: string = loadStoredKey();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (sessionApiKey) headers['Authorization'] = `Bearer ${sessionApiKey}`;
  return headers;
}

async function casinoGet(params: Record<string, string>): Promise<any> {
  const url = new URL(API);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { headers: authHeaders() });
  return res.json();
}

async function casinoPost(body: Record<string, any>): Promise<any> {
  const res = await fetch(API, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  return res.json();
}

function formatGameState(data: any): string {
  if (!data.phase || data.phase === 'waiting') {
    return '⏳ Waiting for players to join...';
  }

  const lines: string[] = [];
  lines.push(`\n🃏 === POKER TABLE === (${data.room_name || 'Table'})`);
  lines.push(`📍 Phase: ${data.phase.toUpperCase()}`);
  lines.push(`💰 Pot: ${data.pot?.toLocaleString()}`);
  lines.push(`🎯 Blinds: ${data.smallBlind?.toLocaleString()}/${data.bigBlind?.toLocaleString()}`);

  if (data.communityCards?.length > 0) {
    const cards = data.communityCards.map((c: any) => cardStr(c)).join(' ');
    lines.push(`\n🂠 Community: ${cards}`);
  }

  lines.push('\n👥 Players:');
  for (const p of data.players || []) {
    const marker = data.players[data.currentPlayerIndex]?.agentId === p.agentId ? '👉 ' : '   ';
    const dealer = data.players[data.dealerIndex]?.agentId === p.agentId ? ' [D]' : '';
    const status = p.hasFolded ? ' (folded)' : p.isAllIn ? ' (ALL IN)' : '';
    const cards = p.holeCards ? p.holeCards.map((c: any) => cardStr(c)).join(' ') : '🂠 🂠';
    const bet = p.currentBet > 0 ? ` | bet: ${p.currentBet.toLocaleString()}` : '';
    lines.push(`${marker}${p.name}${dealer}: ${cards} | chips: ${p.chips.toLocaleString()}${bet}${status}`);
  }

  if (data.you) {
    lines.push(`\n🎴 Your cards: ${data.you.holeCards?.map((c: any) => cardStr(c)).join(' ') || 'none'}`);
    lines.push(`💵 Your chips: ${data.you.chips.toLocaleString()}`);
  }

  if (data.is_your_turn) {
    lines.push('\n⚡ IT\'S YOUR TURN!');
    if (data.valid_actions?.length > 0) {
      const actions = data.valid_actions.map((a: any) => {
        if (a.minAmount) return `${a.action}(${a.minAmount.toLocaleString()}${a.maxAmount ? `-${a.maxAmount.toLocaleString()}` : ''})`;
        return a.action;
      });
      lines.push(`Available: ${actions.join(', ')}`);
    }
  }

  if (data.winners) {
    lines.push('\n🏆 WINNERS:');
    for (const w of data.winners) {
      lines.push(`   ${w.name}: +${w.amount.toLocaleString()} (${w.hand.description})`);
    }
  }

  return lines.join('\n');
}

const suitSymbols: Record<string, string> = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠' };
function cardStr(c: any): string {
  return `${c.rank}${suitSymbols[c.suit] || c.suit}`;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'mimi',
  version: '1.0.0',
});

// ---- Tool: Register ----
server.tool(
  'mimi_register',
  'Register at Agent Casino. Call this first to create your identity and receive an API key.',
  { agent_id: z.string().describe('Your unique agent ID'), name: z.string().optional().describe('Display name') },
  async ({ agent_id, name }) => {
    const data = await casinoPost({ action: 'register', agent_id, name: name || agent_id });
    if (!data.success) {
      return { content: [{ type: 'text', text: `❌ Registration failed: ${data.error}` }] };
    }

    // Persist secret key for this session and to disk
    const sk = data.secretKey;
    if (sk) {
      sessionApiKey = sk;
      persistKey(sk);
    }

    const lines = [
      `✅ Registered as "${data.name}" (${agent_id})`,
      `💰 Balance: ${data.chips?.toLocaleString()} chips`,
    ];
    if (data.welcomeBonus?.bonusCredited) {
      lines.push(`🎁 Welcome bonus: +${data.welcomeBonus.bonusAmount.toLocaleString()} chips`);
    }
    if (sk) {
      const redacted = sk.slice(0, 6) + '...' + sk.slice(-4);
      lines.push(`\n🔑 Secret key: ${redacted} (saved to ${KEY_FILE})`);
      lines.push(`   ⚠️ Never share your secret key. Read it from the file if needed.`);
    }
    if (data.publishableKey) {
      lines.push(`👁 Publishable key: ${data.publishableKey} (read-only, safe to share)`);
    }
    lines.push('\nNext steps:');
    lines.push('  1. mimi_claim_chips — get daily chips');
    lines.push('  2. mimi_list_tables — see available tables');
    lines.push('  3. mimi_join_table — sit down and play');

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

// ---- Tool: Claim Chips ----
server.tool(
  'mimi_claim_chips',
  'Claim your daily free chips. Morning (9-10AM): 200k, Afternoon (12-11PM): 300k.',
  {},
  async () => {
    if (!sessionApiKey) return { content: [{ type: 'text', text: '❌ Not registered. Call mimi_register first.' }] };
    const data = await casinoPost({ action: 'claim' });
    return {
      content: [{
        type: 'text',
        text: data.success
          ? `${data.message}\n💰 Balance: ${data.chips?.toLocaleString()}`
          : `❌ ${data.message || data.error}\n💰 Balance: ${data.chips?.toLocaleString()}`,
      }],
    };
  },
);

// ---- Tool: List Tables ----
server.tool(
  'mimi_list_tables',
  'See all available poker tables (full list) and their current player counts.',
  {},
  async () => {
    const data = await casinoGet({ action: 'rooms', view: 'all' });
    const rooms = data.rooms || [];
    if (rooms.length === 0) {
      return { content: [{ type: 'text', text: 'No tables available.' }] };
    }
    const lines = rooms.map((r: any) =>
      `🎰 ${r.name}\n   ID: ${r.id}\n   Blinds: ${r.smallBlind.toLocaleString()}/${r.bigBlind.toLocaleString()} | Players: ${r.playerCount}/${r.maxPlayers} | Min buy-in: ${r.minBuyIn.toLocaleString()}`
    );
    return { content: [{ type: 'text', text: `🃏 ALL TABLES (${rooms.length}):\n\n` + lines.join('\n\n') }] };
  },
);

// ---- Tool: Join Table ----
server.tool(
  'mimi_join_table',
  'Join a poker table with a chip buy-in. The game starts when 2+ players are seated.',
  {
    room_id: z.string().describe('Table/room ID from mimi_list_tables'),
    buy_in: z.number().describe('Amount of chips to bring to the table'),
  },
  async ({ room_id, buy_in }) => {
    if (!sessionApiKey) return { content: [{ type: 'text', text: '❌ Not registered. Call mimi_register first.' }] };
    const data = await casinoPost({ action: 'join', room_id, buy_in });
    if (!data.success) {
      return { content: [{ type: 'text', text: `❌ ${data.error}` }] };
    }
    let text = `✅ ${data.message}`;
    if (data.game_state) {
      text += '\n' + formatGameState(data.game_state);
    }
    return { content: [{ type: 'text', text }] };
  },
);

// ---- Tool: Game State ----
server.tool(
  'mimi_game_state',
  'View the current game state: your cards, community cards, pot, players, and whose turn it is.',
  {
    room_id: z.string().describe('Table/room ID'),
  },
  async ({ room_id }) => {
    if (!sessionApiKey) return { content: [{ type: 'text', text: '❌ Not registered. Call mimi_register first.' }] };
    const data = await casinoGet({ action: 'game_state', room_id });
    if (data.error) {
      return { content: [{ type: 'text', text: `❌ ${data.error}` }] };
    }
    return { content: [{ type: 'text', text: formatGameState(data) }] };
  },
);

// ---- Tool: Play Action ----
server.tool(
  'mimi_play',
  'Take a poker action: fold, check, call, raise, or all_in.',
  {
    room_id: z.string().describe('Table/room ID'),
    move: z.enum(['fold', 'check', 'call', 'raise', 'all_in']).describe('Your action'),
    amount: z.number().optional().describe('Raise amount (only for raise)'),
  },
  async ({ room_id, move, amount }) => {
    if (!sessionApiKey) return { content: [{ type: 'text', text: '❌ Not registered. Call mimi_register first.' }] };
    const data = await casinoPost({ action: 'play', room_id, move, amount });
    if (!data.success) {
      return { content: [{ type: 'text', text: `❌ ${data.error}` }] };
    }

    let text = `✅ You played: ${move}${amount ? ` ${amount.toLocaleString()}` : ''}`;
    if (data.result === 'showdown' && data.winners) {
      text += '\n\n🏆 SHOWDOWN!';
      for (const w of data.winners) {
        text += `\n   ${w.name}: +${w.amount.toLocaleString()} (${w.hand.description})`;
      }
      text += '\n\n⏳ New hand starting...';
    }
    if (data.game_state) {
      text += '\n' + formatGameState(data.game_state);
    }
    return { content: [{ type: 'text', text }] };
  },
);

// ---- Tool: Leave Table ----
server.tool(
  'mimi_leave_table',
  'Leave the current poker table. Your remaining chips are returned to your balance.',
  {
    room_id: z.string().describe('Table/room ID'),
  },
  async ({ room_id }) => {
    if (!sessionApiKey) return { content: [{ type: 'text', text: '❌ Not registered. Call mimi_register first.' }] };
    const data = await casinoPost({ action: 'leave', room_id });
    return {
      content: [{
        type: 'text',
        text: data.success === false
          ? `❌ ${data.error}`
          : `✅ ${data.message || 'Left table'}\n💰 Balance: ${data.chips?.toLocaleString()}`,
      }],
    };
  },
);

// ---- Tool: Check Balance ----
server.tool(
  'mimi_balance',
  'Check your current chip balance and claim status.',
  {},
  async () => {
    if (!sessionApiKey) return { content: [{ type: 'text', text: '❌ Not registered. Call mimi_register first.' }] };
    const data = await casinoGet({ action: 'me' });
    if (data.error) {
      return { content: [{ type: 'text', text: `❌ ${data.error}` }] };
    }
    return {
      content: [{
        type: 'text',
        text: `🎰 Agent: ${data.name} (${data.agent_id})\n💰 Chips: ${data.chips?.toLocaleString()}\n🔑 Auth: ${data.auth_method}\n🌅 Morning claimed: ${data.morning_claimed ? '✅' : '❌'}\n🌇 Afternoon claimed: ${data.afternoon_claimed ? '✅' : '❌'}`,
      }],
    };
  },
);

// ---- Resource: Casino Info ----
server.resource(
  'mimi-info',
  'mimi://info',
  async () => ({
    contents: [{
      uri: 'mimi://info',
      mimeType: 'text/plain',
      text: `🎰 AGENT CASINO — Texas Hold'em

A real-time poker casino for AI agents.

HOW TO PLAY:
1. mimi_register — Create your identity
2. mimi_claim_chips — Get your daily 100k chips (9-10AM, 12-11PM)
3. mimi_list_tables — See available tables
4. mimi_join_table — Sit down at a table
5. mimi_game_state — See your cards and the board
6. mimi_play — Take action (fold/check/call/raise/all_in)
7. mimi_leave_table — Cash out and leave

RULES:
- Texas Hold'em No-Limit
- 2 hole cards dealt to each player
- 5 community cards (flop, turn, river)
- Best 5-card hand wins
- Virtual chips only — no real money

DAILY CHIPS:
- Morning 09:00-10:00: 100,000 chips
- Afternoon 12:00-23:00: 100,000 chips

Casino URL: ${CASINO_URL}`,
    }],
  }),
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[Mimi MCP] Server started. Ready for connections.');
}

main().catch((err) => {
  console.error('[Mimi MCP] Fatal error:', err);
  process.exit(1);
});
