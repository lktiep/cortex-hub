#!/bin/bash
# Cortex Quality Tracker (v4.0) — records what actually happened, as evidence.
#
# Two things changed from v3, both of them bugs found by reading a real hook payload:
#   1. The field is `tool_response`, not `tool_output`. v3 read `tool_output`, so the
#      session id was never captured and the auto-close on exit never had anything to
#      close — on this repo `.cortex/.session-state/session-id` had never once been written.
#   2. Markers were empty files, so a `touch` was indistinguishable from a tool call and
#      the gates could be satisfied without doing any of the work. They now carry the tool
#      name and a timestamp, and the enforcement hook requires that content.
#
# Note on exit codes: PostToolUse does not fire at all when a Bash command exits non-zero,
# so a failing `pnpm build` cannot mark its gate. What it can still do is hide the failure
# behind `|| true` or a pipe, which is why the output is scanned for failure signatures.

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
mkdir -p "$STATE_DIR"

INPUT=$(cat)
COMMAND=""
TOOL_NAME=""
OUTPUT=""

if command -v jq >/dev/null 2>&1; then
  COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
  TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
  OUTPUT=$(printf '%s' "$INPUT" | jq -r '[(.tool_response // .tool_output // empty)] | tostring' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  eval "$(printf '%s' "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
r=d.get('tool_response', d.get('tool_output',''))
print(f'COMMAND={repr(d.get(\"tool_input\",{}).get(\"command\",\"\"))}')
print(f'TOOL_NAME={repr(d.get(\"tool_name\",\"\"))}')
print(f'OUTPUT={repr(json.dumps(r) if not isinstance(r,str) else r)}')
" 2>/dev/null || true)"
fi

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Evidence, not existence: the enforcement hook only accepts a marker that says who wrote it.
record() {
  printf 'tool=%s at=%s\n' "${2:-$TOOL_NAME}" "$NOW" > "$STATE_DIR/$1"
}

# A command that reports success while the build failed — `pnpm build || true`, or a pipe
# that swallows the status. If the output says it failed, the gate does not open.
looks_failed() {
  printf '%s' "$OUTPUT" | grep -Eq 'ERR_PNPM|ELIFECYCLE|error TS[0-9]|Command failed|✖|FAIL |Exit status [1-9]'
}

mark_gate() {
  looks_failed && return 0
  record "$1" "$COMMAND"
}

[[ "$COMMAND" =~ (pnpm|npm|yarn)\ build ]]    && mark_gate gate-build
[[ "$COMMAND" =~ (pnpm|npm|yarn)\ typecheck ]] && mark_gate gate-typecheck
[[ "$COMMAND" =~ (pnpm|npm|yarn)\ lint ]]      && mark_gate gate-lint
[[ "$COMMAND" =~ cargo\ build ]]               && mark_gate gate-build
[[ "$COMMAND" =~ cargo\ clippy ]]              && mark_gate gate-lint
[[ "$COMMAND" =~ go\ build ]]                  && mark_gate gate-build
[[ "$COMMAND" =~ go\ vet ]]                    && mark_gate gate-lint
[[ "$COMMAND" =~ dotnet\ build ]]              && mark_gate gate-build

# Quality gates pass when the commands passed — not when a tool was called to say so.
if [ -s "$STATE_DIR/gate-build" ] && [ -s "$STATE_DIR/gate-typecheck" ] && [ -s "$STATE_DIR/gate-lint" ]; then
  record quality-gates-passed "build+typecheck+lint"
elif [ -s "$STATE_DIR/gate-build" ] && [ -s "$STATE_DIR/gate-lint" ] && [ ! -s "$STATE_DIR/gate-typecheck" ]; then
  # Languages without a separate typecheck step (Go, Rust): build + lint is the full set.
  if [ -f "$PROJECT_DIR/.cortex/project-profile.json" ] \
     && ! grep -q '"typecheck"' "$PROJECT_DIR/.cortex/project-profile.json" 2>/dev/null; then
    record quality-gates-passed "build+lint (no typecheck in project-profile)"
  fi
fi

# ── Cortex tool calls ──
case "$TOOL_NAME" in
  *cortex_session_start*)
    record session-started
    # The id arrives inside an MCP text block, so the JSON is escaped one level deep —
    # dropping the backslashes first is what makes one pattern work for both shapes.
    SESSION_ID=$(printf '%s' "$INPUT" | tr -d '\\' \
      | grep -Eo '"session_?[iI]d"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')
    [ -n "$SESSION_ID" ] && printf '%s\n' "$SESSION_ID" > "$STATE_DIR/session-id"
    ;;
  *cortex_session_end*)    record session-ended ;;
  *cortex_quality_report*) record quality-reported ;;
  *cortex_code_search*|*cortex_code_context*|*cortex_code_impact*|*cortex_cypher*)
    record discovery-used ;;
  *cortex_knowledge_search*)
    record discovery-used; record knowledge-recalled ;;
  *cortex_memory_search*)
    record discovery-used; record memory-recalled ;;
  *cortex_task_pickup*)    record tasks-checked ;;
  *cortex_detect_changes*|*cortex_changes*) record changes-checked ;;
esac
exit 0
