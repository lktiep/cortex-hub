#!/bin/bash
# Cortex Quality Tracker (v4.0) — Gemini variant.
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
mark_gate() { looks_failed && return 0; record "$1" "$COMMAND"; }

[[ "$COMMAND" =~ (pnpm|npm|yarn)\ .*build ]]     && mark_gate gate-build
[[ "$COMMAND" =~ (pnpm|npm|yarn)\ .*typecheck ]] && mark_gate gate-typecheck
[[ "$COMMAND" =~ (pnpm|npm|yarn)\ .*lint ]]      && mark_gate gate-lint
if [ -s "$STATE_DIR/gate-build" ] && [ -s "$STATE_DIR/gate-typecheck" ] && [ -s "$STATE_DIR/gate-lint" ]; then
  record quality-gates-passed "build+typecheck+lint"
fi

case "$TOOL_NAME" in
  *cortex_session_start*)
    record session-started
    SESSION_ID=$(printf '%s' "$INPUT" | tr -d '\\' \
      | grep -Eo '"session_?[iI]d"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')
    [ -n "$SESSION_ID" ] && printf '%s\n' "$SESSION_ID" > "$STATE_DIR/session-id"
    ;;
  *cortex_session_end*)    record session-ended ;;
  *cortex_quality_report*) record quality-reported ;;
  *cortex_code_search*|*cortex_code_context*|*cortex_code_impact*|*cortex_cypher*)
    record discovery-used ;;
  *cortex_knowledge_search*) record discovery-used; record knowledge-recalled ;;
  *cortex_memory_search*)    record discovery-used; record memory-recalled ;;
  *cortex_task_pickup*)      record tasks-checked ;;
  *cortex_detect_changes*|*cortex_changes*) record changes-checked ;;
esac
echo '{"decision":"allow"}'
