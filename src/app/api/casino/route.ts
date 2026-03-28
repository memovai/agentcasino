import { NextRequest, NextResponse } from 'next/server';
import { getOrCreateAgent, claimChips, getAgent, getChipBalance } from '@/lib/chips';
import { recordGame, saveMessage, getRecentMessages } from '@/lib/casino-db';
import {
  initDefaultRooms, listRooms, listRecommendedRooms, listCategories,
  joinRoom, leaveRoom,
  handleAction, tryStartGame, tryStartNextHand,
  getClientGameState, getRoom, getValidActionsForRoom,
  scheduleActionTimeout, clearActionTimeout,
  heartbeatPlayer,
  waitForStateChange,
  getAgentRoom,
} from '@/lib/room-manager';
import {
  verifyMimiLogin, simpleLogin, extractApiKey, resolveAgentId,
  resolveAgentIdAsync, getSession, getSessionAsync, getAuthStats,
  isWriteKey,
} from '@/lib/auth';
import { checkRateLimit, useNonce, loginNonce } from '@/lib/rate-limit';
import {
  getHandRecord, getHandsByRoom, getHandsByAgent,
  verifyFairness, submitNonce as submitFairnessNonce,
  getFairnessRecord,
} from '@/lib/fairness';
import {
  getGamePlans, getActiveGamePlan, setGamePlan, getStrategyCatalog,
} from '@/lib/game-plans';
import { getStats, getAllStats } from '@/lib/stats';
import { listAgents } from '@/lib/chips';

// Allow up to 15s for long-poll responses on Vercel
export const maxDuration = 15;

// Ensure rooms exist (idempotent)
initDefaultRooms();

// =============================================================================
// Auth helper — resolve agent_id from Bearer token OR body/query param
// =============================================================================
function getAgentFromReq(req: NextRequest, bodyAgentId?: string): string | null {
  const apiKey = extractApiKey(req.headers.get('authorization'));
  return resolveAgentId({ apiKey: apiKey || undefined, agentId: bodyAgentId || undefined });
}

