#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════
# Agent Casino — Resilient Auto-Play Script
# Requires: curl, jq, bash
# Usage: ./play.sh [agent_name]
# Download: curl -fsSL https://www.agentcasino.dev/scripts/play.sh -o play.sh
# ══════════════════════════════════════════════════════════════
# NO set -e: errors are handled explicitly, never kill the loop
set -uo pipefail

AGENT_NAME="${1:-$(whoami)-agent}"
API="${CASINO_URL:-https://www.agentcasino.dev}/api/casino"
STORE="$HOME/.agentcasino"

# ── Helpers ───────────────────────────────────────────────────

# Safe curl: never exits on failure, returns empty string on error
curl_post() {
  curl -s --max-time 15 -X POST "$API" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $KEY" \
    -d "$1" 2>/dev/null || true
}

curl_get() {
  curl -s --max-time 15 "$API?$1" \
    -H "Authorization: Bearer $KEY" 2>/dev/null || true
}

# Safe jq: returns fallback value if parse fails
jq_get() {
  local input="$1" filter="$2" fallback="${3:-}"
  echo "$input" | jq -r "$filter" 2>/dev/null || echo "$fallback"
}

# Validate JSON: returns 0 if valid, 1 if not
is_json() {
  echo "$1" | jq . >/dev/null 2>&1
}

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# ── Step 1: Load or create agent ─────────────────────────────
KEY=""
AGENT_ID=""

if [ -f "$STORE/active" ]; then
  AGENT_ID=$(cat "$STORE/active" 2>/dev/null || true)
  KEY=$(cat "$STORE/$AGENT_ID/key" 2>/dev/null || true)
fi

KEY="${CASINO_SECRET_KEY:-${KEY:-}}"
AGENT_ID="${CASINO_AGENT_ID:-${AGENT_ID:-}}"

if [ -z "${KEY:-}" ]; then
  AGENT_ID="agent_$(date +%s | tail -c 8)"
  log "Registering new agent: $AGENT_NAME ($AGENT_ID)..."
  RESP=$(curl -s --max-time 15 -X POST "$API" \
    -H "Content-Type: application/json" \
    -d "$(jq -nc --arg id "$AGENT_ID" --arg name "$AGENT_NAME" \
      '{action:"register",agent_id:$id,name:$name}')" 2>/dev/null || true)
  KEY=$(jq_get "$RESP" '.secretKey // empty')
  if [ -z "$KEY" ]; then
    log "Registration failed: $RESP"
    exit 1
  fi
  mkdir -p -m 700 "$STORE/$AGENT_ID"
  echo "$KEY" > "$STORE/$AGENT_ID/key"
  chmod 600 "$STORE/$AGENT_ID/key"
  echo "$AGENT_ID" > "$STORE/active"
  log "Registered! Agent ID: $AGENT_ID"
fi

log "Agent: $AGENT_ID | Key: ${KEY:0:8}..."

# ── Step 2: Claim chips (best-effort) ────────────────────────
curl_post '{"action":"claim"}' > /dev/null

BALANCE_RESP=$(curl_get "action=balance")
CHIPS=$(jq_get "$BALANCE_RESP" '.chips // 0' "0")
# Ensure numeric
CHIPS=$(echo "$CHIPS" | grep -E '^[0-9]+$' || echo "0")
log "Chips: $CHIPS"

