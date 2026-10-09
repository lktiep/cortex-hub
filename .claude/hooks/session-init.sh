#!/bin/bash
# Cortex Session Init (v7.2) — arms the gates; keeps discovery state across compaction.
#
# SessionStart fires on four different things: startup, resume, clear and compact.
# Wiping the discovery markers on all four is why a long task suddenly finds Grep and
# Edit blocked again halfway through itself — the context was compacted, the work was
# not restarted. Only a genuinely new session clears the gates.
#
# v7.0 also touched `session-started` here, which made the whole session gate vacuous: the
# marker existed before cortex_session_start had ever been called, so the "no session yet"
# branch of enforce-session.sh was dead code and enforce-commit.sh's session check always
# passed. Only the tracker writes that marker now, from a real cortex_session_start call.
#
# v7.2 prints this conversation's id for /cs to pass as clientSessionId. Everything else the
# hub matches a session on is the same for two conversations in one checkout, so without it
# they shared one session, and the first to finish closed it under the other.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
mkdir -p "$STATE_DIR"

INPUT=$(cat 2>/dev/null || true)
SOURCE=""
CLIENT_ID=""
if [ -n "$INPUT" ]; then
  if command -v jq >/dev/null 2>&1; then
    SOURCE=$(printf '%s' "$INPUT" | jq -r '.source // empty' 2>/dev/null || true)
    CLIENT_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
  elif command -v python3 >/dev/null 2>&1; then
    SOURCE=$(printf '%s' "$INPUT" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("source",""))' 2>/dev/null || true)
    CLIENT_ID=$(printf '%s' "$INPUT" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("session_id",""))' 2>/dev/null || true)
  fi
fi
# The same id the tracker and the exit hook file this conversation's session under.
CLIENT_ID=$(printf '%s' "$CLIENT_ID" | tr -cd 'A-Za-z0-9_-' | cut -c1-128)
conversation_line() {
  [ -n "$CLIENT_ID" ] && echo "Cortex: this conversation's clientSessionId is ${CLIENT_ID} — pass it to cortex_session_start."
}

case "$SOURCE" in
  compact|resume)
    echo "Cortex: same session (${SOURCE}) — discovery state kept, gates stay as they were."
    conversation_line
    exit 0 ;;
esac

# A new session: everything from the last one is stale, including the markers that
# were never reset before and so stayed satisfied for months.
rm -f "$STATE_DIR/session-started" \
      "$STATE_DIR/quality-gates-passed" \
      "$STATE_DIR/gate-build" "$STATE_DIR/gate-typecheck" "$STATE_DIR/gate-lint" \
      "$STATE_DIR/quality-reported" \
      "$STATE_DIR/session-ended" "$STATE_DIR/discovery-used" \
      "$STATE_DIR/knowledge-recalled" "$STATE_DIR/memory-recalled" \
      "$STATE_DIR/changes-checked" "$STATE_DIR/tasks-checked" \
      "$STATE_DIR/gate-off" "$STATE_DIR/session-id" 2>/dev/null
# Other conversations' sessions stay theirs to close; only records a week old are dropped,
# left by a conversation that ended without the exit hook getting through.
[ -d "$STATE_DIR/conversations" ] && find "$STATE_DIR/conversations" -type f -mtime +7 -exec rm -f {} + 2>/dev/null
echo "Run /cs first: cortex_session_start, then knowledge+memory recall. Until then edits are BLOCKED, and Grep/Glob stay blocked until a cortex discovery tool has run."
conversation_line
exit 0
