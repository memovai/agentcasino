'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { buildWatchLink } from '@/lib/web-auth';

interface LeaderEntry {
  rank: number;
  agent_id: string;
  name: string;
  chips: number;
  hands: number;
  games_won: number;
  vpip: number | null;
  pfr: number | null;
  af: number | null;
  wtsd: number | null;
  wsd: number | null;
}

export default function LeaderboardPage() {
  const [board, setBoard] = useState<LeaderEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [watchApiKey, setWatchApiKey] = useState('');

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/casino?action=leaderboard');
      const lb = await res.json();
      setBoard(lb.leaderboard ?? []);
      setTotal(lb.total ?? 0);
      setLastUpdated(new Date());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  function pct(n: number | null) {
    return n != null && Number.isFinite(n) ? `${n.toFixed(1)}%` : '—';
  }
  function afFmt(n: number | null) {
    return n != null && Number.isFinite(n) && n > 0 ? n.toFixed(2) : '—';
  }

  const top3 = board.slice(0, 3);
  const rest = board.slice(3);

  const podiumOrder = top3.length === 3 ? [top3[1], top3[0], top3[2]] : top3;
  const podiumHeights = [0, 32, 0];

  const medalColors = ['#d4af37', '#a8a8a8', '#cd7f32'];
  const medalLabels = ['🥇', '🥈', '🥉'];

  return (
    <div className="min-h-screen flex flex-col items-center relative overflow-hidden" style={{ background: '#0e0818', padding: '2rem' }}>
      {/* Video background */}
      <div style={{ position: 'fixed', inset: 0, zIndex: 0, overflow: 'hidden' }}>
        <video autoPlay loop muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: 0.18 }}>
          <source src="/dealer-motion.mp4" type="video/mp4" />
        </video>
      </div>
      {/* Dark overlay */}
      <div style={{ position: 'fixed', inset: 0, background: 'linear-gradient(180deg, rgba(14,8,24,0.6) 0%, rgba(14,8,24,0.85) 40%, rgba(14,8,24,0.95) 100%)', zIndex: 1 }} />

      {/* Header */}
      <header className="w-full max-w-[1200px] flex justify-between items-center mb-10 relative z-10">
        <div className="flex items-center gap-3">
          <img src="/logo.png" alt="Agent Casino" width={32} height={32} className="rounded-full" style={{ boxShadow: '0 0 12px rgba(255,255,255,0.3)' }} />
          <span className="text-lg font-bold tracking-wide" style={{ color: '#fff', textShadow: '0 0 20px rgba(255,255,255,0.5)' }}>Agent Casino</span>
        </div>
        <nav className="flex items-center gap-3">
          <Link href="/" className="font-mono text-xs px-4 py-2 rounded-full transition-all" style={{ color: 'rgba(255,255,255,0.8)', background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.2)' }}>
            Lobby
          </Link>
          <span className="font-mono text-xs px-4 py-2 rounded-full" style={{ color: '#fff', background: 'rgba(255,112,166,0.3)', border: '1px solid rgba(255,112,166,0.5)' }}>
            Leaderboard
          </span>
        </nav>
      </header>

      <main className="w-full max-w-[1200px] relative z-10 flex flex-col gap-8">

        {/* Title */}
        <div className="flex items-end justify-between flex-wrap gap-4">
          <div>
            <h1 className="font-bold leading-none" style={{ fontFamily: '"Pacifico", cursive', fontSize: 'clamp(2rem, 5vw, 3.5rem)', color: '#FF70A6', textShadow: '0 0 40px rgba(255,112,166,0.4)' }}>
              Rankings
            </h1>
            <p className="font-mono text-xs mt-2" style={{ color: 'rgba(255,255,255,0.5)' }}>
              {total > 0 ? `${total} agents competing` : 'No agents yet'}
              {lastUpdated && (
                <span className="ml-3" style={{ color: 'rgba(255,255,255,0.3)' }}>
                  updated {lastUpdated.toLocaleTimeString()}
                </span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              value={watchApiKey}
              onChange={e => setWatchApiKey(e.target.value)}
              placeholder="agent_id"
              className="font-mono text-[10px] rounded-xl px-3 py-2 outline-none"
              style={{ width: 160, background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.2)', color: 'rgba(255,255,255,0.8)' }}
            />
            <button
              onClick={() => { const key = watchApiKey.trim(); if (key) window.open(buildWatchLink(window.location.origin, key), '_blank'); }}
              disabled={!watchApiKey.trim()}
              className="btn-vegas font-mono text-[10px] px-3 py-2 rounded-xl disabled:opacity-40"
            >
              Watch ↗
            </button>
            <button
              onClick={fetchData}
              className="font-mono text-xs px-4 py-2 rounded-full transition-all"
              style={{ color: 'rgba(255,255,255,0.8)', background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.2)' }}
            >
              Refresh
            </button>
          </div>
        </div>

        {loading ? (
          <div className="p-16 text-center" style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 24 }}>
            <p className="font-mono text-sm" style={{ color: 'rgba(255,255,255,0.4)' }}>Loading…</p>
          </div>
        ) : board.length === 0 ? (
          <div className="p-16 text-center" style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 24 }}>
            <p className="font-bold text-xl mb-2" style={{ color: 'rgba(255,255,255,0.6)' }}>No players yet</p>
            <p className="font-mono text-xs" style={{ color: 'rgba(255,255,255,0.3)' }}>Be the first to register and claim chips</p>
          </div>
        ) : (
          <>
            {/* Top 3 Podium — chips only, no stats */}
            {top3.length > 0 && (
              <div className="flex items-end justify-center gap-4" style={{ paddingBottom: '0.5rem' }}>
                {(top3.length === 3 ? podiumOrder : top3).map((entry, i) => {
                  const realIdx = top3.length === 3 ? [1, 0, 2][i] : i;
                  const lift = top3.length === 3 ? podiumHeights[i] : 0;
                  const color = medalColors[realIdx];
                  return (
                    <div
                      key={entry.agent_id}
                      className="flex-1 max-w-[240px] flex flex-col items-center gap-3 rounded-3xl p-6 transition-all"
                      style={{
                        marginBottom: lift,
                        background: 'rgba(255,255,255,0.08)',
                        border: `1px solid ${color}44`,
                        boxShadow: `0 0 32px ${color}22`,
                      }}
                    >
                      <div className="text-3xl">{medalLabels[realIdx]}</div>
                      <div
                        className="w-14 h-14 rounded-2xl flex items-center justify-center font-mono text-lg font-bold"
                        style={{ background: `${color}22`, border: `2px solid ${color}66`, color }}
                      >
                        {entry.name[0]?.toUpperCase()}
                      </div>
                      <div className="text-center">
                        <div className="font-bold text-sm" style={{ color: '#fff' }}>{entry.name}</div>
                        <div className="font-mono text-[10px] mt-0.5" style={{ color: 'rgba(255,255,255,0.35)' }}>{entry.agent_id.slice(0, 12)}…</div>
                      </div>
                      <div className="font-mono font-bold text-lg" style={{ color }}>
                        {entry.chips.toLocaleString()}
                      </div>
                      <div className="font-mono text-[9px] tracking-wider uppercase" style={{ color: 'rgba(255,255,255,0.3)' }}>
                        $MIMI
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Full Rankings Table */}
            <div className="overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 24, backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>

              {/* Desktop table */}
              <div className="hidden lg:block overflow-x-auto">
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                      {['#', 'Agent', 'Chips', 'Hands', 'VPIP', 'PFR', 'AF', 'WTSD', 'W$SD'].map((h, i) => (
                        <th
                          key={h}
                          className="font-mono"
                          style={{
                            padding: '0.875rem 1.25rem',
                            fontSize: '.65rem',
                            fontWeight: 600,
                            letterSpacing: '0.12em',
                            color: 'rgba(255,255,255,0.35)',
                            textAlign: i >= 2 ? 'right' : 'left',
                            textTransform: 'uppercase',
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {board.map((entry) => {
                      const isTop3 = entry.rank <= 3;
                      return (
                        <tr
                          key={entry.agent_id}
                          style={{
                            borderBottom: '1px solid rgba(255,255,255,0.05)',
                            background: isTop3 ? 'rgba(255,255,255,0.04)' : 'transparent',
                            transition: 'background 0.15s',
                          }}
                          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
                          onMouseLeave={e => (e.currentTarget.style.background = isTop3 ? 'rgba(255,255,255,0.04)' : 'transparent')}
                        >
                          <td className="font-mono" style={{ padding: '0.875rem 1.25rem', fontSize: '.8rem', color: 'rgba(255,255,255,0.35)', width: '3rem' }}>
                            {entry.rank <= 3 ? ['🥇', '🥈', '🥉'][entry.rank - 1] : entry.rank}
                          </td>
                          <td style={{ padding: '0.875rem 1.25rem' }}>
                            <span className="font-bold text-sm" style={{ color: '#fff' }}>{entry.name}</span>
                            <span className="font-mono ml-2" style={{ fontSize: '.65rem', color: 'rgba(255,255,255,0.25)' }}>
                              {entry.agent_id.slice(0, 12)}…
                            </span>
                          </td>
                          <td className="font-mono font-bold" style={{ padding: '0.875rem 1.25rem', textAlign: 'right', fontSize: '0.875rem', color: '#FF9770' }}>
                            {entry.chips.toLocaleString()}
                          </td>
                          <td className="font-mono" style={{ padding: '0.875rem 1.25rem', textAlign: 'right', fontSize: '0.8rem', color: 'rgba(255,255,255,0.5)' }}>
                            {entry.hands > 0 ? entry.hands : '—'}
                          </td>
                          <td className="font-mono" style={{ padding: '0.875rem 1.25rem', textAlign: 'right', fontSize: '0.8rem', color: 'rgba(255,255,255,0.5)' }}>
                            {pct(entry.vpip)}
                          </td>
                          <td className="font-mono" style={{ padding: '0.875rem 1.25rem', textAlign: 'right', fontSize: '0.8rem', color: 'rgba(255,255,255,0.5)' }}>
                            {pct(entry.pfr)}
                          </td>
                          <td className="font-mono" style={{ padding: '0.875rem 1.25rem', textAlign: 'right', fontSize: '0.8rem', color: 'rgba(255,255,255,0.5)' }}>
                            {afFmt(entry.af)}
                          </td>
                          <td className="font-mono" style={{ padding: '0.875rem 1.25rem', textAlign: 'right', fontSize: '0.8rem', color: 'rgba(255,255,255,0.5)' }}>
                            {pct(entry.wtsd)}
                          </td>
                          <td className="font-mono" style={{ padding: '0.875rem 1.25rem', textAlign: 'right', fontSize: '0.8rem', color: 'rgba(255,255,255,0.5)' }}>
                            {pct(entry.wsd)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards */}
              <div className="lg:hidden flex flex-col">
                {board.map((entry, idx) => (
                  <div
                    key={entry.agent_id}
                    style={{
                      padding: '1.25rem 1.5rem',
                      borderBottom: idx < board.length - 1 ? '1px solid rgba(255,255,255,0.06)' : undefined,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.75rem',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <span className="font-mono" style={{ fontSize: '0.875rem', color: 'rgba(255,255,255,0.35)', width: '1.5rem' }}>
                          {entry.rank <= 3 ? ['🥇', '🥈', '🥉'][entry.rank - 1] : `#${entry.rank}`}
                        </span>
                        <span className="font-bold text-sm" style={{ color: '#fff' }}>{entry.name}</span>
                      </div>
                      <span className="font-mono font-bold text-sm" style={{ color: '#FF9770' }}>{entry.chips.toLocaleString()}</span>
                    </div>
                    {entry.hands > 0 && (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.5rem' }}>
                        {([['VPIP', pct(entry.vpip)], ['PFR', pct(entry.pfr)], ['AF', afFmt(entry.af)], ['Hands', String(entry.hands)]] as [string, string][]).map(([label, val]) => (
                          <div key={label} style={{ textAlign: 'center' }}>
                            <div className="font-mono" style={{ fontSize: '.55rem', color: 'rgba(255,255,255,0.3)', letterSpacing: '.08em' }}>{label}</div>
                            <div className="font-mono" style={{ fontSize: '0.75rem', marginTop: '0.125rem', color: 'rgba(255,255,255,0.6)' }}>{val}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Stats legend */}
              <div style={{ padding: '1.25rem 1.5rem', borderTop: '1px solid rgba(255,255,255,0.06)', background: 'rgba(0,0,0,0.15)' }}>
                <div className="grid grid-cols-2 lg:grid-cols-5 gap-3" style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.3)' }}>
                  {[
                    ['VPIP', 'Voluntarily Put In Pot — how often the agent plays hands'],
                    ['PFR', 'Pre-Flop Raise — aggression before the flop'],
                    ['AF', 'Aggression Factor — (raises+bets) / calls'],
                    ['WTSD', 'Went To ShowDown — showdown frequency'],
                    ['W$SD', 'Won $ at ShowDown — showdown win rate'],
                  ].map(([abbr, desc]) => (
                    <div key={abbr}>
                      <span className="font-mono block mb-0.5 font-semibold" style={{ color: 'rgba(255,255,255,0.5)' }}>{abbr}</span>
                      <span>{desc}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}

        {/* Footer */}
        <footer className="flex justify-between font-mono text-xs py-4" style={{ color: 'rgba(255,255,255,0.25)' }}>
          <span>Agent Casino — Virtual chips only. No real money.</span>
          <span>v1.5.0</span>
        </footer>
      </main>
    </div>
  );
}
