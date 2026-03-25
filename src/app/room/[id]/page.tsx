'use client';

import { useEffect, useState, useCallback, Suspense } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { connectSocket, disconnectSocket } from '@/lib/socket-client';
import { ClientGameState, ChatMessage, PlayerAction } from '@/lib/types';
import { PokerTable } from '@/components/PokerTable';
import { ChatBox } from '@/components/ChatBox';

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
    const id = localStorage.getItem('agent_id') || 'agent_' + Math.random().toString(36).slice(2, 10);
    const name = localStorage.getItem('agent_name') || id;
    localStorage.setItem('agent_id', id);
    setAgentId(id);
    setAgentName(name);

    const socket = connectSocket();

    socket.on('connect', () => {
      if (spectateParam) {
        // Join as spectator immediately
        socket.emit('room:watch', { roomId });
      } else {
        socket.emit('chips:claim', { agentId: id });
      }
    });

    socket.on('room:state', (room: any) => {
      if (room?.name) setRoomName(room.name);
    });

    socket.on('game:state', (state) => {
      setGameState(state);
    });

    socket.on('chat:message', (msg) => {
      setMessages(prev => [...prev.slice(-100), msg]);
    });

    socket.on('chips:balance', (balance) => {
      setChips(balance);
    });

    socket.on('error', (msg) => {
      setError(msg);
      setErrorVisible(true);
      setTimeout(() => {
        setErrorVisible(false);
        setTimeout(() => setError(''), 350);
      }, 4500);
    });

    return () => {
      if (joined && !spectating) {
        socket.emit('room:leave', { roomId });
      }
      disconnectSocket();
    };
  }, [roomId, spectateParam]);

  // Spectator polling — REST API fallback for REST-driven simulations
  useEffect(() => {
    if (!spectating) return;
    const poll = async () => {
      try {
        const res = await fetch(`/api/casino?action=game_state&room_id=${roomId}&agent_id=__spectator__`);
        const data = await res.json();
        if (data.phase && data.phase !== 'waiting') {
          setGameState(data);
          if (data.room_name) setRoomName(data.room_name);
        }
      } catch {}
    };
    poll(); // immediate first fetch
    const interval = setInterval(poll, 1200);
    return () => clearInterval(interval);
  }, [spectating, roomId]);

  // Fetch all rooms for the room switcher
  useEffect(() => {
    fetch('/api/casino?action=rooms')
      .then(r => r.json())
      .then(d => setAllRooms(d.rooms ?? []))
      .catch(() => {});
  }, []);

  const handleWatch = useCallback(() => {
    const socket = connectSocket();
    socket.emit('room:watch', { roomId });
    setSpectating(true);
    setJoined(true);
  }, [roomId]);

  const handleJoin = useCallback(() => {
    const socket = connectSocket();
    socket.emit('room:join', { roomId, agentId, buyIn });
    setSpectating(false);
    setJoined(true);
  }, [roomId, agentId, buyIn]);

  const handleAction = useCallback((action: PlayerAction, amount?: number) => {
    const socket = connectSocket();
    socket.emit('game:action', { roomId, action, amount });
  }, [roomId]);

  const handleChat = useCallback((message: string) => {
    const socket = connectSocket();
    socket.emit('chat:message', { roomId, message });
  }, [roomId]);

  const handleLeave = useCallback(() => {
    const socket = connectSocket();
    if (!spectating) socket.emit('room:leave', { roomId });
    router.push('/');
  }, [roomId, router, spectating]);

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
        {!joined ? (
          /* ── Lobby: Watch or Join ── */
          <div className="flex items-center justify-center min-h-[75vh]">
            <div className="w-full max-w-md bg-[#1a1a1a] border border-gray-700 p-10">
              <h2 className="text-2xl font-serif italic text-white mb-2">
                {roomName || 'Poker Table'}
              </h2>
              <p className="text-sm text-gray-500 mb-8">Watch the action or take a seat</p>

              {/* Watch button */}
              <button
                onClick={handleWatch}
                className="w-full border border-gray-600 text-gray-300 py-3 font-sans text-sm cursor-pointer transition-opacity hover:opacity-80 mb-4"
              >
                Watch Live
              </button>

              {/* Divider */}
              <div className="flex items-center gap-3 my-6">
                <div className="flex-1 h-px bg-gray-800" />
                <span className="text-gray-600 text-xs font-mono">or play</span>
                <div className="flex-1 h-px bg-gray-800" />
              </div>

              {/* Buy-in */}
              <div className="mb-8">
                <label className="font-mono text-[10px] uppercase tracking-[0.12em] text-gray-500 block mb-3">Buy-in</label>
                <input
                  type="range" min={20000} max={Math.min(200000, chips)} step={10000}
                  value={buyIn} onChange={e => setBuyIn(Number(e.target.value))}
                  className="w-full accent-emerald-500 mb-3"
                />
                <div className="text-3xl font-mono font-medium text-white text-center">{buyIn.toLocaleString()}</div>
                <div className="text-xs text-gray-600 text-center mt-2">Balance: {chips.toLocaleString()}</div>
              </div>

              <button
                onClick={handleJoin} disabled={chips < buyIn}
                className="w-full border border-white bg-white text-[#111] py-3 font-sans text-sm font-medium cursor-pointer transition-opacity hover:opacity-88 disabled:opacity-30 disabled:cursor-default"
              >
                {chips < buyIn ? 'Insufficient Chips' : 'Take a Seat'}
              </button>
            </div>
          </div>
        ) : (
          /* ── Game Room ── */
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
            <div className="h-[600px] lg:h-[calc(100vh-6rem)]">
              <ChatBox messages={messages} onSend={spectating ? undefined : handleChat} />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default function RoomPage() {
  return (
    <Suspense fallback={<div className="min-h-screen game-room flex items-center justify-center"><span className="text-gray-500 font-mono text-sm">Loading…</span></div>}>
      <RoomPageInner />
    </Suspense>
  );
}
