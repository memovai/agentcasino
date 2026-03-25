'use client';

import { ChatMessage } from '@/lib/types';
import { useRef, useEffect } from 'react';

interface ChatBoxProps {
  messages: ChatMessage[];
  onSend?: (message: string) => void;
}

function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function getNameColor(agentId: string, name: string): string {
  if (agentId === 'system') return 'text-amber-400';
  const hue = name.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) % 360;
  // Map to one of several distinct chat colors
  const colors = [
    'text-emerald-400',
    'text-sky-400',
    'text-violet-400',
    'text-pink-400',
    'text-teal-400',
    'text-orange-400',
    'text-cyan-400',
    'text-lime-400',
  ];
  return colors[hue % colors.length];
}

export function ChatBox({ messages, onSend }: ChatBoxProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
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
          <div className="w-2 h-2 rounded-full bg-red-500 animate-live-pulse" />
        </div>
        <h3
          className="text-xs font-bold uppercase tracking-[0.15em]"
          style={{
            background: 'linear-gradient(135deg, #e5e7eb, #9ca3af)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}
        >
          Live Chat
        </h3>
        <div className="ml-auto text-[10px] text-gray-500 font-mono tabular-nums">
          {messages.length} msg{messages.length !== 1 ? 's' : ''}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1 chat-scroll">
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
                <span className="text-[10px] text-amber-400/70 font-medium whitespace-nowrap px-1">
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
                <span className={`text-xs font-bold shrink-0 ${getNameColor(msg.agentId, msg.name)}`}>
                  {msg.name}
                </span>
                <span className="text-xs text-gray-300 leading-relaxed break-words">{msg.message}</span>
              </>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {/* Input — hidden for spectators */}
      {onSend ? (
        <div className="p-2.5 border-t border-white/5">
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              placeholder="Send a message..."
              className="flex-1 text-xs text-white placeholder-gray-500 px-3 py-2 rounded-xl outline-none transition-all duration-200
                focus:ring-1 focus:ring-emerald-500/40"
              style={{
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.06)',
              }}
              onKeyDown={e => e.key === 'Enter' && handleSend()}
            />
            <button
              onClick={handleSend}
              className="px-4 py-2 rounded-xl text-xs font-bold transition-all duration-200
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
      ) : (
        <div className="p-3 border-t border-white/5 text-center">
          <span className="text-[10px] font-mono uppercase tracking-wider text-amber-500/60">Spectator mode</span>
        </div>
      )}
    </div>
  );
}
