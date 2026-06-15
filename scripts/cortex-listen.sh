#!/bin/bash
# Cortex Listen — lightweight task listener for use INSIDE Claude Code
# Runs in background, prints task notifications to stderr (visible in terminal)
#
# Usage (from Claude Code):
#   bash scripts/cortex-listen.sh &    # start listener in background
#   kill %1                             # stop listener
#
# When task found, prints to terminal so agent sees it in next response.

set -euo pipefail

API_KEY="${HUB_API_KEY:-}"
[ -z "$API_KEY" ] && [ -f ".env" ] && API_KEY=$(grep '^HUB_API_KEY=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' || true)
[ -z "$API_KEY" ] && API_KEY=$(python3 -c "import json; print(json.load(open('$HOME/.claude.json'))['mcpServers']['cortex-hub']['env'].get('HUB_API_KEY',''))" 2>/dev/null || true)

MCP_URL="${HUB_MCP_URL:-http://localhost:8318/mcp}"
INTERVAL="${1:-10}"

echo "[listen] Cortex task listener started (poll every ${INTERVAL}s)" >&2
echo "[listen] Press Ctrl+C or kill %1 to stop" >&2

while true; do
  RESPONSE=$(curl -s --max-time 10 -X POST "$MCP_URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Authorization: Bearer $API_KEY" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"cortex_task_pickup","arguments":{}}}' 2>/dev/null || echo "")

  if echo "$RESPONSE" | grep -q "TASK\|task_"; then
    echo "" >&2
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
    echo "🔔 NEW TASK ASSIGNED!" >&2
    echo "$RESPONSE" | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  text=d.get('result',{}).get('content',[{}])[0].get('text','')
  print(text, file=sys.stderr)
except: pass
" 2>/dev/null
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
  fi

  sleep "$INTERVAL"
done
