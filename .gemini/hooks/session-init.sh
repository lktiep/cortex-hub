#!/bin/bash
# Cortex Session Init (v7.1) — Gemini variant.
#
# v3 wiped the gate markers on every SessionStart. Where the host distinguishes a resumed or
# compacted session from a fresh one, re-arming the discovery gate mid-task is a bug: the agent
# already did the recall, and it cannot prove it any more. v3 also never cleared changes-checked
# or tasks-checked, so those markers survived for months and the checks silently stopped running.
#
# And it cleared session-started on every start, which is right — but the claude variant used to
# create it here instead, making its whole session gate vacuous. Only the tracker writes it, from
# a real cortex_session_start call.
# An explicit project dir beats guessing: `git rev-parse` points at the main checkout from
# inside a worktree, and at whatever repo the tests happen to run from.
PROJECT_DIR="${CORTEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
mkdir -p "$STATE_DIR"

INPUT=$(cat 2>/dev/null || true)
SOURCE=""
if [ -n "$INPUT" ]; then
  if command -v jq >/dev/null 2>&1; then
    SOURCE=$(printf '%s' "$INPUT" | jq -r '.source // empty' 2>/dev/null || true)
  elif command -v python3 >/dev/null 2>&1; then
    SOURCE=$(printf '%s' "$INPUT" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("source",""))' 2>/dev/null || true)
  fi
fi

case "$SOURCE" in
  compact|resume)
    echo '{"systemMessage":"Cortex: same session ('"$SOURCE"') — discovery state kept."}'
    exit 0 ;;
esac

rm -f "$STATE_DIR/session-started" "$STATE_DIR/quality-gates-passed" \
      "$STATE_DIR/gate-build" "$STATE_DIR/gate-typecheck" "$STATE_DIR/gate-lint" \
      "$STATE_DIR/quality-reported" "$STATE_DIR/session-ended" \
      "$STATE_DIR/discovery-used" "$STATE_DIR/knowledge-recalled" \
      "$STATE_DIR/memory-recalled" "$STATE_DIR/changes-checked" \
      "$STATE_DIR/tasks-checked" "$STATE_DIR/gate-off" "$STATE_DIR/session-id" 2>/dev/null
echo '{"systemMessage":"MANDATORY: call cortex_session_start, then cortex_knowledge_search + cortex_memory_search, before any edit. search_file_content and glob stay blocked until a cortex discovery tool has run."}'
