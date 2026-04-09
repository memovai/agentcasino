'use client';

import { ChatMessage } from '@/lib/types';
import { useRef, useEffect, useCallback } from 'react';

interface ChatBoxProps {
  messages: ChatMessage[];
  onSend?: (message: string) => void;
  spectating?: boolean;
}

function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// High-contrast name colors — hand-picked for max distinction on dark backgrounds
const NAME_COLORS = [
  '#2ecc71', // emerald green
  '#e74c3c', // vivid red
  '#3498db', // bright blue
  '#f39c12', // amber/orange
  '#9b59b6', // purple
  '#1abc9c', // teal
  '#e91e63', // hot pink
  '#00bcd4', // cyan
  '#cddc39', // lime yellow
  '#ff7043', // deep orange
  '#7c4dff', // electric purple
  '#26c6da', // light teal
];

function getNameColor(agentId: string, name: string): string | null {
  if (agentId === 'system') return null; // handled separately
  const hash = name.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return NAME_COLORS[hash % NAME_COLORS.length];
}

export function ChatBox({ messages, onSend, spectating }: ChatBoxProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    // Consider "near bottom" if within 80px of the bottom
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  useEffect(() => {
    if (isNearBottomRef.current) {
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  const handleSend = () => {
    if (!onSend) return;
    const msg = inputRef.current?.value.trim();
    if (msg) {
      onSend(msg);
      inputRef.current!.value = '';
    }
  };

  return (
    <div
      className="flex flex-col h-full rounded-2xl overflow-hidden"
      style={{
        background: 'linear-gradient(180deg, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0.75) 100%)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        border: '1px solid rgba(255,255,255,0.06)',
        boxShadow: '0 4px 24px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.03)',
      }}
    >
      {/* Header */}
      <div className="px-4 py-2.5 flex items-center gap-2 border-b border-white/5">
        {/* Live indicator */}
        <div className="relative flex items-center justify-center">
          <div className="w-2 h-2 rounded-full bg-red-500" style={{ animation: 'live-pulse 1.8s ease-in-out infinite' }} />
        </div>
        <h3
          className="text-sm font-bold uppercase tracking-[0.15em]"
          style={{
            background: 'linear-gradient(135deg, #e5e7eb, #9ca3af)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}
        >
          Live Chat
        </h3>
        <div className="ml-auto text-xs text-gray-500 font-mono tabular-nums">
          {messages.length} msg{messages.length !== 1 ? 's' : ''}
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-3 py-2 space-y-1 chat-scroll">
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <span className="text-gray-600 text-xs italic">No messages yet...</span>
          </div>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`animate-float-in group flex items-baseline gap-1.5 py-0.5 rounded px-1.5 -mx-1.5 transition-colors duration-200 hover:bg-white/[0.03] ${
              msg.agentId === 'system' ? 'py-1' : ''
            }`}
            style={{ animationDelay: `${Math.min(i * 30, 300)}ms` }}
          >
            {msg.agentId === 'system' ? (
              // System message
              <div className="flex items-center gap-1.5 w-full">
                <div className="h-px flex-1 bg-gradient-to-r from-transparent via-amber-500/20 to-transparent" />
                <span className="text-xs text-amber-400/70 font-medium whitespace-nowrap px-1">
                  {msg.message}
                </span>
                <div className="h-px flex-1 bg-gradient-to-r from-transparent via-amber-500/20 to-transparent" />
              </div>
            ) : (
              // Player message
              <>
                {msg.timestamp > 0 && (
                  <span className="text-[9px] text-gray-600 font-mono tabular-nums opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    {formatTime(msg.timestamp)}
                  </span>
                )}
                <span
                  className="text-sm font-bold shrink-0"
                  style={{ color: getNameColor(msg.agentId, msg.name) ?? undefined }}
                >
                  {msg.name}
                </span>
                <span className="text-sm text-gray-300 leading-relaxed break-words">{msg.message}</span>
              </>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {/* Input */}
      {onSend && (
        <div className="p-2.5 border-t border-white/5">
          {spectating && (
            <div className="text-[9px] font-mono uppercase tracking-wider text-amber-500/50 mb-1.5 px-1">
              👁 Spectating — chat visible to all
            </div>
          )}
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              placeholder={spectating ? 'Chat as spectator...' : 'Send a message...'}
              className="flex-1 text-sm text-white placeholder-gray-500 px-3 py-2.5 rounded-xl outline-none transition-all duration-200
                focus:ring-1 focus:ring-emerald-500/40"
              style={{
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.06)',
              }}
              onKeyDown={e => e.key === 'Enter' && handleSend()}
            />
            <button
              onClick={handleSend}
              className="px-5 py-2.5 rounded-xl text-sm font-bold transition-all duration-200
                bg-gradient-to-b from-emerald-500 to-emerald-700
                hover:from-emerald-400 hover:to-emerald-600
                active:from-emerald-600 active:to-emerald-800 active:scale-95
                border border-emerald-400/20 hover:border-emerald-300/40
                text-white shadow-md hover:shadow-emerald-500/20"
            >
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
