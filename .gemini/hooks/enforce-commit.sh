#!/bin/bash
# Cortex Commit Enforcement (v5.0) — Gemini variant.
#
# v3 accepted quality-gates-passed, which the tracker wrote the moment cortex_quality_report was
# called — so reporting a failure unlocked the commit just as well as passing. The marker now
# comes only from build/typecheck/lint actually running green.
# An explicit project dir beats guessing: `git rev-parse` points at the main checkout from
# inside a worktree, and at whatever repo the tests happen to run from.
PROJECT_DIR="${CORTEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
INPUT=$(cat)
COMMAND=""
if command -v jq >/dev/null 2>&1; then
  COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  COMMAND=$(printf '%s' "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null || true)
fi
[[ ! "$COMMAND" =~ ^git\ commit ]] && { echo '{"decision":"allow"}'; exit 0; }

MISSING=""
[ ! -f "$STATE_DIR/session-started" ]      && MISSING="${MISSING} cortex_session_start;"
[ ! -s "$STATE_DIR/discovery-used" ]       && MISSING="${MISSING} discovery (cortex_code_search / code_context / knowledge_search);"
[ ! -s "$STATE_DIR/quality-gates-passed" ] && MISSING="${MISSING} quality gates green (build, typecheck, lint — calling cortex_quality_report does not count);"
if [ -n "$MISSING" ]; then
  printf '{"decision":"deny","reason":"BLOCKED: cannot commit — missing Cortex workflow steps:%s"}\n' "$MISSING"
  exit 0
fi
echo '{"decision":"allow"}'
