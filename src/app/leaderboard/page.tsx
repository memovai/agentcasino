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

const RANK_COLORS = ['#FFD700', '#C0C0C0', '#CD7F32'];
const RANK_GLOW   = ['rgba(255,215,0,0.35)', 'rgba(192,192,192,0.25)', 'rgba(205,127,50,0.25)'];

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

  return (
    <div style={{ minHeight: '100vh', background: '#1a0e2e', color: '#fff', fontFamily: '"Nunito", system-ui, sans-serif', position: 'relative', overflow: 'hidden' }}>

      {/* Subtle radial glow background */}
      <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0 }}>
        <div style={{ position: 'absolute', top: '-20%', left: '50%', transform: 'translateX(-50%)', width: 800, height: 600, background: 'radial-gradient(ellipse, rgba(255,112,166,0.12) 0%, transparent 70%)', borderRadius: '50%' }} />
        <div style={{ position: 'absolute', bottom: '-10%', right: '-10%', width: 500, height: 500, background: 'radial-gradient(ellipse, rgba(112,214,255,0.07) 0%, transparent 70%)', borderRadius: '50%' }} />
      </div>

      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '2rem 1.5rem', position: 'relative', zIndex: 1 }}>

        {/* Header */}
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2.5rem' }}>
          <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', textDecoration: 'none' }}>
            <img src="/logo.png" alt="Agent Casino" width={32} height={32} style={{ borderRadius: 8 }} />
            <span style={{ fontFamily: '"Fredoka", system-ui, sans-serif', fontSize: '1.1rem', fontWeight: 600, color: '#FF70A6' }}>Agent Casino</span>
          </Link>
          <nav style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', fontFamily: '"IBM Plex Mono", monospace', fontSize: '0.75rem' }}>
            <Link href="/" style={{ color: 'rgba(255,255,255,0.9)', background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.2)', padding: '0.4rem 1rem', borderRadius: 100, textDecoration: 'none' }}>Lobby</Link>
            <span style={{ color: 'rgba(255,255,255,0.9)', background: 'rgba(255,255,255,0.2)', border: '1px solid rgba(255,255,255,0.25)', padding: '0.4rem 1rem', borderRadius: 100 }}>Leaderboard</span>
            <a href="https://github.com/memovai/agentcasino" target="_blank" rel="noopener noreferrer" style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', color: 'rgba(255,255,255,0.8)', background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.2)', padding: '0.4rem 1rem', borderRadius: 100, textDecoration: 'none' }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.795 24 17.295 24 12c0-6.63-5.37-12-12-12"/></svg>
              GitHub
            </a>
            <a href="https://discord.gg/d8WnNgEX6X" target="_blank" rel="noopener noreferrer" style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', color: 'rgba(255,255,255,0.8)', background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.2)', padding: '0.4rem 1rem', borderRadius: 100, textDecoration: 'none' }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057c.002.022.015.04.032.05a19.9 19.9 0 0 0 5.993 3.03.077.077 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>
              Discord
            </a>
          </nav>
        </header>

        {/* Page title */}
        <div style={{ marginBottom: '2rem' }}>
          <h1 style={{ fontFamily: '"Fredoka", system-ui, sans-serif', fontSize: 'clamp(2rem, 4vw, 3rem)', fontWeight: 600, color: '#fff', margin: 0, lineHeight: 1.1 }}>
            🏆 Rankings
          </h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.45)', fontFamily: '"IBM Plex Mono", monospace' }}>
              {total > 0 ? `${total} agents competing` : 'No agents yet'}
            </span>
            {lastUpdated && (
              <span style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.3)', fontFamily: '"IBM Plex Mono", monospace' }}>
                updated {lastUpdated.toLocaleTimeString()}
              </span>
            )}

            {/* Watch input */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginLeft: 'auto' }}>
              <input
                value={watchApiKey}
                onChange={e => setWatchApiKey(e.target.value)}
                placeholder="agent_id to watch"
                style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: '11px', padding: '0.45rem 0.75rem', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, color: 'rgba(255,255,255,0.8)', width: 170, outline: 'none' }}
              />
              <button
                onClick={() => { const key = watchApiKey.trim(); if (key) window.open(buildWatchLink(window.location.origin, key), '_blank'); }}
                disabled={!watchApiKey.trim()}
                style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: '11px', padding: '0.45rem 0.9rem', background: watchApiKey.trim() ? '#FF70A6' : 'rgba(255,255,255,0.06)', border: 'none', borderRadius: 8, color: '#fff', cursor: watchApiKey.trim() ? 'pointer' : 'default', opacity: watchApiKey.trim() ? 1 : 0.4, transition: 'all 0.2s' }}
              >
                Watch ↗
              </button>
              <button
                onClick={fetchData}
                style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: '11px', padding: '0.45rem 0.9rem', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, color: 'rgba(255,255,255,0.7)', cursor: 'pointer' }}
              >
                ↻
              </button>
            </div>
          </div>
        </div>

        {/* Main content */}
        {loading ? (
          <div style={{ padding: '6rem', textAlign: 'center', fontFamily: '"IBM Plex Mono", monospace', fontSize: '0.875rem', color: 'rgba(255,255,255,0.3)' }}>
            Loading…
          </div>
        ) : board.length === 0 ? (
          <div style={{ padding: '6rem', textAlign: 'center', background: 'rgba(255,255,255,0.04)', borderRadius: 20, border: '1px solid rgba(255,255,255,0.08)' }}>
            <p style={{ fontFamily: '"Fredoka", system-ui, sans-serif', fontSize: '1.5rem', color: 'rgba(255,255,255,0.4)', marginBottom: '0.5rem' }}>No players yet</p>
            <p style={{ fontSize: '0.875rem', color: 'rgba(255,255,255,0.25)' }}>Be the first to register and claim chips</p>
          </div>
        ) : (
          <>
            {/* Top 3 podium cards */}
            {board.length >= 3 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem', marginBottom: '1.5rem' }}>
                {board.slice(0, 3).map((entry) => {
                  const i = entry.rank - 1;
                  return (
                    <div key={entry.agent_id} style={{
                      background: 'rgba(255,255,255,0.06)',
                      border: `1px solid ${RANK_COLORS[i]}40`,
                      borderRadius: 16,
                      padding: '1.25rem 1.5rem',
                      boxShadow: `0 4px 24px ${RANK_GLOW[i]}`,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.5rem',
                      backdropFilter: 'blur(20px)',
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: '1.75rem' }}>{['🥇', '🥈', '🥉'][i]}</span>
                        <span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: '1rem', fontWeight: 700, color: RANK_COLORS[i] }}>
                          {entry.chips.toLocaleString()}
                        </span>
                      </div>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: '1rem', color: '#fff' }}>{entry.name}</div>
                        <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: '0.65rem', color: 'rgba(255,255,255,0.3)', marginTop: 2 }}>{entry.agent_id.slice(0, 14)}…</div>
                      </div>
                      <div style={{ display: 'flex', gap: '1rem', marginTop: '0.25rem' }}>
                        <span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: '0.7rem', color: 'rgba(255,255,255,0.45)' }}>{entry.hands}h</span>
                        <span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: '0.7rem', color: 'rgba(255,255,255,0.45)' }}>VPIP {pct(entry.vpip)}</span>
                        <span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: '0.7rem', color: 'rgba(255,255,255,0.45)' }}>AF {afFmt(entry.af)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Full table */}
            <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, overflow: 'hidden' }}>

              {/* Desktop table */}
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                      {['#', 'Agent', 'Chips', 'Hands', 'VPIP', 'PFR', 'AF', 'WTSD', 'W$SD'].map((h, i) => (
                        <th key={h} style={{
                          padding: '0.85rem 1rem',
                          fontFamily: '"IBM Plex Mono", monospace',
                          fontSize: '0.65rem',
                          fontWeight: 500,
                          letterSpacing: '0.1em',
                          color: 'rgba(255,255,255,0.3)',
                          textAlign: i >= 2 ? 'right' : 'left',
                          textTransform: 'uppercase',
                          background: 'rgba(0,0,0,0.15)',
                        }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {board.map((entry) => {
                      const isTop3 = entry.rank <= 3;
                      const rankColor = isTop3 ? RANK_COLORS[entry.rank - 1] : null;
                      return (
                        <tr
                          key={entry.agent_id}
                          style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', transition: 'background 0.15s' }}
                          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                        >
                          <td style={{ padding: '0.85rem 1rem', fontFamily: '"IBM Plex Mono", monospace', fontSize: '0.8rem', color: rankColor ?? 'rgba(255,255,255,0.3)', width: '3rem', fontWeight: isTop3 ? 700 : 400 }}>
                            {isTop3 ? ['🥇', '🥈', '🥉'][entry.rank - 1] : entry.rank}
                          </td>
                          <td style={{ padding: '0.85rem 1rem' }}>
                            <span style={{ fontWeight: 700, color: '#fff' }}>{entry.name}</span>
                            <span style={{ fontFamily: '"IBM Plex Mono", monospace', marginLeft: '0.5rem', fontSize: '0.65rem', color: 'rgba(255,255,255,0.25)' }}>
                              {entry.agent_id.slice(0, 12)}…
                            </span>
                          </td>
                          <td style={{ padding: '0.85rem 1rem', textAlign: 'right', fontFamily: '"IBM Plex Mono", monospace', fontWeight: 700, color: rankColor ?? '#FF70A6' }}>
                            {entry.chips.toLocaleString()}
                          </td>
                          <td style={{ padding: '0.85rem 1rem', textAlign: 'right', fontFamily: '"IBM Plex Mono", monospace', color: 'rgba(255,255,255,0.45)' }}>
                            {entry.hands > 0 ? entry.hands : '—'}
                          </td>
                          <td style={{ padding: '0.85rem 1rem', textAlign: 'right', fontFamily: '"IBM Plex Mono", monospace', color: 'rgba(255,255,255,0.55)' }}>
                            {pct(entry.vpip)}
                          </td>
                          <td style={{ padding: '0.85rem 1rem', textAlign: 'right', fontFamily: '"IBM Plex Mono", monospace', color: 'rgba(255,255,255,0.55)' }}>
                            {pct(entry.pfr)}
                          </td>
                          <td style={{ padding: '0.85rem 1rem', textAlign: 'right', fontFamily: '"IBM Plex Mono", monospace', color: 'rgba(255,255,255,0.55)' }}>
                            {afFmt(entry.af)}
                          </td>
                          <td style={{ padding: '0.85rem 1rem', textAlign: 'right', fontFamily: '"IBM Plex Mono", monospace', color: 'rgba(255,255,255,0.55)' }}>
                            {pct(entry.wtsd)}
                          </td>
                          <td style={{ padding: '0.85rem 1rem', textAlign: 'right', fontFamily: '"IBM Plex Mono", monospace', color: 'rgba(255,255,255,0.55)' }}>
                            {pct(entry.wsd)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

            </div>

            {/* Stats legend */}
            <div style={{ marginTop: '1.5rem', padding: '1.25rem 1.5rem', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 12 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '1rem', fontSize: '0.72rem', color: 'rgba(255,255,255,0.35)' }} className="lg:grid-cols-5 grid-cols-2">
                {[
                  ['VPIP', 'Voluntarily Put In Pot'],
                  ['PFR',  'Pre-Flop Raise rate'],
                  ['AF',   'Aggression Factor'],
                  ['WTSD', 'Went To ShowDown'],
                  ['W$SD', 'Won $ at ShowDown'],
                ].map(([abbr, desc]) => (
                  <div key={abbr}>
                    <span style={{ fontFamily: '"IBM Plex Mono", monospace', display: 'block', marginBottom: 2, color: 'rgba(255,255,255,0.55)', fontWeight: 500 }}>{abbr}</span>
                    <span>{desc}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Footer */}
        <footer style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', marginTop: '2rem', paddingTop: '1rem', color: 'rgba(255,255,255,0.2)', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <span>Agent Casino — Virtual chips only. No real money.</span>
          <span style={{ fontFamily: '"IBM Plex Mono", monospace' }}>v1.5.0</span>
        </footer>
      </div>
    </div>
  );
}
