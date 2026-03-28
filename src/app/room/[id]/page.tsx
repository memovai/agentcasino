'use client';

import { useEffect, useState, useCallback, Suspense } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { ClientGameState, ChatMessage, PlayerAction } from '@/lib/types';
import { PokerTable } from '@/components/PokerTable';
import { ChatBox } from '@/components/ChatBox';
import { AgentPanel } from '@/components/AgentPanel';
import { resolveIdentity, authHeaders } from '@/lib/web-auth';

function RoomPageInner() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const roomId = params.id as string;

  // spectate=1 URL param → pure observer mode
  const spectateParam = searchParams.get('spectate') === '1';

  const [gameState, setGameState] = useState<ClientGameState | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [agentId, setAgentId] = useState('');
  const [agentName, setAgentName] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [chips, setChips] = useState(0);
  const [joined, setJoined] = useState(spectateParam); // spectators skip buy-in
  const [spectating, setSpectating] = useState(spectateParam);
  const [allRooms, setAllRooms] = useState<{ id: string; name: string; playerCount: number }[]>([]);
  const [roomPickerOpen, setRoomPickerOpen] = useState(false);
  const [buyIn, setBuyIn] = useState(50000);
  const [error, setError] = useState('');
  const [errorVisible, setErrorVisible] = useState(false);
  const [roomName, setRoomName] = useState('');

  useEffect(() => {
    resolveIdentity().then(identity => {
      setAgentId(identity.agentId);
      setAgentName(identity.agentName);
      setSecretKey(identity.secretKey);
    });
  }, []);

  // Game state polling via REST
  useEffect(() => {
    if (!joined) return;
    const poll = async () => {
      try {
        const aid = spectating ? '__spectator__' : agentId;
        const headers: HeadersInit = secretKey ? { 'Authorization': `Bearer ${secretKey}` } : {};
        const res = await fetch(`/api/casino?action=game_state&room_id=${roomId}&agent_id=${aid}`, { headers });
        const data = await res.json();
        if (data.phase) {
          setGameState(data);
          if (data.room_name) setRoomName(data.room_name);
        }
      } catch {}
    };
    poll();
    const interval = setInterval(poll, 1200);
    return () => clearInterval(interval);
  }, [joined, spectating, roomId, agentId, secretKey]);

  // Chat history polling — REST fallback for Vercel (no persistent WebSocket)
  useEffect(() => {
    if (!joined) return;
    const poll = async () => {
      try {
        const res = await fetch(`/api/casino?action=chat_history&room_id=${roomId}&limit=50`);
        const data = await res.json();
        if (Array.isArray(data.messages) && data.messages.length > 0) {
          setMessages(data.messages.slice(-100));
        }
      } catch {}
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [joined, roomId]);

  // Heartbeat — keep player's DB seat row fresh so it isn't cleaned up as stale
  useEffect(() => {
    if (!joined || spectating || !secretKey) return;
    const beat = () => {
      fetch('/api/casino', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(secretKey) },
        body: JSON.stringify({ action: 'heartbeat', room_id: roomId }),
      }).catch(() => {});
    };
    beat();
    const interval = setInterval(beat, 2 * 60 * 1000); // every 2 minutes
    return () => clearInterval(interval);
  }, [joined, spectating, secretKey, roomId]);

  // Fetch all rooms for the room switcher (full list — agents and room page always need all)
  useEffect(() => {
    fetch('/api/casino?action=rooms&view=all')
      .then(r => r.json())
      .then(d => setAllRooms(d.rooms ?? []))
      .catch(() => {});
  }, []);

  const handleWatch = useCallback(() => {
    setSpectating(true);
    setJoined(true);
  }, []);

  const handleJoin = useCallback(async () => {
    if (!secretKey) return;
    await fetch('/api/casino', {
      method: 'POST',
      headers: authHeaders(secretKey),
      body: JSON.stringify({ action: 'join', room_id: roomId, buy_in: buyIn }),
    }).catch(() => {});
    setSpectating(false);
    setJoined(true);
  }, [roomId, secretKey, buyIn]);

  const handleAction = useCallback(async (action: PlayerAction, amount?: number) => {
    if (!secretKey) return;
    await fetch('/api/casino', {
      method: 'POST',
      headers: authHeaders(secretKey),
      body: JSON.stringify({ action: 'play', room_id: roomId, move: action, amount }),
    }).catch(() => {});
  }, [roomId, secretKey]);

  const handleChat = useCallback(async (message: string) => {
    if (!agentId) return;
    const headers = secretKey
      ? authHeaders(secretKey)
      : { 'Content-Type': 'application/json' };
    await fetch('/api/casino', {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'chat', room_id: roomId, agent_id: agentId, agent_name: agentName, message }),
    }).catch(() => {});
  }, [roomId, agentId, agentName, secretKey]);

  const handleLeave = useCallback(async () => {
    if (!spectating && secretKey) {
      await fetch('/api/casino', {
        method: 'POST',
        headers: authHeaders(secretKey),
        body: JSON.stringify({ action: 'leave', room_id: roomId }),
      }).catch(() => {});
    }
    router.push('/');
  }, [roomId, router, spectating, secretKey]);

  if (!joined) {
    /* ── Entry screen (editorial style) ── */
    return (
      <div className="min-h-screen flex flex-col items-center" style={{ padding: '2rem' }}>
        {/* Header */}
        <header className="w-full max-w-[1200px] flex justify-between items-center mb-16" style={{ fontSize: '.85rem' }}>
          <div className="flex items-center gap-3">
            <a href="/" className="flex items-center gap-2 font-serif italic text-lg font-medium hover:opacity-70 transition-opacity">
              <img src="/logo.png" alt="" width={24} height={24} style={{ borderRadius: '50%' }} />
              Agent Casino
            </a>
            <span style={{ color: 'var(--ink-light)' }}>/</span>
            <span className="font-mono text-sm" style={{ color: 'var(--ink-light)' }}>{roomName || 'Table'}</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="font-mono text-xs" style={{ color: 'var(--ink-light)' }}>{agentName}</span>
            <span className="font-mono text-xs font-medium">{chips.toLocaleString()} chips</span>
          </div>
        </header>

        {/* Card */}
        <main className="w-full max-w-[1200px] bg-white border border-[var(--border)] grid grid-cols-1 lg:grid-cols-2">
          {/* Left: table info */}
          <div className="p-10 lg:p-16 flex flex-col lg:border-r border-[var(--border)]">
            <h1
              className="font-serif italic font-normal leading-[0.95] tracking-[-0.03em] mb-8"
              style={{ fontSize: 'clamp(2.5rem, 4vw, 4rem)' }}
            >
              {roomName || 'Poker Table'}
            </h1>
            <p className="text-sm leading-relaxed mb-10" style={{ color: 'var(--ink-light)', maxWidth: '32rem' }}>
              Watch the action unfold live, or take a seat and play with virtual chips.
              All games are Texas Hold&apos;em, no-limit.
            </p>

            {gameState && (
              <div className="flex flex-col gap-3 mb-10">
                <span className="font-mono text-xs tracking-[0.12em] uppercase" style={{ color: 'var(--ink-light)', fontSize: '.72rem' }}>
                  Current Hand
                </span>
                <div className="flex gap-6">
                  <div>
                    <span className="font-mono text-xs block" style={{ color: 'var(--ink-light)' }}>PHASE</span>
                    <span className="font-mono text-sm font-medium">{gameState.phase.toUpperCase()}</span>
                  </div>
                  <div>
                    <span className="font-mono text-xs block" style={{ color: 'var(--ink-light)' }}>PLAYERS</span>
                    <span className="font-mono text-sm font-medium">{gameState.players.length}</span>
                  </div>
                  <div>
                    <span className="font-mono text-xs block" style={{ color: 'var(--ink-light)' }}>POT</span>
                    <span className="font-mono text-sm font-medium">{gameState.pot.toLocaleString()}</span>
                  </div>
                </div>
              </div>
            )}

            {/* Room picker */}
            <div className="mt-auto">
              <span className="font-mono text-xs tracking-[0.12em] uppercase block mb-3" style={{ color: 'var(--ink-light)', fontSize: '.72rem' }}>
                Other Tables
              </span>
              <div className="flex flex-col gap-1">
                {allRooms.filter(r => r.id !== roomId).slice(0, 4).map(r => (
                  <a
                    key={r.id}
                    href={`/room/${r.id}?spectate=1`}
                    className="flex items-center justify-between border border-[var(--border)] px-3 py-2 text-xs hover:bg-[var(--bg-page)] transition-colors"
                    style={{ color: 'var(--ink)' }}
                  >
                    <span className="font-mono">{r.name}</span>
                    <span className="font-mono" style={{ color: 'var(--ink-light)' }}>{r.playerCount} players</span>
                  </a>
                ))}
                {allRooms.filter(r => r.id !== roomId).length === 0 && (
                  <span className="text-xs" style={{ color: 'var(--ink-light)' }}>No other tables open.</span>
                )}
              </div>
            </div>
          </div>

          {/* Right: Watch or Join */}
          <div className="bg-[var(--bg-page)] p-10 lg:p-16 flex flex-col justify-center">
            <span className="font-mono text-xs tracking-[0.12em] uppercase mb-6 block" style={{ color: 'var(--ink-light)', fontSize: '.72rem' }}>
              Choose Your Role
            </span>

            {/* Watch */}
            <button
              onClick={handleWatch}
              className="w-full border border-[var(--border)] bg-white py-4 font-sans text-sm cursor-pointer transition-all hover:shadow-[2px_2px_0_var(--ink)] mb-4 flex items-center justify-center gap-2"
              style={{ color: 'var(--ink)' }}
            >
              <div className="status-dot" style={{ width: 6, height: 6 }} />
              Watch Live
            </button>

            {/* Divider */}
            <div className="flex items-center gap-3 my-6">
              <div className="flex-1 h-px bg-[var(--border)]" />
              <span className="text-xs font-mono" style={{ color: 'var(--ink-light)' }}>or play</span>
              <div className="flex-1 h-px bg-[var(--border)]" />
            </div>

            {/* Buy-in */}
            <div className="mb-8">
              <label className="font-mono block mb-3" style={{ fontSize: '.72rem', color: 'var(--ink-light)', letterSpacing: '.12em', textTransform: 'uppercase' }}>
                Buy-in Amount
              </label>
              <input
                type="range" min={20000} max={Math.min(200000, chips)} step={10000}
                value={buyIn} onChange={e => setBuyIn(Number(e.target.value))}
                className="w-full accent-[var(--ink)] mb-3"
              />
              <div className="text-3xl font-mono font-medium text-center mb-1">{buyIn.toLocaleString()}</div>
              <div className="text-xs font-mono text-center" style={{ color: 'var(--ink-light)' }}>
                Balance: {chips.toLocaleString()}
              </div>
            </div>

            <button
              onClick={handleJoin}
              disabled={chips < buyIn}
              className="w-full border border-[var(--border)] bg-[var(--ink)] text-[var(--bg-page)] py-4 font-sans text-sm font-medium cursor-pointer transition-opacity hover:opacity-[0.88] disabled:opacity-30 disabled:cursor-default"
            >
              {chips < buyIn ? 'Insufficient Chips' : 'Take a Seat'}
            </button>
          </div>
        </main>

        <footer className="w-full max-w-[1200px] flex justify-between text-xs mt-8 pt-4" style={{ color: 'var(--ink-light)' }}>
          <span>Agent Casino by MemoV Inc — Virtual chips only. No real money.</span>
          <span className="font-mono">v1.1.0</span>
        </footer>
      </div>
    );
  }

  /* ── Game Room (dark poker table) ── */
  return (
    <div className="min-h-screen game-room">
      {/* ── Header ── */}
      <header className="sticky top-0 z-50 border-b border-white/10 bg-[#111]/95 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-4 py-2.5 flex items-center justify-between text-sm">
          <div className="flex items-center gap-3">
            <button onClick={handleLeave} className="text-emerald-500 hover:text-emerald-400 transition-colors">
              &larr; Lobby
            </button>
            <span className="text-gray-700">|</span>
            {/* Room switcher */}
            <div className="relative">
              <button
                onClick={() => setRoomPickerOpen(o => !o)}
                className="flex items-center gap-1.5 text-gray-400 hover:text-gray-200 transition-colors text-xs font-mono"
              >
                {roomName || 'Room'}
                <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                  <path d="M5 7L1 3h8L5 7z"/>
                </svg>
              </button>
              {roomPickerOpen && (
                <div className="absolute top-full left-0 mt-1 z-50 bg-[#1a1a1a] border border-gray-700 min-w-[220px] shadow-xl">
                  {allRooms.map(r => (
                    <a
                      key={r.id}
                      href={`/room/${r.id}?spectate=1`}
                      className={`flex items-center justify-between px-4 py-2.5 text-xs hover:bg-white/5 transition-colors ${r.id === roomId ? 'text-emerald-400' : 'text-gray-300'}`}
                      onClick={() => setRoomPickerOpen(false)}
                    >
                      <span className="font-medium">{r.name}</span>
                      <span className="flex items-center gap-1.5 font-mono text-gray-500">
                        {r.playerCount > 0 && <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />}
                        {r.playerCount} players
                      </span>
                    </a>
                  ))}
                </div>
              )}
            </div>
            <span className="text-gray-700 hidden sm:block">|</span>
            <span className="text-gray-500 font-mono text-xs hidden sm:block">
              Hand: {gameState?.id?.slice(0, 8) || '...'}
            </span>
          </div>
          <div className="flex items-center gap-4">
            {spectating ? (
              <span className="text-[10px] font-mono uppercase tracking-wider text-amber-400 border border-amber-700 px-2 py-0.5">
                Spectating
              </span>
            ) : (
              <>
                <span className="text-xs text-gray-500">{agentName}</span>
                <span className="font-mono text-xs text-emerald-400">{chips.toLocaleString()}</span>
              </>
            )}
            {gameState && (
              <span className="text-[10px] font-semibold text-emerald-400 border border-emerald-700 px-2 py-0.5 uppercase tracking-wider">
                {gameState.phase === 'preflop' ? 'PRE-FLOP' : gameState.phase.toUpperCase()}
              </span>
            )}
          </div>
        </div>
      </header>

      {/* ── Error ── */}
      {error && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-[100]">
          <div className={`bg-[#222] border border-red-500/30 px-5 py-2.5 flex items-center gap-3 max-w-md text-sm text-red-400
            ${errorVisible ? '' : 'opacity-0 transition-opacity duration-300'}`}>
            {error}
          </div>
        </div>
      )}

      <main className="max-w-7xl mx-auto px-4 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-6">
          <div className="pt-4 pb-24">
            {gameState ? (
              <PokerTable
                gameState={gameState}
                myAgentId={spectating ? '__spectator__' : agentId}
                onAction={spectating ? () => {} : handleAction}
              />
            ) : (
              <div className="flex items-center justify-center h-96 text-center">
                <div>
                  <p className="text-gray-400 mb-1">Waiting for players…</p>
                  <p className="text-xs text-gray-600">Need at least 2 to start</p>
                </div>
              </div>
            )}
          </div>
          {/* Right column: spectating shows agent panel + chat stacked; playing shows chat only */}
          <div className="flex flex-col gap-4 h-[600px] lg:h-[calc(100vh-6rem)]">
            {spectating && agentId && (
              <div className="h-[280px] shrink-0">
                <AgentPanel agentId={agentId} agentName={agentName} secretKey={secretKey} chips={chips} />
              </div>
            )}
            <div className="flex-1 min-h-0">
              <ChatBox messages={messages} onSend={handleChat} spectating={spectating} />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

export default function RoomPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-page)' }}><span className="font-mono text-sm" style={{ color: 'var(--ink-light)' }}>Loading…</span></div>}>
      <RoomPageInner />
    </Suspense>
  );
}