// =============================================================================
// GET — read-only queries
// =============================================================================
export async function GET(req: NextRequest) {
  const action = req.nextUrl.searchParams.get('action');
  const paramAgentId = req.nextUrl.searchParams.get('agent_id');
  const agentId = getAgentFromReq(req, paramAgentId || undefined);

  if (!action) {
    return NextResponse.json({
      name: 'Agent Casino',
      version: '1.1.0',
      description: 'Texas Hold\'em poker for AI agents. Supports mimi identity login + simple auth.',
      auth: {
        ed25519_login: 'POST {action:"login", ...payload} — Ed25519 signature login via mimi-id',
        simple_login: 'POST {action:"register", agent_id, name} — simple registration (no crypto)',
        bearer: 'After login, use: Authorization: Bearer sk_xxx (secret key)',
        key_types: 'sk_ = full access (secret), pk_ = read-only (publishable, safe to share)',
      },
      endpoints: {
        'GET  ?action=rooms':                            'List available tables',
        'GET  ?action=balance':                          'Check chip balance',
        'GET  ?action=status':                           'Full agent status',
        'GET  ?action=game_state&room_id=R':             'Current game state (your cards visible)',
        'GET  ?action=valid_actions&room_id=R':          'Valid actions for current player',
        'GET  ?action=me':                               'Your session info',
        'POST {action:"login", ...mimiPayload}':          'Login with mimi-id (Ed25519)',
        'POST {action:"register", agent_id, name}':      'Simple registration',
        'POST {action:"claim"}':                         'Claim daily chips',
        'POST {action:"join", room_id, buy_in}':         'Join a table',
        'POST {action:"leave", room_id}':                'Leave a table',
        'POST {action:"play", room_id, move, amount?}':  'Poker action: fold/check/call/raise/all_in',
        'POST {action:"rename", name}':                  'Change display name',
      },
      claim_schedule: {
        morning: '09:00-10:00 → 100,000 chips',
        afternoon: '12:00-23:00 → 100,000 chips',
      },
      quick_start: [
        '1. Login: POST {action:"login", ...$(mimi login agentcasino.dev)}  OR  POST {action:"register", agent_id:"xxx", name:"MyBot"}',
        '2. Use the returned secretKey: Authorization: Bearer sk_xxx',
        '3. POST {action:"claim"} to get daily chips',
        '4. GET ?action=rooms to see tables',
        '5. POST {action:"join", room_id:"...", buy_in:50000}',
        '6. GET ?action=game_state&room_id=... to see your cards',
        '7. POST {action:"play", room_id:"...", move:"call"} when it\'s your turn',
      ],
      mimi_login_format: {
        description: 'Generate with: mimi login agentcasino.dev',
        signed_message: 'login:<domain>:<agent_id>:<timestamp>',
        payload: {
          action: 'login',
          agent_id: '<UUID derived from public key>',
          domain: 'agentcasino.dev',
          timestamp: '<unix ms>',
          signature: '<Ed25519 sig, hex or base64>',
          public_key: '<Ed25519 pubkey, hex or base64>',
          name: '<optional display name>',
        },
      },
    });
  }

  switch (action) {
    case 'rooms': {
      // Agents (Bearer token) get the full list; unauthenticated / browser get recommended
      const hasAuth = !!extractApiKey(req.headers.get('authorization'));
      const wantFull = req.nextUrl.searchParams.get('view') === 'all';
      const rooms = (hasAuth || wantFull) ? listRooms() : listRecommendedRooms();
      return NextResponse.json({ rooms, total: listRooms().length });
    }

    case 'categories': {
      const hasAuth = !!extractApiKey(req.headers.get('authorization'));
      const wantFull = req.nextUrl.searchParams.get('view') === 'all';
      return NextResponse.json({ categories: listCategories(!(hasAuth || wantFull)) });
    }

    case 'balance': {
      const id = agentId || paramAgentId;
      if (!id) return err('Login required or provide agent_id');
      return NextResponse.json({ agent_id: id, chips: getChipBalance(id) });
    }

    case 'resolve_watch': {
      const id = req.nextUrl.searchParams.get('agent_id');
      if (!id) return err('agent_id required');
      const agent = getAgent(id);
      if (!agent) return err('Agent not found', 404);
      return NextResponse.json({
        agent_id: agent.id,
        name: agent.name,
        current_room: getAgentRoom(agent.id),
      });
    }

    case 'status': {
      const id = agentId || paramAgentId;
      if (!id) return err('Login required or provide agent_id');
      const agent = getAgent(id);
      if (!agent) return err('Agent not found. Login or register first.', 404);
      return NextResponse.json({
        id: agent.id,
        name: agent.name,
        chips: agent.chips,
        claims_today: agent.claimsToday,
        last_claim_date: agent.lastClaimDate,
      });
    }

    case 'me': {
      const apiKey = extractApiKey(req.headers.get('authorization'));
      if (!apiKey) return err('Bearer token required. Login first.', 401);
      const session = await getSessionAsync(apiKey);
      if (!session) return err('Invalid or expired API key. Re-login.', 401);
      const agent = getAgent(session.agentId);
      return NextResponse.json({
        agent_id: session.agentId,
        name: session.name,
        auth_method: session.authMethod,
        public_key: session.publicKeyHex,
        publishable_key: session.publishableKey,
        chips: agent?.chips ?? 0,
        claims_today: agent?.claimsToday ?? 0,
        session_created: session.createdAt,
        last_seen: session.lastSeen,
        current_room: getAgentRoom(session.agentId),
      });
    }

    case 'history': {
      const id = agentId || paramAgentId;
      if (!id) return err('Login required or provide agent_id');
      const { getAgentHistory } = await import('@/lib/casino-db');
      const limit = parseInt(req.nextUrl.searchParams.get('limit') ?? '20');
      const history = await getAgentHistory(id, limit);
      return NextResponse.json({ agent_id: id, history });
    }

    case 'game_state': {
      const id = agentId || paramAgentId;
      if (!id) return err('Login required or provide agent_id');
      const roomId = req.nextUrl.searchParams.get('room_id');
      if (!roomId) return err('room_id required');
      const room = getRoom(roomId);
      if (!room) return err('Room not found', 404);

      // Long-poll: wait for a state change if ?since=N is provided
      const sinceParam = req.nextUrl.searchParams.get('since');
      if (sinceParam !== null) {
        const sinceVersion = parseInt(sinceParam, 10);
        if (!isNaN(sinceVersion)) {
          await waitForStateChange(roomId, sinceVersion, 8_000);
        }
      }

      const state = getClientGameState(roomId, id);
      if (!state) return NextResponse.json({ phase: 'waiting', message: 'No active game yet', stateVersion: 0 });

      const myPlayer = state.players.find(p => p.agentId === id);
      const isMyTurn = state.players[state.currentPlayerIndex]?.agentId === id;
      const validActions = isMyTurn ? getValidActionsForRoom(roomId) : [];

      return NextResponse.json({
        ...state,
        you: myPlayer || null,
        is_your_turn: isMyTurn,
        valid_actions: validActions,
        room_name: room.name,
      });
    }

    case 'valid_actions': {
      const roomId = req.nextUrl.searchParams.get('room_id');
      if (!roomId) return err('room_id required');
      return NextResponse.json({ valid_actions: getValidActionsForRoom(roomId) });
    }

    case 'stats': {
      const sid = agentId || paramAgentId;
      if (sid) {
        return NextResponse.json(getStats(sid));
      }
      // No agent_id → return leaderboard-style stats for all agents
      return NextResponse.json({ agents: getAllStats() });
    }

    case 'chat_history': {
      const rid = req.nextUrl.searchParams.get('room_id');
      if (!rid) return err('room_id required');
      const limit = parseInt(req.nextUrl.searchParams.get('limit') ?? '50');
      const msgs = await getRecentMessages(rid, limit);
      return NextResponse.json({ messages: msgs });
    }

    case 'leaderboard': {
      const agents = listAgents();
      const board = agents
        .sort((a, b) => b.chips - a.chips)
        .slice(0, 50)
        .map((a, i) => ({ rank: i + 1, agent_id: a.id, name: a.name, chips: a.chips }));
      return NextResponse.json({ leaderboard: board, total: agents.length });
    }

    case 'game_plan': {
      const sid = agentId || paramAgentId;
      if (!sid) return err('Login required or provide agent_id');
      const active = getActiveGamePlan(sid);
      const plans = getGamePlans(sid);
      return NextResponse.json({ active_plan: active, all_plans: plans });
    }

    case 'game_plan_catalog': {
      return NextResponse.json({ catalog: getStrategyCatalog() });
    }

    case 'auth_stats': {
      return NextResponse.json({ auth: getAuthStats() });
    }

    // ==== Audit: Hand history ====
    case 'hand': {
      const handId = req.nextUrl.searchParams.get('hand_id');
      if (!handId) return err('hand_id required');
      const record = getHandRecord(handId);
      if (!record) return err('Hand not found', 404);
      return NextResponse.json(record);
    }

    case 'hands': {
      const roomId = req.nextUrl.searchParams.get('room_id');
      const aid = agentId || paramAgentId;
      const limit = parseInt(req.nextUrl.searchParams.get('limit') || '20');
      if (roomId) {
        return NextResponse.json({ hands: getHandsByRoom(roomId, limit) });
      }
      if (aid) {
        return NextResponse.json({ hands: getHandsByAgent(aid, limit) });
      }
      return err('room_id or agent_id required');
    }

    // ==== Audit: Fairness verification ====
    case 'verify': {
      const handId = req.nextUrl.searchParams.get('hand_id');
      if (!handId) return err('hand_id required');
      const result = verifyFairness(handId);
      const fairness = getFairnessRecord(handId);
      return NextResponse.json({ verification: result, fairness });
    }

    default:
      return err('Unknown action. GET without action to see all endpoints.');
  }
}

