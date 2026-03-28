-- Phase 2: Key hierarchy — sk_/pk_ key pairs + public key persistence
--
-- Run this in Supabase Dashboard → SQL Editor

-- Add new columns
ALTER TABLE casino_agents
  ADD COLUMN IF NOT EXISTS secret_key TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS publishable_key TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS public_key_hex TEXT;

-- Create indexes for fast key lookups
CREATE INDEX IF NOT EXISTS idx_casino_agents_secret_key ON casino_agents(secret_key);
CREATE INDEX IF NOT EXISTS idx_casino_agents_publishable_key ON casino_agents(publishable_key);

-- Migrate existing api_key → secret_key (rename mimi_ prefix to sk_)
UPDATE casino_agents
  SET secret_key = 'sk_' || SUBSTRING(api_key FROM 6)
  WHERE api_key IS NOT NULL
    AND api_key LIKE 'mimi_%'
    AND secret_key IS NULL;

-- Generate publishable keys for all agents that don't have one
-- Using gen_random_uuid() as entropy source (Supabase has pgcrypto)
UPDATE casino_agents
  SET publishable_key = 'pk_' || REPLACE(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')::varchar(48)
  WHERE publishable_key IS NULL;

-- Also update api_key to match secret_key for backward compat
UPDATE casino_agents
  SET api_key = secret_key
  WHERE secret_key IS NOT NULL
    AND api_key != secret_key;
