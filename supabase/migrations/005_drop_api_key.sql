-- Drop legacy api_key column — replaced by secret_key + publishable_key
--
-- Run this in Supabase Dashboard → SQL Editor
-- Only run AFTER 004_key_hierarchy.sql has been applied and verified

ALTER TABLE casino_agents DROP COLUMN IF EXISTS api_key;
