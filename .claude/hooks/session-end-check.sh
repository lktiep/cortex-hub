#!/bin/bash
# Cortex Session End Check (v4) — Auto-closes session on Stop if user didn't run /ce
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"

if [ -f "$STATE_DIR/session-started" ] && [ ! -f "$STATE_DIR/session-ended" ]; then
  SESSION_ID=""
  if [ -f "$STATE_DIR/session-id" ]; then
    SESSION_ID=$(cat "$STATE_DIR/session-id" 2>/dev/null || true)
  fi

  if [ -n "$SESSION_ID" ] && [ "$SESSION_ID" != "null" ]; then
    # Determine API URL: env var > default localhost
    API_URL="${CORTEX_HUB_API_URL:-http://localhost:4000}"
    ENDPOINT="${API_URL}/api/sessions/${SESSION_ID}/end"

    # Best-effort auto-close — don't fail the hook if API is unreachable
    curl -X POST "$ENDPOINT" \
      -H 'Content-Type: application/json' \
      -d '{"summary":"Session auto-closed by Stop hook (user did not run /ce)"}' \
      --connect-timeout 5 \
      -s \
      -o /dev/null \
      || true

    touch "$STATE_DIR/session-ended"
    echo "INFO: Session $SESSION_ID auto-closed by Stop hook."
  else
    echo "WARNING: cortex_session_end not called and no session ID found — session could not be auto-closed."
  fi
fi
exit 0