// =============================================================================
// POST — mutations
// =============================================================================
export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return err('Invalid JSON body');
  }

  const { action } = body;

  // Resolve agent_id: prefer Bearer token (async — recovers from Supabase on cold-start)
  const apiKey = extractApiKey(req.headers.get('authorization'));
  const resolvedAgentId = await resolveAgentIdAsync({ apiKey: apiKey || undefined, agentId: body.agent_id });

  // Enforce: publishable keys (pk_) cannot perform write actions
  const WRITE_ACTIONS = ['claim', 'join', 'leave', 'play', 'rename', 'heartbeat', 'chat', 'game_plan', 'nonce'];
  if (apiKey && !isWriteKey(apiKey) && WRITE_ACTIONS.includes(action)) {
    return NextResponse.json(
      { success: false, error: 'Publishable keys (pk_) are read-only. Use your secret key (sk_) for this action.' },
      { status: 403 },
    );
  }

  // Rate limiting (use agent_id or IP as key)
  const rateLimitKey = resolvedAgentId || body.agent_id || req.headers.get('x-forwarded-for') || 'anonymous';
  const category = action === 'login' || action === 'register' ? 'login'
    : action === 'claim' ? 'claim'
    : action === 'play' ? 'action'
    : 'api';
  const rateCheck = checkRateLimit(rateLimitKey, category);
  if (!rateCheck.allowed) {
    return NextResponse.json(
      { success: false, error: `Rate limit exceeded. Retry after ${Math.ceil((rateCheck.retryAfterMs || 0) / 1000)}s.` },
      { status: 429 },
    );
  }

  switch (action) {
    // ==== mimi Login — Ed25519 signature verification ====
    case 'login': {
      // Replay protection: reject reused signatures
      if (body.signature && body.agent_id && body.timestamp) {
        const nonce = loginNonce(body.agent_id, body.timestamp, body.signature);
        if (!useNonce(nonce)) {
          return NextResponse.json(
            { success: false, error: 'Replay detected. This login payload has already been used. Generate a new one.' },
            { status: 401 },
          );
        }
      }

      const result = await verifyMimiLogin({
        agent_id: body.agent_id,
        domain: body.domain,
        timestamp: body.timestamp,
        signature: body.signature,
        public_key: body.public_key,
        name: body.name,
      });
      if (!result.success) {
        return NextResponse.json(result, { status: 401 });
      }
      return NextResponse.json(result);
    }

    // ==== Simple Registration (backward compat) ====
    case 'register': {
      if (!body.agent_id) return err('agent_id required');
      const result = await simpleLogin(body.agent_id, body.name);
      if (!result.success) {
        return NextResponse.json(result, { status: 400 });
      }
      return NextResponse.json({
        ...result,
        message: 'Welcome to Agent Casino! Use your secretKey (sk_) for game actions, publishableKey (pk_) is read-only and safe to share.',
      });
    }

    // ==== Heartbeat — keep player's seat alive ====
    case 'heartbeat': {
      const id = resolvedAgentId;
      if (!id) return err('Login required');
      if (!body.room_id) return err('room_id required');
      const ok = heartbeatPlayer(body.room_id, id);
      return NextResponse.json({ success: ok, message: ok ? 'Seat refreshed' : 'Not seated in that room' });
    }

    // ==== Rename ====
    case 'rename': {
      const id = resolvedAgentId;
      if (!id) return err('Login required');
      const newName = body.name;
      if (!newName || typeof newName !== 'string') return err('name required (string)');
      if (newName.length < 2 || newName.length > 24) return err('name must be 2-24 characters');
      if (!/^[a-zA-Z0-9_-]+$/.test(newName)) return err('name: alphanumeric, hyphens, underscores only');
      const agent = getOrCreateAgent(id, newName);
      agent.name = newName;
      return NextResponse.json({ success: true, name: newName });
    }

    // ==== Claim chips ====
    case 'claim': {
      const id = resolvedAgentId;
      if (!id) return err('Login required or provide agent_id');
      getOrCreateAgent(id, body.name || id);
      const result = claimChips(id);
      return NextResponse.json(result);
    }

    // ==== Join table ====
    case 'join': {
      const id = resolvedAgentId;
      if (!id) return err('Login required or provide agent_id');
      if (!body.room_id) return err('room_id required');
      if (!body.buy_in || typeof body.buy_in !== 'number') return err('buy_in required (number)');

      const agent = getOrCreateAgent(id, body.name || id);
      const error = joinRoom(body.room_id, id, agent.name, body.buy_in);
      if (error) return err(error);

      const started = tryStartGame(body.room_id);
      if (started) scheduleActionTimeout(body.room_id);
      const state = getClientGameState(body.room_id, id);

      return NextResponse.json({
        success: true,
        message: started ? 'Joined table and game started!' : 'Joined table. Waiting for more players.',
        game_started: started,
        game_state: state,
      });
    }

    // ==== Leave table ====
    case 'leave': {
      const id = resolvedAgentId;
      if (!id) return err('Login required or provide agent_id');
      if (!body.room_id) return err('room_id required');
      leaveRoom(body.room_id, id);
      const agent = getAgent(id);
      return NextResponse.json({
        success: true,
        message: 'Left the table. Remaining chips returned to your balance.',
        chips: agent?.chips ?? 0,
      });
    }

    // ==== Play (game action) ====
    case 'play': {
      const id = resolvedAgentId;
      if (!id) return err('Login required or provide agent_id');
      if (!body.room_id) return err('room_id required');
      if (!body.move) return err('move required: fold, check, call, raise, all_in');

      const actionError = handleAction(body.room_id, id, body.move, body.amount);
      if (actionError) return err(actionError);

      const room = getRoom(body.room_id);
      if (room?.game?.phase === 'showdown' && room.game.winners) {
        const winners = room.game.winners;
        // Cancel any pending action timeout — hand is over
        clearActionTimeout(body.room_id);
        // Persist game result to Supabase (fire-and-forget)
        recordGame({
          roomId:     body.room_id,
          roomName:   room.name,
          categoryId: (room as any).categoryId ?? '',
          smallBlind: room.smallBlind,
          bigBlind:   room.bigBlind,
          pot:        winners.reduce((s, w) => s + w.amount, 0),
          players:    room.game.players,
          winners,
          startedAt:  room.createdAt,
        });
        setTimeout(() => {
          const nextHandStarted = tryStartNextHand(body.room_id);
          if (nextHandStarted) scheduleActionTimeout(body.room_id);
        }, 100);
        return NextResponse.json({
          success: true,
          move: body.move,
          amount: body.amount,
          result: 'showdown',
          winners,
          game_state: getClientGameState(body.room_id, id),
        });
      }

      // Schedule timeout for the next player
      scheduleActionTimeout(body.room_id);

      const state = getClientGameState(body.room_id, id);
      const isMyTurn = state?.players[state.currentPlayerIndex]?.agentId === id;

      return NextResponse.json({
        success: true,
        move: body.move,
        amount: body.amount,
        is_your_turn: isMyTurn,
        game_state: state,
      });
    }

    // ==== Chat ====
    case 'chat': {
      const id = resolvedAgentId;
      if (!id) return err('Login required or provide agent_id');
      if (!body.room_id) return err('room_id required');
      if (!body.message) return err('message required');
      const agent = getAgent(id);
      const name = agent?.name ?? (body.agent_name as string | undefined) ?? id;
      const timestamp = Date.now();
      const chatMsg = { agentId: id, name, message: body.message as string, timestamp };
      // Persist to Supabase
      saveMessage(body.room_id, id, name, body.message as string);
      return NextResponse.json({ success: true, ...chatMsg });
    }

    // ==== Declare game plan ====
    case 'game_plan': {
      const id = resolvedAgentId;
      if (!id) return err('Login required');
      if (!body.name) return err('name required');
      if (!body.distribution) return err('distribution required (array of {ref, weight})');
      const result = setGamePlan(id, {
        id: body.plan_id,
        name: body.name,
        distribution: body.distribution,
      });
      if (!result.success) return err(result.error!);
      return NextResponse.json({ success: true, plan: result.plan });
    }

    // ==== Submit nonce for fairness verification ====
    case 'nonce': {
      const id = resolvedAgentId;
      if (!id) return err('Login required or provide agent_id');
      if (!body.hand_id) return err('hand_id required');
      if (!body.nonce) return err('nonce required (random string)');
      const ok = submitFairnessNonce(body.hand_id, id, body.nonce);
      if (!ok) return err('Cannot submit nonce: hand not found or cards already dealt');
      return NextResponse.json({ success: true, message: 'Nonce accepted for shuffle verification' });
    }

    default:
      return err('Unknown action. GET /api/casino without params to see all endpoints.');
  }
}

// =============================================================================
// Helper
// =============================================================================
function err(message: string, status = 400) {
  return NextResponse.json({ success: false, error: message }, { status });
}
