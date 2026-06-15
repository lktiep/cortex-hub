#!/bin/bash
# Cortex Worker Daemon — Background task executor
# Polls for assigned tasks and executes them with claude -p
#
# Usage:
#   bash scripts/cortex-worker.sh                    # Default agent name from hostname
#   bash scripts/cortex-worker.sh --name "extractor" # Custom agent name
#   bash scripts/cortex-worker.sh --engine codex     # Use codex instead of claude
#   bash scripts/cortex-worker.sh --interval 60      # Poll every 60s
#   bash scripts/cortex-worker.sh --once              # Run once then exit
#
# Requires: HUB_API_KEY env var or .env file, claude CLI or codex CLI

set -euo pipefail

# ── Parse args ──────────────────────────────────────────────────────────────
AGENT_NAME="${HOSTNAME:-worker}"
ENGINE="claude"
POLL_INTERVAL=30
RUN_ONCE=false
MCP_URL="${HUB_MCP_URL:-http://localhost:8318/mcp}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)     AGENT_NAME="$2"; shift 2 ;;
    --engine)   ENGINE="$2"; shift 2 ;;
    --interval) POLL_INTERVAL="$2"; shift 2 ;;
    --once)     RUN_ONCE=true; shift ;;
    --help|-h)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *) echo "[worker] Unknown flag: $1 (ignored)"; shift ;;
  esac
done

# ── Colors (disabled when not a tty) ───────────────────────────────────────
if [ -t 1 ]; then
  GREEN='\033[0;32m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
else
  GREEN=''; RED=''; BLUE=''; NC=''
fi

log()  { echo -e "${BLUE}[worker $(date +%H:%M:%S)]${NC} $*"; }
ok()   { echo -e "${GREEN}[worker $(date +%H:%M:%S)]${NC} $*"; }
err()  { echo -e "${RED}[worker $(date +%H:%M:%S)]${NC} $*" >&2; }

# ── Resolve API key ────────────────────────────────────────────────────────
API_KEY="${HUB_API_KEY:-}"
if [ -z "$API_KEY" ] && [ -f "$PROJECT_ROOT/.env" ]; then
  API_KEY=$(grep '^HUB_API_KEY=' "$PROJECT_ROOT/.env" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
fi
if [ -z "$API_KEY" ]; then
  err "HUB_API_KEY not set and no .env found. Export it or add to $PROJECT_ROOT/.env"
  exit 1
fi

# ── Validate engine CLI is available ────────────────────────────────────────
if ! command -v "$ENGINE" >/dev/null 2>&1; then
  err "$ENGINE CLI not found in PATH. Install it first."
  exit 1
fi

# ── MCP JSON-RPC helper ────────────────────────────────────────────────────
# Sends a tools/call request and returns the raw JSON response.
# Usage: mcp_call <tool_name> <json_arguments>
mcp_call() {
  local tool="$1" args="$2"
  local payload
  payload=$(cat <<ENDJSON
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"$tool","arguments":$args}}
ENDJSON
)
  curl -s --max-time 30 -X POST "$MCP_URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Authorization: Bearer $API_KEY" \
    -d "$payload" 2>/dev/null || echo '{"error":"network_failure"}'
}

# Extract .result.content[0].text from an MCP response (requires jq)
mcp_text() {
  local resp="$1"
  if command -v jq >/dev/null 2>&1; then
    echo "$resp" | jq -r '.result.content[0].text // ""' 2>/dev/null || echo ""
  else
    # Fallback: rough extraction without jq
    echo "$resp" | sed -n 's/.*"text":"\([^"]*\)".*/\1/p' | head -1
  fi
}

# ── Graceful shutdown ──────────────────────────────────────────────────────
RUNNING=true
cleanup() {
  log "Shutting down..."
  RUNNING=false
}
trap cleanup SIGINT SIGTERM

# ── Execute a task with the chosen engine ──────────────────────────────────
execute_task() {
  local task_text="$1"
  local exit_code=0

  log "Executing task with $ENGINE..."

  if [ "$ENGINE" = "claude" ]; then
    claude -p "$task_text" \
      --allowedTools "Bash,Read,Write,Edit" \
      --max-turns 20 \
      --output-format json 2>/dev/null || exit_code=$?
  elif [ "$ENGINE" = "codex" ]; then
    codex exec "$task_text" 2>/dev/null || exit_code=$?
  else
    err "Unknown engine: $ENGINE"
    exit_code=1
  fi

  return $exit_code
}

# ── Report task result back to Hub ─────────────────────────────────────────
report_result() {
  local task_id="$1" status="$2" summary="$3"
  mcp_call "cortex_task_update" "{\"taskId\":\"$task_id\",\"status\":\"$status\",\"result\":\"$summary\",\"agentId\":\"$AGENT_NAME\"}" >/dev/null 2>&1
}

# ── Main loop ──────────────────────────────────────────────────────────────
log "Starting daemon: agent=$AGENT_NAME engine=$ENGINE interval=${POLL_INTERVAL}s mcp=$MCP_URL"

while $RUNNING; do
  # Poll for a task
  RESPONSE=$(mcp_call "cortex_task_pickup" "{\"agentId\":\"$AGENT_NAME\"}")

  # Check for errors
  if echo "$RESPONSE" | grep -q '"error"'; then
    err "API error — will retry in ${POLL_INTERVAL}s"
    sleep "$POLL_INTERVAL"
    [ "$RUN_ONCE" = "true" ] && exit 1
    continue
  fi

  TASK_TEXT=$(mcp_text "$RESPONSE")

  if [ -z "$TASK_TEXT" ] || ! echo "$TASK_TEXT" | grep -qi "task"; then
    log "No tasks available. Sleeping ${POLL_INTERVAL}s..."
    [ "$RUN_ONCE" = "true" ] && exit 0
    sleep "$POLL_INTERVAL"
    continue
  fi

  ok "Task found!"

  # Try to extract a task ID (best-effort parse)
  TASK_ID=""
  if command -v jq >/dev/null 2>&1; then
    TASK_ID=$(echo "$RESPONSE" | jq -r '.result.content[0].text' 2>/dev/null \
      | jq -r '.taskId // .id // ""' 2>/dev/null || echo "")
  fi

  # Execute
  TASK_OUTPUT=""
  if TASK_OUTPUT=$(execute_task "$TASK_TEXT" 2>&1); then
    ok "Task completed successfully"
    [ -n "$TASK_ID" ] && report_result "$TASK_ID" "completed" "Task executed successfully by $AGENT_NAME"
  else
    err "Task execution failed (exit $?)"
    [ -n "$TASK_ID" ] && report_result "$TASK_ID" "failed" "Execution error on $AGENT_NAME"
  fi

  [ "$RUN_ONCE" = "true" ] && exit 0
  sleep 2  # brief cooldown before next poll
done

log "Daemon stopped."
