#!/bin/bash
# Cortex Session End Check (v5) — Auto-closes session with activity-based summary
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"

if [ -f "$STATE_DIR/session-started" ] && [ ! -f "$STATE_DIR/session-ended" ]; then
  SESSION_ID=""
  if [ -f "$STATE_DIR/session-id" ]; then
    SESSION_ID=$(cat "$STATE_DIR/session-id" 2>/dev/null || true)
  fi

  if [ -n "$SESSION_ID" ] && [ "$SESSION_ID" != "null" ]; then
    API_URL="${CORTEX_HUB_API_URL:-http://localhost:4000}"

    # Build a meaningful summary from session activity markers
    SUMMARY="Session auto-closed (no /ce)."
    ACTIONS=""
    [ -f "$STATE_DIR/knowledge-recalled" ] && ACTIONS="${ACTIONS} knowledge-searched"
    [ -f "$STATE_DIR/memory-recalled" ] && ACTIONS="${ACTIONS} memory-searched"
    [ -f "$STATE_DIR/discovery-used" ] && ACTIONS="${ACTIONS} code-searched"
    [ -f "$STATE_DIR/changes-checked" ] && ACTIONS="${ACTIONS} changes-checked"
    [ -f "$STATE_DIR/quality-gates-passed" ] && ACTIONS="${ACTIONS} quality-passed"
    [ -f "$STATE_DIR/tasks-checked" ] && ACTIONS="${ACTIONS} tasks-checked"
    [ -n "$ACTIONS" ] && SUMMARY="Session auto-closed. Activity:${ACTIONS}."

    # Best-effort auto-close with activity summary
    curl -X POST "${API_URL}/api/sessions/${SESSION_ID}/end" \
      -H 'Content-Type: application/json' \
      -d "{\"summary\":\"${SUMMARY}\"}" \
      --connect-timeout 5 \
      -s -o /dev/null \
      || true

    touch "$STATE_DIR/session-ended"
    echo "INFO: Session $SESSION_ID auto-closed.${ACTIONS:+ Activities:${ACTIONS}}"
  else
    echo "WARNING: Session not ended — no session ID found. Run /ce next time."
  fi
fi
exit 0
