#!/bin/bash
# Cortex Session End Check (v6) — Gemini variant.
#
# v3 only printed a warning, which nothing reads once the session is over, so every gemini
# session stayed open forever on the hub. This closes it.
# An explicit project dir beats guessing: `git rev-parse` points at the main checkout from
# inside a worktree, and at whatever repo the tests happen to run from.
PROJECT_DIR="${CORTEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"

[ -f "$STATE_DIR/session-started" ] || exit 0
[ -f "$STATE_DIR/session-ended" ] && exit 0

SESSION_ID=""
[ -s "$STATE_DIR/session-id" ] && SESSION_ID=$(cat "$STATE_DIR/session-id" 2>/dev/null || true)
if [ -z "$SESSION_ID" ] || [ "$SESSION_ID" = "null" ]; then
  echo '{"systemMessage":"WARNING: cortex session not closed — no session id was recorded. Call cortex_session_end."}'
  exit 0
fi

API_URL="${CORTEX_HUB_API_URL:-http://localhost:4000}"
ACTIONS=""
[ -s "$STATE_DIR/knowledge-recalled" ]   && ACTIONS="${ACTIONS} knowledge-searched"
[ -s "$STATE_DIR/memory-recalled" ]      && ACTIONS="${ACTIONS} memory-searched"
[ -s "$STATE_DIR/discovery-used" ]       && ACTIONS="${ACTIONS} code-searched"
[ -s "$STATE_DIR/changes-checked" ]      && ACTIONS="${ACTIONS} changes-checked"
[ -s "$STATE_DIR/quality-gates-passed" ] && ACTIONS="${ACTIONS} quality-passed"
[ -s "$STATE_DIR/quality-reported" ]     && ACTIONS="${ACTIONS} quality-reported"
[ -s "$STATE_DIR/tasks-checked" ]        && ACTIONS="${ACTIONS} tasks-checked"

SUMMARY="Session auto-closed (gemini, no cortex_session_end)."
[ -n "$ACTIONS" ] && SUMMARY="Session auto-closed (gemini). Activity:${ACTIONS}."
curl -X POST "${API_URL}/api/sessions/${SESSION_ID}/end" \
  -H 'Content-Type: application/json' -d "{\"summary\":\"${SUMMARY}\"}" \
  --connect-timeout 5 -s -o /dev/null || true
touch "$STATE_DIR/session-ended"
echo '{"systemMessage":"INFO: cortex session closed."}'
