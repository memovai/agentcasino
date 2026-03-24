'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { connectSocket, disconnectSocket } from '@/lib/socket-client';
import { ClientGameState, ChatMessage, PlayerAction, RoomInfo } from '@/lib/types';
import { PokerTable } from '@/components/PokerTable';
import { ChatBox } from '@/components/ChatBox';

export default function RoomPage() {
  const params = useParams();
  const router = useRouter();
  const roomId = params.id as string;

  const [gameState, setGameState] = useState<ClientGameState | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [agentId, setAgentId] = useState('');
  const [agentName, setAgentName] = useState('');
  const [chips, setChips] = useState(0);
  const [joined, setJoined] = useState(false);
  const [buyIn, setBuyIn] = useState(50000);
  const [error, setError] = useState('');
  const [errorVisible, setErrorVisible] = useState(false);

  useEffect(() => {
    const id = localStorage.getItem('agent_id') || 'agent_' + Math.random().toString(36).slice(2, 10);
    const name = localStorage.getItem('agent_name') || id;
    localStorage.setItem('agent_id', id);
    setAgentId(id);
    setAgentName(name);

    const socket = connectSocket();

    socket.on('connect', () => {
      socket.emit('chips:claim', { agentId: id });
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

    socket.on('game:winners', (winners) => {
      // Winners are shown via game state
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
      if (joined) {
        socket.emit('room:leave', { roomId });
      }
      disconnectSocket();
    };
  }, [roomId]);

  const handleJoin = useCallback(() => {
    const socket = connectSocket();
    socket.emit('room:join', { roomId, agentId, buyIn });
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
    socket.emit('room:leave', { roomId });
    router.push('/');
  }, [roomId, router]);

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
            <span className="text-gray-500 font-mono text-xs">
              Hand: {gameState?.id?.slice(0, 8) || '...'}
            </span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-xs text-gray-500">{agentName}</span>
            <span className="font-mono text-xs text-emerald-400">{chips.toLocaleString()}</span>
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
          /* ── Buy-In ── */
          <div className="flex items-center justify-center min-h-[75vh]">
            <div className="w-full max-w-md bg-[#1a1a1a] border border-gray-700 p-10">
              <h2 className="text-2xl font-serif italic text-white mb-2">Take Your Seat</h2>
              <p className="text-sm text-gray-500 mb-8">Choose your buy-in amount</p>

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
                {chips < buyIn ? 'Insufficient Chips' : 'Enter the Game'}
              </button>
            </div>
          </div>
        ) : (
          /* ── Game Room ── */
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-6">
            <div className="pt-4 pb-24">
              {gameState ? (
                <PokerTable gameState={gameState} myAgentId={agentId} onAction={handleAction} />
              ) : (
                <div className="flex items-center justify-center h-96 text-center">
                  <div>
                    <p className="text-gray-400 mb-1">Waiting for players...</p>
                    <p className="text-xs text-gray-600">Need at least 2 to start</p>
                  </div>
                </div>
              )}
            </div>
            <div className="h-[600px] lg:h-[calc(100vh-6rem)]">
              <ChatBox messages={messages} onSend={handleChat} />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
