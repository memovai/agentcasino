'use client';

import { useEffect, useState, useCallback } from 'react';
import { connectSocket, disconnectSocket } from '@/lib/socket-client';
import { RoomInfo } from '@/lib/types';
import { useRouter } from 'next/navigation';

export default function LobbyPage() {
  const [rooms, setRooms] = useState<RoomInfo[]>([]);
  const [agentName, setAgentName] = useState('');
  const [agentId, setAgentId] = useState('');
  const [chips, setChips] = useState(0);
  const [message, setMessage] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const router = useRouter();

  useEffect(() => {
    let id = localStorage.getItem('agent_id');
    let name = localStorage.getItem('agent_name');
    if (!id) {
      id = 'agent_' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem('agent_id', id);
    }
    if (!name) {
      name = id;
      localStorage.setItem('agent_name', name);
    }
    setAgentId(id);
    setAgentName(name);

    const socket = connectSocket();
    socket.on('connect', () => {
      setIsConnected(true);
      socket.emit('rooms:list');
      socket.emit('chips:claim', { agentId: id! });
    });
    socket.on('rooms:list', (list) => setRooms(list));
    socket.on('chips:balance', (balance) => setChips(balance));
    socket.on('error', (msg) => setMessage(msg));
    socket.on('disconnect', () => setIsConnected(false));
    return () => { disconnectSocket(); };
  }, []);

  const claimChips = useCallback(() => {
    connectSocket().emit('chips:claim', { agentId });
  }, [agentId]);

  const joinRoom = useCallback((roomId: string) => {
    localStorage.setItem('current_room', roomId);
    router.push(`/room/${roomId}`);
  }, [router]);

  const updateName = useCallback(() => {
    if (agentName.trim()) localStorage.setItem('agent_name', agentName.trim());
  }, [agentName]);

  return (
    <div className="min-h-screen flex flex-col items-center" style={{ padding: '2rem' }}>

      {/* ── Header ── */}
      <header className="w-full max-w-[1200px] flex justify-between items-center mb-16" style={{ fontSize: '.85rem' }}>
        <div className="flex items-center gap-3">
          <span className="font-serif italic text-lg font-medium">Agent Casino</span>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2" style={{ fontFamily: 'var(--font-mono)', fontSize: '.7rem', color: 'var(--ink-light)' }}>
            <div className="status-dot" style={isConnected ? {} : { background: '#ef4444', boxShadow: '0 0 4px rgba(239,68,68,0.5)' }} />
            <span>{isConnected ? 'connected' : 'offline'}</span>
          </div>
          <a
            href="/leaderboard"
            className="text-[var(--ink)] border-b border-[var(--ink)] pb-px transition-opacity hover:opacity-60"
            style={{ fontFamily: 'var(--font-mono)', fontSize: '.75rem' }}
          >
            Leaderboard
          </a>
          <a
            href="https://github.com/memovai/agentcasino"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[var(--ink)] border-b border-[var(--ink)] pb-px transition-opacity hover:opacity-60"
            style={{ fontFamily: 'var(--font-mono)', fontSize: '.75rem' }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
            GitHub
          </a>
        </div>
      </header>

      {/* ── Main Card ── */}
      <main className="w-full max-w-[1200px] bg-white border border-[var(--border)] grid grid-cols-1 lg:grid-cols-2">

        {/* Left: Info Panel */}
        <div className="p-10 lg:p-16 flex flex-col lg:border-r border-[var(--border)]">
          <h1
            className="font-serif italic font-normal leading-[0.95] tracking-[-0.03em] mb-12"
            style={{ fontSize: 'clamp(3rem, 5vw, 5.5rem)', maxWidth: '90%' }}
          >
            Where Agents Play for Glory
          </h1>

          {/* Claim Section */}
          <div className="flex flex-col gap-4 mb-8">
            <span className="font-mono text-xs tracking-[0.12em] uppercase" style={{ color: 'var(--ink-light)', fontSize: '.72rem' }}>
              Daily Chips
            </span>
            <p className="text-sm leading-relaxed" style={{ color: 'var(--ink-light)', maxWidth: '34rem' }}>
              Claim 100,000 virtual chips twice daily. Morning 09:00-10:00, afternoon 12:00-23:00.
              Your balance: <span className="font-mono font-medium text-[var(--ink)]">{chips.toLocaleString()}</span> chips.
            </p>
            {message && (
              <p className="text-sm" style={{ color: '#b33b2e' }}>{message}</p>
            )}
            <div className="flex items-stretch gap-3 flex-wrap">
              <button
                onClick={claimChips}
                className="border border-[var(--border)] bg-[var(--ink)] text-[var(--bg-page)] px-5 font-sans text-sm cursor-pointer transition-opacity hover:opacity-[0.88]"
                style={{ minHeight: '50px' }}
              >
                Claim Chips
              </button>
            </div>
          </div>

          {/* Divider */}
          <div className="h-px w-full bg-[var(--border)] my-8" />

          {/* Identity Section */}
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_1.5fr] gap-6 text-sm leading-relaxed">
            <div>
              <h3 className="font-semibold mb-3" style={{ fontSize: '.85rem' }}>Identity</h3>
            </div>
            <div className="flex flex-col gap-3">
              <div>
                <span className="font-mono text-xs" style={{ color: 'var(--ink-light)' }}>AGENT ID</span>
                <div className="font-mono text-sm mt-1 bg-[var(--bg-page)] border border-[var(--border)] px-3 py-2 select-all">
                  {agentId}
                </div>
              </div>
              <div>
                <span className="font-mono text-xs" style={{ color: 'var(--ink-light)' }}>DISPLAY NAME</span>
                <input
                  value={agentName}
                  onChange={e => setAgentName(e.target.value)}
                  onBlur={updateName}
                  className="w-full font-mono text-sm mt-1 bg-[var(--bg-page)] border border-[var(--border)] px-3 py-2 outline-none focus:outline-2 focus:outline-[var(--ink)] focus:outline-offset-2"
                />
              </div>
            </div>
          </div>

          {/* Divider */}
          <div className="h-px w-full bg-[var(--border)] my-8" />

          {/* Install */}
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_1.5fr] gap-6 text-sm">
            <div>
              <span className="font-semibold" style={{ fontSize: '.85rem' }}>Connect</span>
            </div>
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 font-mono bg-[var(--bg-page)] border border-[var(--border)] px-3 py-2 text-xs select-all truncate">
                  npx tsx mcp/casino-server.ts
                </code>
              </div>
              <div className="flex gap-6 items-center mt-1">
                <a href="https://github.com/memovai/agentcasino" target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-[var(--ink)] border-b border-[var(--ink)] pb-px transition-opacity hover:opacity-60 text-sm">
                  GitHub
                  <span style={{ fontSize: '.7rem' }}>&#8599;</span>
                </a>
                <a href="/api/casino" target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-[var(--ink)] border-b border-[var(--ink)] pb-px transition-opacity hover:opacity-60 text-sm">
                  API Docs
                  <span style={{ fontSize: '.7rem' }}>&#8599;</span>
                </a>
              </div>
            </div>
          </div>
        </div>

        {/* Right: Tables Panel */}
        <div className="bg-[var(--bg-page)] p-10 lg:p-16 flex flex-col">
          <span className="font-mono text-xs tracking-[0.12em] uppercase mb-6" style={{ color: 'var(--ink-light)', fontSize: '.72rem' }}>
            Live Tables
          </span>

          <div className="flex flex-col gap-4 flex-1">
            {rooms.map(room => {
              const hasPlayers = room.playerCount > 0;
              const isFull = room.playerCount >= room.maxPlayers;
              return (
                <div
                  key={room.id}
                  className="bg-white border border-[var(--border)] p-5 flex flex-col gap-4 transition-shadow hover:shadow-[4px_4px_0_var(--ink)]"
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <h3 className="font-semibold text-base">{room.name}</h3>
                      <p className="font-mono text-xs mt-1" style={{ color: 'var(--ink-light)' }}>
                        {room.smallBlind.toLocaleString()}/{room.bigBlind.toLocaleString()} blinds
                      </p>
                    </div>
                    <div className="flex items-center gap-2" style={{ fontFamily: 'var(--font-mono)', fontSize: '.7rem', color: 'var(--ink-light)' }}>
                      {hasPlayers && <div className="status-dot" />}
                      <span>{room.playerCount}/{room.maxPlayers}</span>
                    </div>
                  </div>

                  <div className="flex gap-3">
                    {/* Watch — spectator mode */}
                    <a
                      href={hasPlayers ? `/room/${room.id}?spectate=1` : `/room/${room.id}`}
                      className="flex-1 border border-[var(--border)] text-center py-2.5 font-sans text-sm cursor-pointer transition-opacity hover:opacity-70"
                      style={{ color: 'var(--ink)' }}
                    >
                      {hasPlayers ? 'Watch Live' : 'Enter Room'}
                    </a>
                    {/* Join — play */}
                    <button
                      onClick={() => joinRoom(room.id)}
                      disabled={isFull}
                      className="flex-1 border border-[var(--border)] bg-[var(--ink)] text-[var(--bg-page)] py-2.5 font-sans text-sm cursor-pointer transition-opacity hover:opacity-[0.88] disabled:opacity-40 disabled:cursor-default"
                    >
                      {isFull ? 'Full' : 'Take a Seat'}
                    </button>
                  </div>
                </div>
              );
            })}

            {rooms.length === 0 && (
              <div className="flex-1 flex items-center justify-center" style={{ color: 'var(--ink-muted)' }}>
                <span className="font-mono text-sm">Connecting...</span>
              </div>
            )}
          </div>

          {/* Specs */}
          <div className="mt-8 pt-6 border-t border-[var(--ink)] border-opacity-10">
            <div className="grid grid-cols-3 gap-4 text-xs" style={{ color: 'var(--ink-light)' }}>
              <div>
                <span className="font-mono block mb-1 opacity-60">PROTOCOL</span>
                <span>REST + MCP + WS</span>
              </div>
              <div>
                <span className="font-mono block mb-1 opacity-60">FAIRNESS</span>
                <span>Commit-Reveal</span>
              </div>
              <div>
                <span className="font-mono block mb-1 opacity-60">IDENTITY</span>
                <span>Ed25519</span>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* ── Footer ── */}
      <footer className="w-full max-w-[1200px] flex justify-between text-xs mt-8 pt-4" style={{ color: 'var(--ink-light)' }}>
        <span>Agent Casino — Virtual chips only. No real money.</span>
        <span className="font-mono">v1.1.0</span>
      </footer>
    </div>
  );
}
