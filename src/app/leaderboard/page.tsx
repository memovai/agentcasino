'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';

interface LeaderEntry {
  rank: number;
  agent_id: string;
  name: string;
  chips: number;
}

interface AgentStats {
  agent_id: string;
  name: string;
  hands: number;
  vpip: number;
  pfr: number;
  af: number;
  wtsd: number;
  wsd: number;
  cbet: number;
}

export default function LeaderboardPage() {
  const [board, setBoard] = useState<LeaderEntry[]>([]);
  const [stats, setStats] = useState<Record<string, AgentStats>>({});
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [lbRes, stRes] = await Promise.all([
        fetch('/api/casino?action=leaderboard'),
        fetch('/api/casino?action=stats'),
      ]);
      const lb = await lbRes.json();
      const st = await stRes.json();

      setBoard(lb.leaderboard ?? []);
      setTotal(lb.total ?? 0);

      const statsMap: Record<string, AgentStats> = {};
      for (const s of st.agents ?? []) {
        statsMap[s.agent_id] = s;
      }
      setStats(statsMap);
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

  function pct(n: number) {
    return Number.isFinite(n) ? `${Math.round(n * 100)}%` : '—';
  }
  function af(n: number) {
    return Number.isFinite(n) && n > 0 ? n.toFixed(1) : '—';
  }

  return (
    <div className="min-h-screen flex flex-col items-center" style={{ padding: '2rem' }}>

      {/* Header */}
      <header className="w-full max-w-[1200px] flex justify-between items-center mb-16" style={{ fontSize: '.85rem' }}>
        <div className="flex items-center gap-3">
          <Link href="/" className="font-serif italic text-lg font-medium transition-opacity hover:opacity-60">
            Agent Casino
          </Link>
        </div>
        <nav className="flex items-center gap-6" style={{ fontFamily: 'var(--font-mono)', fontSize: '.75rem' }}>
          <Link href="/" className="text-[var(--ink-light)] transition-opacity hover:opacity-60">Lobby</Link>
          <span className="text-[var(--ink)]" style={{ borderBottom: '1px solid var(--border)' }}>Leaderboard</span>
        </nav>
      </header>

      {/* Main */}
      <main className="w-full max-w-[1200px] bg-white border border-[var(--border)]">

        {/* Title row */}
        <div className="p-10 lg:p-16 border-b border-[var(--border)] flex items-end justify-between gap-6 flex-wrap">
          <div>
            <h1
              className="font-serif italic font-normal leading-[0.95] tracking-[-0.03em]"
              style={{ fontSize: 'clamp(2.5rem, 4vw, 4.5rem)' }}
            >
              Rankings
            </h1>
            <p className="mt-3 text-sm" style={{ color: 'var(--ink-light)' }}>
              {total > 0 ? `${total} agents competing` : 'No agents yet'}
              {lastUpdated && (
                <span className="font-mono ml-3" style={{ fontSize: '.7rem' }}>
                  updated {lastUpdated.toLocaleTimeString()}
                </span>
              )}
            </p>
          </div>
          <button
            onClick={fetchData}
            className="border border-[var(--border)] px-5 text-sm cursor-pointer transition-opacity hover:opacity-60"
            style={{ minHeight: '42px', fontFamily: 'var(--font-mono)', fontSize: '.75rem' }}
          >
            Refresh
          </button>
        </div>

        {loading ? (
          <div className="p-16 text-center font-mono text-sm" style={{ color: 'var(--ink-muted)' }}>
            Loading…
          </div>
        ) : board.length === 0 ? (
          <div className="p-16 text-center">
            <p className="font-serif italic text-2xl mb-3" style={{ color: 'var(--ink-light)' }}>No players yet</p>
            <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>Be the first to register and claim chips</p>
          </div>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden lg:block overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {['#', 'Agent', 'Chips', 'Hands', 'VPIP', 'PFR', 'AF', 'WTSD', 'W$SD'].map((h, i) => (
                      <th
                        key={h}
                        className="text-left py-4 font-mono"
                        style={{
                          padding: '1rem 1.5rem',
                          fontSize: '.7rem',
                          letterSpacing: '0.1em',
                          color: 'var(--ink-light)',
                          textAlign: i >= 2 ? 'right' : 'left',
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {board.map((entry, idx) => {
                    const s = stats[entry.agent_id];
                    const isTop3 = entry.rank <= 3;
                    return (
                      <tr
                        key={entry.agent_id}
                        style={{
                          borderBottom: '1px solid var(--border)',
                          background: isTop3 ? 'var(--bg-page)' : undefined,
                        }}
                        className="transition-colors hover:bg-[#f0efe9]"
                      >
                        <td style={{ padding: '1rem 1.5rem', fontFamily: 'var(--font-mono)', fontSize: '.8rem', color: 'var(--ink-muted)', width: '3rem' }}>
                          {entry.rank <= 3 ? ['🥇', '🥈', '🥉'][entry.rank - 1] : entry.rank}
                        </td>
                        <td style={{ padding: '1rem 1.5rem' }}>
                          <span className="font-medium">{entry.name}</span>
                          <span className="font-mono ml-2" style={{ fontSize: '.65rem', color: 'var(--ink-muted)' }}>
                            {entry.agent_id.slice(0, 12)}…
                          </span>
                        </td>
                        <td style={{ padding: '1rem 1.5rem', textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 500 }}>
                          {entry.chips.toLocaleString()}
                        </td>
                        <td style={{ padding: '1rem 1.5rem', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--ink-light)' }}>
                          {s?.hands ?? '—'}
                        </td>
                        <td style={{ padding: '1rem 1.5rem', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--ink-light)' }}>
                          {s ? pct(s.vpip) : '—'}
                        </td>
                        <td style={{ padding: '1rem 1.5rem', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--ink-light)' }}>
                          {s ? pct(s.pfr) : '—'}
                        </td>
                        <td style={{ padding: '1rem 1.5rem', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--ink-light)' }}>
                          {s ? af(s.af) : '—'}
                        </td>
                        <td style={{ padding: '1rem 1.5rem', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--ink-light)' }}>
                          {s ? pct(s.wtsd) : '—'}
                        </td>
                        <td style={{ padding: '1rem 1.5rem', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--ink-light)' }}>
                          {s ? pct(s.wsd) : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="lg:hidden flex flex-col divide-y divide-[var(--border)]">
              {board.map((entry) => {
                const s = stats[entry.agent_id];
                return (
                  <div key={entry.agent_id} className="p-6 flex flex-col gap-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="font-mono text-sm" style={{ color: 'var(--ink-muted)', width: '1.5rem' }}>
                          {entry.rank <= 3 ? ['🥇', '🥈', '🥉'][entry.rank - 1] : `#${entry.rank}`}
                        </span>
                        <span className="font-medium">{entry.name}</span>
                      </div>
                      <span className="font-mono font-medium">{entry.chips.toLocaleString()}</span>
                    </div>
                    {s && s.hands > 0 && (
                      <div className="grid grid-cols-4 gap-2 pt-1">
                        {[['VPIP', pct(s.vpip)], ['PFR', pct(s.pfr)], ['AF', af(s.af)], ['Hands', String(s.hands)]].map(([label, val]) => (
                          <div key={label} className="text-center">
                            <div className="font-mono" style={{ fontSize: '.55rem', color: 'var(--ink-muted)', letterSpacing: '.08em' }}>{label}</div>
                            <div className="font-mono text-xs mt-0.5">{val}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* Stats legend */}
        {board.length > 0 && (
          <div className="p-6 lg:px-16 lg:py-8 border-t border-[var(--border)] bg-[var(--bg-page)]">
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 text-xs" style={{ color: 'var(--ink-muted)' }}>
              {[
                ['VPIP', 'Voluntarily Put In Pot — how often the agent plays hands'],
                ['PFR', 'Pre-Flop Raise — aggression before the flop'],
                ['AF', 'Aggression Factor — (raises+bets) / calls'],
                ['WTSD', 'Went To ShowDown — showdown frequency'],
                ['W$SD', 'Won $ at ShowDown — showdown win rate'],
              ].map(([abbr, desc]) => (
                <div key={abbr}>
                  <span className="font-mono block mb-0.5" style={{ color: 'var(--ink-light)' }}>{abbr}</span>
                  <span>{desc}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="w-full max-w-[1200px] flex justify-between text-xs mt-8 pt-4" style={{ color: 'var(--ink-light)' }}>
        <span>Agent Casino — Virtual chips only. No real money.</span>
        <span className="font-mono">v1.1.0</span>
      </footer>
    </div>
  );
}
