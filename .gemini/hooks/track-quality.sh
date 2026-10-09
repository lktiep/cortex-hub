#!/bin/bash
# Cortex Quality Tracker (v4.1) — Gemini variant.
#
# Two bugs from v3: cortex_quality_report touched quality-gates-passed, so reporting a failure
# counted as passing; and every marker was an empty `touch`, which the enforcement hook could not
# tell apart from a forged one. Markers now carry the tool and time that produced them, a gate is
# only marked when the command output does not look like a failure, and the cortex session id is
# captured so the session can actually be closed.
# An explicit project dir beats guessing: `git rev-parse` points at the main checkout from
# inside a worktree, and at whatever repo the tests happen to run from.
PROJECT_DIR="${CORTEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
mkdir -p "$STATE_DIR"
INPUT=$(cat)

TOOL_NAME=""; COMMAND=""; OUTPUT=""
if command -v jq >/dev/null 2>&1; then
  TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
  COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
  OUTPUT=$(printf '%s' "$INPUT" | jq -r '[(.tool_response // .tool_output // empty)] | tostring' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  eval "$(printf '%s' "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(f'TOOL_NAME={repr(d.get(\"tool_name\",\"\"))}')
print(f'COMMAND={repr(d.get(\"tool_input\",{}).get(\"command\",\"\"))}')
print(f'OUTPUT={repr(json.dumps(d.get(\"tool_response\", d.get(\"tool_output\",\"\"))))}')
" 2>/dev/null || true)"
fi

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
record() { printf 'tool=%s at=%s\n' "${2:-$TOOL_NAME}" "$NOW" > "$STATE_DIR/$1"; }
looks_failed() {
  printf '%s' "$OUTPUT" | grep -Eq 'ERR_PNPM|ELIFECYCLE|error TS[0-9]|Command failed|✖|FAIL |Exit status [1-9]'
}
# 1 = this command is not one of the quality gates. mark_gate flips it, and the
# invalidation block at the bottom reads it, so `pnpm build | tee build.log` does not
# revoke the very marker it just armed.
GATE_COMMAND=1
mark_gate() { GATE_COMMAND=0; looks_failed && return 0; record "$1" "$COMMAND"; }

[[ "$COMMAND" =~ (pnpm|npm|yarn)\ .*build ]]     && mark_gate gate-build
[[ "$COMMAND" =~ (pnpm|npm|yarn)\ .*typecheck ]] && mark_gate gate-typecheck
[[ "$COMMAND" =~ (pnpm|npm|yarn)\ .*lint ]]      && mark_gate gate-lint
if [ -s "$STATE_DIR/gate-build" ] && [ -s "$STATE_DIR/gate-typecheck" ] && [ -s "$STATE_DIR/gate-lint" ]; then
  record quality-gates-passed "build+typecheck+lint"
fi

case "$TOOL_NAME" in
  *cortex_session_start*)
    record session-started
    # Only a hub id: every hook payload opens with the IDE's own "session_id" (a conversation
    # uuid), and `head -1` used to take that one, so the exit hook tried to close a session
    # the hub had never heard of. The hub mints nothing but sess_… ids.
    SESSION_ID=$(printf '%s' "$INPUT" | tr -d '\\' \
      | grep -Eo '"session_?[iI]d"[[:space:]]*:[[:space:]]*"sess_[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')
    [ -n "$SESSION_ID" ] && printf '%s\n' "$SESSION_ID" > "$STATE_DIR/session-id"
    # A new hub session is open, so an earlier one's "ended" no longer applies — left in
    # place it made the exit hook skip this session too.
    rm -f "$STATE_DIR/session-ended"
    ;;
  *cortex_session_end*)    record session-ended ;;
  *cortex_quality_report*) record quality-reported ;;
  *cortex_code_search*|*cortex_code_context*|*cortex_code_impact*|*cortex_cypher*)
    record discovery-used ;;
  # Recall is not discovery: it answers "why" and "has this broken before", not "where is the
  # code". Arming discovery-used here would let /cs alone open glob and search_file_content.
  *cortex_knowledge_search*) record knowledge-recalled ;;
  *cortex_memory_search*)    record memory-recalled ;;
  *cortex_task_pickup*)      record tasks-checked ;;
  *cortex_detect_changes*|*cortex_changes*) record changes-checked ;;
esac

# ── A passing build certifies a tree, not a session ──
#
# The gate markers used to survive any edit made after them, so
# "pnpm build && typecheck && lint" → edit one file → `git commit` passed the commit
# gate with code that had never been checked. Reproduced in a sandbox: arming the
# three gates, then feeding an a write_file, left quality-gates-passed armed and the commit
# gate returned 0. A write invalidates the certificate — the gates have to run again
# on the tree that is actually being committed.
writes_a_file() {
  printf '%s' "$1" | grep -Eq '(^|[;&|]{1,2}[[:space:]]*)[[:space:]]*(sed[[:space:]]+-i|tee[[:space:]]|dd[[:space:]]|truncate[[:space:]]|install[[:space:]]+-)' && return 0
  local cmd
  cmd=$(printf '%s' "$1" | sed -E 's/[0-9]*>>?[[:space:]]*&[0-9-]//g; s/[0-9]*>>?[[:space:]]*"?\/dev\/[a-zA-Z0-9]+"?//g')
  printf '%s' "$cmd" | grep -Eq '>>?[[:space:]]*"?[^&|"[:space:]]' && return 0
  printf '%s' "$1" | grep -Eq '(^|[;&|]{1,2}[[:space:]]*)[[:space:]]*(cp|mv|rm|mkdir|touch|patch|git[[:space:]]+apply)[[:space:]]' && return 0
  return 1
}
INVALIDATES=0
case "$TOOL_NAME" in
  write_file|replace|edit_file|create_file|insert_text) INVALIDATES=1 ;;
  run_shell_command|shell)
    # Editing through a shell is still editing. But a gate command that pipes its own
    # output to a file must not revoke the marker it just armed one screen above.
    if [ "$GATE_COMMAND" = "1" ] && writes_a_file "$COMMAND"; then
      INVALIDATES=1
    fi
    ;;
esac
if [ "$INVALIDATES" = "1" ]; then
  rm -f "$STATE_DIR/quality-gates-passed" "$STATE_DIR/gate-build" \
        "$STATE_DIR/gate-typecheck" "$STATE_DIR/gate-lint"
fi
echo '{"decision":"allow"}'