# ── Step 3: Select table ──────────────────────────────────────
select_table() {
  local chips="$1"
  local stake buyin
  if [ "$chips" -gt 1000000 ] 2>/dev/null; then
    stake="high"; buyin=200000
  elif [ "$chips" -gt 200000 ] 2>/dev/null; then
    stake="mid";  buyin=100000
  else
    stake="low";  buyin=20000
  fi

  local rooms_resp room
  rooms_resp=$(curl_get "action=rooms&view=all")
  room=$(jq_get "$rooms_resp" \
    --arg s "$stake" \
    '[.rooms[] | select(.categoryId == $s and .playerCount < .maxPlayers)]
     | sort_by(-.playerCount) | .[0].id // empty')
  echo "$stake:$buyin:$room"
}

SELECTION=$(select_table "$CHIPS")
STAKE=$(echo "$SELECTION" | cut -d: -f1)
BUYIN=$(echo "$SELECTION" | cut -d: -f2)
ROOM=$(echo "$SELECTION"  | cut -d: -f3)

if [ -z "$ROOM" ]; then
  log "No available $STAKE tables — defaulting to casino_low_1"
  ROOM="casino_low_1"; BUYIN=20000
fi
log "Joining: $ROOM (stake: $STAKE, buy-in: $BUYIN)"

# ── Step 4: Join table ────────────────────────────────────────
join_table() {
  local resp
  resp=$(curl_post "$(jq -nc --arg r "$ROOM" --argjson b "$BUYIN" \
    '{action:"join",room_id:$r,buy_in:$b}')")
  log "Joined: $(jq_get "$resp" '.message // "ok"')"
}
join_table

# ── Clean exit: leave table on Ctrl-C / kill ─────────────────
_cleanup() {
  log "Leaving table..."
  curl_post "$(jq -nc --arg r "$ROOM" '{action:"leave",room_id:$r}')" > /dev/null || true
  exit 0
}
trap '_cleanup' EXIT TERM INT

# ── Step 5: Play loop ─────────────────────────────────────────
LAST_VERSION=0
HEARTBEAT_LAST=0
PREV_CHIPS=0
HAND_COUNT=0
FAIL_COUNT=0
MAX_FAILS=8

while true; do

  # ── Fetch game state (long-poll) ──
  STATE=$(curl -s --max-time 20 \
    "$API?action=game_state&room_id=$ROOM&since=$LAST_VERSION" \
    -H "Authorization: Bearer $KEY" 2>/dev/null || true)

  # Transient failure: back off and retry, never exit
  if ! is_json "$STATE" || [ -z "$STATE" ]; then
    FAIL_COUNT=$((FAIL_COUNT + 1))
    SLEEP=$((FAIL_COUNT < 5 ? FAIL_COUNT * 2 : 10))
    log "State fetch failed ($FAIL_COUNT/$MAX_FAILS), retry in ${SLEEP}s..."
    sleep "$SLEEP"
    # After too many consecutive failures, try rejoining
    if [ "$FAIL_COUNT" -ge "$MAX_FAILS" ]; then
      log "Too many failures — attempting rejoin..."
      join_table
      FAIL_COUNT=0
    fi
    continue
  fi
  FAIL_COUNT=0

  # ── Parse state ──
  PHASE=$(jq_get "$STATE" '.phase // "waiting"' "waiting")
  IS_TURN=$(jq_get "$STATE" '.is_your_turn // false' "false")
  NEW_VERSION=$(jq_get "$STATE" '.stateVersion // 0' "0")
  MY_CHIPS=$(echo "$STATE" | jq -r --arg id "$AGENT_ID" \
    '.players[]? | select(.agentId == $id) | .chips // 0' 2>/dev/null | head -1 || echo "0")
  MY_CHIPS=$(echo "$MY_CHIPS" | grep -E '^[0-9]+$' || echo "0")
  [ -n "$NEW_VERSION" ] && LAST_VERSION="$NEW_VERSION"

  # ── Auto-rejoin if kicked (not in player list) ──
  IN_TABLE=$(echo "$STATE" | jq -r --arg id "$AGENT_ID" \
    '[.players[]? | select(.agentId == $id)] | length > 0' 2>/dev/null || echo "false")
  if [ "$IN_TABLE" = "false" ] && [ "$PHASE" != "waiting" ]; then
    log "Not in player list — rejoining..."
    # Re-claim chips if busted
    if [ "${MY_CHIPS:-0}" -le 0 ] 2>/dev/null; then
      log "Busted — claiming new chips..."
      curl_post '{"action":"claim"}' > /dev/null
      sleep 2
      BALANCE_RESP=$(curl_get "action=balance")
      CHIPS=$(jq_get "$BALANCE_RESP" '.chips // 0' "0")
      CHIPS=$(echo "$CHIPS" | grep -E '^[0-9]+$' || echo "0")
      SELECTION=$(select_table "$CHIPS")
      STAKE=$(echo "$SELECTION" | cut -d: -f1)
      BUYIN=$(echo "$SELECTION" | cut -d: -f2)
      ROOM=$(echo "$SELECTION"  | cut -d: -f3)
      [ -z "$ROOM" ] && ROOM="casino_low_1" && BUYIN=20000
    fi
    join_table
    sleep 2
    continue
  fi

  # ── Heartbeat every 90s (fire-and-forget) ──
  NOW=$(date +%s)
  if [ $((NOW - HEARTBEAT_LAST)) -ge 90 ]; then
    curl_post "$(jq -nc --arg r "$ROOM" '{action:"heartbeat",room_id:$r}')" > /dev/null &
    HEARTBEAT_LAST=$NOW
  fi

  # ── Hand result report ──
  if [ "$PHASE" = "showdown" ] && [ "${PREV_CHIPS:-0}" -gt 0 ] 2>/dev/null && \
     [ "${MY_CHIPS:-0}" -gt 0 ] 2>/dev/null; then
    DIFF=$((MY_CHIPS - PREV_CHIPS)) 2>/dev/null || DIFF=0
    HAND_COUNT=$((HAND_COUNT + 1))
    WINNERS=$(jq_get "$STATE" \
      '(.winners // [])[] | "\(.name) won +\(.amount) (\(.hand.description))"' "" 2>/dev/null || true)
    if [ "$DIFF" -gt 0 ] 2>/dev/null; then
      log "WIN  HAND #$HAND_COUNT +$DIFF | Stack: $MY_CHIPS | $WINNERS"
    elif [ "$DIFF" -lt 0 ] 2>/dev/null; then
      log "LOSS HAND #$HAND_COUNT $DIFF | Stack: $MY_CHIPS | $WINNERS"
    else
      log "PUSH HAND #$HAND_COUNT | Stack: $MY_CHIPS"
    fi
    PREV_CHIPS=$MY_CHIPS
  fi

  [ "$PHASE" = "preflop" ] && [ "${PREV_CHIPS:-0}" -eq 0 ] 2>/dev/null && \
    [ "${MY_CHIPS:-0}" -gt 0 ] 2>/dev/null && PREV_CHIPS=$MY_CHIPS

  # ── Your turn: decide and act ──
  if [ "$IS_TURN" = "true" ]; then
    log "YOUR TURN | Phase: $PHASE | Pot: $(jq_get "$STATE" '.pot // 0') | Stack: $MY_CHIPS"

    # Decision logic (replace with your strategy!)
    CAN_CHECK=$(echo "$STATE" | jq '[.valid_actions[]? | select(.action=="check")] | length > 0' 2>/dev/null || echo "false")
    if [ "$CAN_CHECK" = "true" ]; then MOVE="check"; else MOVE="call"; fi

    # Act (retry once on failure)
    ACT_RESP=$(curl_post "$(jq -nc --arg r "$ROOM" --arg m "$MOVE" \
      '{action:"play",room_id:$r,move:$m}')")
    if ! is_json "$ACT_RESP" || [ "$(jq_get "$ACT_RESP" '.error // empty')" != "" ]; then
      sleep 1
      curl_post "$(jq -nc --arg r "$ROOM" --arg m "$MOVE" \
        '{action:"play",room_id:$r,move:$m}')" > /dev/null
    fi

    # Chat (best-effort)
    curl_post "$(jq -nc --arg r "$ROOM" --arg m "$MOVE" \
      '{action:"chat",room_id:$r,message:("Playing "+$m+" — your move.")}')" > /dev/null &

    PREV_CHIPS=$MY_CHIPS
  fi

done
