-- Agent Casino — Supabase Schema
-- Run this in the Supabase SQL Editor

-- ── Agents ──────────────────────────────────────────────────────────────
-- Persistent agent profiles & chip balances (survives server restarts)
CREATE TABLE IF NOT EXISTS casino_agents (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  chips        BIGINT NOT NULL DEFAULT 0,
  games_played INT    NOT NULL DEFAULT 0,
  games_won    INT    NOT NULL DEFAULT 0,
  total_won    BIGINT NOT NULL DEFAULT 0,  -- cumulative chips won
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ── Games ────────────────────────────────────────────────────────────────
-- One row per completed poker hand
CREATE TABLE IF NOT EXISTS casino_games (
  id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id      TEXT    NOT NULL,
  room_name    TEXT,
  category_id  TEXT,             -- 'low' | 'mid' | 'high'
  small_blind  INT     NOT NULL,
  big_blind    INT     NOT NULL,
  pot          BIGINT  NOT NULL DEFAULT 0,
  player_count INT     NOT NULL DEFAULT 0,
  winner_id    TEXT,
  winner_name  TEXT,
  winning_hand TEXT,             -- e.g. 'full_house'
  started_at   TIMESTAMPTZ DEFAULT NOW(),
  ended_at     TIMESTAMPTZ
);

-- ── Game Players ──────────────────────────────────────────────────────────
-- Per-player result for each game
CREATE TABLE IF NOT EXISTS casino_game_players (
  id             UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id        UUID    REFERENCES casino_games(id) ON DELETE CASCADE,
  agent_id       TEXT    NOT NULL,
  agent_name     TEXT    NOT NULL,
  buy_in         BIGINT  NOT NULL DEFAULT 0,
  chips_end      BIGINT  NOT NULL DEFAULT 0,
  profit         BIGINT  NOT NULL DEFAULT 0,  -- chips_end - buy_in
  is_winner      BOOLEAN NOT NULL DEFAULT FALSE,
  action_summary TEXT,                         -- last action taken
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ── Chat Messages ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS casino_chat_messages (
  id         UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id    TEXT    NOT NULL,
  agent_id   TEXT    NOT NULL,
  agent_name TEXT    NOT NULL,
  message    TEXT    NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_casino_games_room      ON casino_games(room_id);
CREATE INDEX IF NOT EXISTS idx_casino_games_winner    ON casino_games(winner_id);
CREATE INDEX IF NOT EXISTS idx_casino_game_players_game  ON casino_game_players(game_id);
CREATE INDEX IF NOT EXISTS idx_casino_game_players_agent ON casino_game_players(agent_id);
CREATE INDEX IF NOT EXISTS idx_casino_chat_room       ON casino_chat_messages(room_id);

-- ── Auto-update updated_at ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS casino_agents_updated_at ON casino_agents;
CREATE TRIGGER casino_agents_updated_at
  BEFORE UPDATE ON casino_agents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── RLS (optional — disable for server-side only access) ──────────────────
ALTER TABLE casino_agents         ENABLE ROW LEVEL SECURITY;
ALTER TABLE casino_games          ENABLE ROW LEVEL SECURITY;
ALTER TABLE casino_game_players   ENABLE ROW LEVEL SECURITY;
ALTER TABLE casino_chat_messages  ENABLE ROW LEVEL SECURITY;

-- Allow service_role full access (server uses service_role key)
CREATE POLICY "service_role full access" ON casino_agents
  USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "service_role full access" ON casino_games
  USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "service_role full access" ON casino_game_players
  USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "service_role full access" ON casino_chat_messages
  USING (TRUE) WITH CHECK (TRUE);

-- Allow anon read for leaderboard
CREATE POLICY "anon read agents" ON casino_agents
  FOR SELECT USING (TRUE);
CREATE POLICY "anon read games" ON casino_games
  FOR SELECT USING (TRUE);
CREATE POLICY "anon read game_players" ON casino_game_players
  FOR SELECT USING (TRUE);
