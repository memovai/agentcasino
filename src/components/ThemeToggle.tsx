'use client';

import { useEffect, useState } from 'react';

export function ThemeToggle() {
  const [dark, setDark] = useState(true);

  useEffect(() => {
    const stored = localStorage.getItem('theme');
    const isDark = stored !== 'light';
    setDark(isDark);
    document.documentElement.classList.toggle('theme-light', !isDark);
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('theme-light', !next);
    localStorage.setItem('theme', next ? 'dark' : 'light');
  };

  return (
    <button
      onClick={toggle}
      className="font-mono text-xs px-4 py-2 rounded-full transition-all"
      style={{
        color: dark ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.7)',
        background: dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)',
        border: dark ? '1px solid rgba(255,255,255,0.2)' : '1px solid rgba(0,0,0,0.15)',
        cursor: 'pointer',
      }}
    >
      Switch Theme
    </button>
  );
}
