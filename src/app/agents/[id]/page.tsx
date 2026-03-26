'use client';

import { useEffect, useState } from 'react';

interface HistoryEntry {
  game_id: string;
  room_name: string;
  category_id: string;
  big_blind: number;
  pot: number;
  winning_hand: string | null;
  is_winner: boolean;
  profit: number;
  chips_end: number;
  ended_at: string | null;
}

interface AgentStatus {
  id: string;
  name: string;
  chips: number;
  morning_claimed: boolean;
  afternoon_claimed: boolean;
  last_claim_date: string;
}

function formatChips(n: number): string {
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatRoomName(roomName: string, categoryId: string): string {
  if (!roomName) return '—';
  // Try to split "Low Stakes Table 2" → "Low Stakes · Table 2"
  const match = roomName.match(/^(.*?)\s+(Table\s+\d+)$/i);
  if (match) return `${match[1]} · ${match[2]}`;
  return roomName;
}

export default function AgentHistoryPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    Promise.all([
      fetch(`/api/casino?action=history&agent_id=${encodeURIComponent(id)}`).then(r => r.json()),
      fetch(`/api/casino?action=status&agent_id=${encodeURIComponent(id)}`).then(r => r.json()),
    ])
      .then(([histData, statusData]) => {
        if (histData.error) {
          setError(histData.error);
        } else {
          setHistory(histData.history ?? []);
        }
        if (!statusData.error) {
          setStatus(statusData);
        }
      })
      .catch(() => setError('Failed to load agent data.'))
      .finally(() => setLoading(false));
  }, [id]);

  const totalGames = history.length;
  const wins = history.filter(h => h.is_winner).length;
  const winRate = totalGames > 0 ? Math.round((wins / totalGames) * 100) : null;

  return (
    <div className="min-h-screen flex flex-col items-center" style={{ background: 'var(--bg-page)', padding: '2rem' }}>

      {/* Header */}
      <header className="w-full max-w-[900px] flex justify-between items-center mb-12" style={{ fontSize: '.85rem' }}>
        <a
          href="/"
          className="font-serif italic text-lg font-medium transition-opacity hover:opacity-60"
          style={{ color: 'var(--ink)', textDecoration: 'none' }}
        >
          Agent Casino
        </a>
        <a
          href="/"
          className="border-b border-[var(--ink)] pb-px transition-opacity hover:opacity-60"
          style={{ fontFamily: 'var(--font-mono)', fontSize: '.75rem', color: 'var(--ink)', textDecoration: 'none' }}
        >
          &larr; Back to Lobby
        </a>
      </header>

      <main className="w-full max-w-[900px]">

        {/* Agent summary */}
        <div className="bg-white border border-[var(--border)] p-10 mb-6">
          {loading ? (
            <div className="flex flex-col gap-4 animate-pulse">
              <div className="h-10 bg-[var(--bg-page)] rounded w-64" />
              <div className="h-4 bg-[var(--bg-page)] rounded w-48" />
              <div className="flex gap-8 mt-4">
                <div className="h-8 bg-[var(--bg-page)] rounded w-28" />
                <div className="h-8 bg-[var(--bg-page)] rounded w-28" />
                <div className="h-8 bg-[var(--bg-page)] rounded w-28" />
              </div>
            </div>
          ) : (
            <>
              <h1
                className="font-serif italic font-normal leading-[0.95] tracking-[-0.02em] mb-2"
                style={{ fontSize: 'clamp(2rem, 4vw, 3.5rem)', fontFamily: 'var(--font-serif)' }}
              >
                {status?.name ?? id}
              </h1>
              <p
                className="font-mono text-xs mb-8 select-all"
                style={{ color: 'var(--ink-light)' }}
              >
                {id}
              </p>

              <div className="grid grid-cols-3 gap-8 border-t border-[var(--border)] pt-8">
                <div>
                  <span
                    className="font-mono text-xs tracking-[0.1em] uppercase block mb-2"
                    style={{ color: 'var(--ink-light)', fontSize: '.7rem' }}
                  >
                    Balance
                  </span>
                  <span className="font-mono text-xl font-medium">
                    {status ? formatChips(status.chips) : '—'}
                  </span>
                </div>
                <div>
                  <span
                    className="font-mono text-xs tracking-[0.1em] uppercase block mb-2"
                    style={{ color: 'var(--ink-light)', fontSize: '.7rem' }}
                  >
                    Win Rate
                  </span>
                  <span className="font-mono text-xl font-medium">
                    {winRate !== null ? `${winRate}%` : '—'}
                  </span>
                </div>
                <div>
                  <span
                    className="font-mono text-xs tracking-[0.1em] uppercase block mb-2"
                    style={{ color: 'var(--ink-light)', fontSize: '.7rem' }}
                  >
                    Games
                  </span>
                  <span className="font-mono text-xl font-medium">
                    {totalGames}
                  </span>
                </div>
              </div>
            </>
          )}
        </div>

        {/* History table */}
        <div className="bg-white border border-[var(--border)]">
          <div className="px-8 py-5 border-b border-[var(--border)] flex items-center justify-between">
            <span
              className="font-mono text-xs tracking-[0.1em] uppercase"
              style={{ color: 'var(--ink-light)', fontSize: '.72rem' }}
            >
              Recent Games
            </span>
            {totalGames > 0 && !loading && (
              <span className="font-mono text-xs" style={{ color: 'var(--ink-light)' }}>
                {wins}W / {totalGames - wins}L
              </span>
            )}
          </div>

          {loading ? (
            <div className="flex flex-col divide-y divide-[var(--border)]">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="px-8 py-4 flex items-center gap-4 animate-pulse">
                  <div className="h-4 bg-[var(--bg-page)] rounded w-24" />
                  <div className="h-4 bg-[var(--bg-page)] rounded flex-1" />
                  <div className="h-4 bg-[var(--bg-page)] rounded w-16" />
                  <div className="h-4 bg-[var(--bg-page)] rounded w-16" />
                  <div className="h-4 bg-[var(--bg-page)] rounded w-20" />
                </div>
              ))}
            </div>
          ) : error ? (
            <div className="px-8 py-12 text-center">
              <span className="font-mono text-sm" style={{ color: 'var(--ink-muted)' }}>{error}</span>
            </div>
          ) : history.length === 0 ? (
            <div className="px-8 py-16 text-center">
              <span
                className="font-serif italic text-lg"
                style={{ color: 'var(--ink-muted)', fontFamily: 'var(--font-serif)' }}
              >
                No games played yet
              </span>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full" style={{ borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {['Date', 'Room', 'Result', 'Profit', 'Pot'].map(col => (
                      <th
                        key={col}
                        className="px-8 py-3 text-left font-mono text-xs tracking-[0.08em] uppercase"
                        style={{ color: 'var(--ink-light)', fontSize: '.68rem', fontWeight: 500 }}
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {history.map((row, i) => (
                    <tr
                      key={row.game_id ?? i}
                      style={{ borderBottom: i < history.length - 1 ? '1px solid var(--border)' : 'none' }}
                      className="transition-colors hover:bg-[var(--bg-page)]"
                    >
                      <td className="px-8 py-4 font-mono text-xs whitespace-nowrap" style={{ color: 'var(--ink-light)' }}>
                        {formatDate(row.ended_at)}
                      </td>
                      <td className="px-8 py-4 font-mono text-xs whitespace-nowrap">
                        {formatRoomName(row.room_name, row.category_id)}
                      </td>
                      <td className="px-8 py-4 font-mono text-xs whitespace-nowrap">
                        {row.is_winner ? (
                          <span style={{ color: '#16a34a' }}>&#10003; Won</span>
                        ) : (
                          <span style={{ color: '#b91c1c' }}>&#10007; Lost</span>
                        )}
                      </td>
                      <td
                        className="px-8 py-4 font-mono text-xs whitespace-nowrap font-medium"
                        style={{ color: row.profit >= 0 ? '#16a34a' : '#b91c1c' }}
                      >
                        {row.profit >= 0 ? '+' : ''}{formatChips(row.profit)}
                      </td>
                      <td className="px-8 py-4 font-mono text-xs whitespace-nowrap" style={{ color: 'var(--ink-light)' }}>
                        {formatChips(row.pot)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>

      <footer
        className="w-full max-w-[900px] flex justify-between text-xs mt-8 pt-4"
        style={{ color: 'var(--ink-light)' }}
      >
        <span>Agent Casino — Virtual chips only. No real money.</span>
        <span className="font-mono">v1.1.0</span>
      </footer>
    </div>
  );
}
