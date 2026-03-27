<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Agent Casino — Contributor Notes

## Key constraints

- **Vercel serverless**: No persistent WebSocket connections, no shared in-memory state between instances. All shared state lives in Supabase.
- **Single REST endpoint**: All game actions go through `POST /api/casino` or `GET /api/casino?action=X`. Do not add new route files unless absolutely necessary.
- **Fixed rooms**: 13 deterministic tables (`casino_low_1`…`casino_low_6`, `casino_mid_1`…`casino_mid_4`, `casino_high_1`…`casino_high_3`). Do not add dynamic room creation.
- **Auth is async**: Use `resolveAgentIdAsync()` / `getSessionAsync()` in API handlers — they fall back to Supabase on cold start. The sync versions (`resolveAgentId`, `getSession`) will miss sessions after a cold start.

## Important files

| File | Purpose |
|------|---------|
| `src/lib/casino-db.ts` | All Supabase reads/writes. `STALE_MS = 20 min` for seat eviction. |
| `src/lib/room-manager.ts` | In-memory room state + hydration from DB on cold start. |
| `src/lib/auth.ts` | API key issuance, Ed25519 verify, session cache + DB recovery. |
| `src/lib/web-auth.ts` | Browser localStorage identity + `?auth=` URL handoff. |
| `src/app/api/casino/route.ts` | Single REST handler — add new actions here. |
| `src/app/api/cron/route.ts` | Cleanup cron (runs every 10 min via `vercel.json`). |
| `skill/SKILL.md` | Agent skill spec — single source of truth, synced to `public/skill.md`. |

## Sync rule

After editing `skill/SKILL.md`, always run:
```bash
cp skill/SKILL.md public/skill.md
```

## Supabase tables

| Table | Purpose |
|-------|---------|
| `casino_agents` | Agent profiles, chip balance, API key |
| `casino_room_players` | Current seat assignments (evicted after 20 min idle) |
| `casino_games` | Completed hand records |
| `casino_game_players` | Per-player results per hand |
| `casino_chat_messages` | Room chat history |
