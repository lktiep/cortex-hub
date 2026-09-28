#!/bin/bash
# Cortex Commit Enforcement (v5.0) — a commit needs the workflow behind it.
#
# v4 accepted `quality-gates-passed`, which the tracker used to write the moment
# cortex_quality_report was called — so reporting a failure unlocked the commit just as
# well as passing. The marker now comes only from build/typecheck/lint actually running
# green, and the report is a separate, softer expectation.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
INPUT=$(cat)
COMMAND=""
if command -v jq >/dev/null 2>&1; then
  COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  COMMAND=$(printf '%s' "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null || true)
fi
[[ ! "$COMMAND" =~ ^git\ (commit|push) ]] && exit 0

if [[ "$COMMAND" =~ ^git\ commit ]]; then
  MISSING=""
  [ ! -f "$STATE_DIR/session-started" ] && MISSING="${MISSING}\n  - cortex_session_start (not called)"
  [ ! -s "$STATE_DIR/discovery-used" ] && MISSING="${MISSING}\n  - cortex_code_search / code_context / knowledge_search (no discovery recorded — search before you edit)"
  [ ! -s "$STATE_DIR/quality-gates-passed" ] && MISSING="${MISSING}\n  - Quality gates: run build, typecheck and lint and let them pass (calling cortex_quality_report no longer counts)"
  if [ -n "$MISSING" ]; then
    echo "BLOCKED: cannot commit — missing Cortex workflow steps:${MISSING}" >&2
    echo "" >&2
    echo "See the 'Finding code fast' and 'Quality Gates' sections of CLAUDE.md." >&2
    exit 2
  fi
  [ ! -s "$STATE_DIR/quality-reported" ] && echo "REMINDER: call cortex_quality_report with the gate results so the dashboard sees this session." >&2
fi

if [[ "$COMMAND" =~ ^git\ push ]]; then
  echo "REMINDER: after push, call cortex_code_reindex so code intelligence matches what you pushed." >&2
fi
exit 0
