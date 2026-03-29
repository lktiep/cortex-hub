#!/bin/bash
# Cortex Commit Enforcement (v3) — Blocks commit without quality gates

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"

INPUT=$(cat)
COMMAND=""
if command -v jq >/dev/null 2>&1; then
  COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  COMMAND=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null || true)
fi

[[ ! "$COMMAND" =~ ^git\ (commit|push) ]] && exit 0

if [[ "$COMMAND" =~ ^git\ commit ]]; then
  if [ ! -f "$STATE_DIR/quality-gates-passed" ]; then
    echo "BLOCKED: Quality gates not passed. Run build/typecheck/lint first, then call cortex_quality_report." >&2
    exit 2
  fi
fi

if [[ "$COMMAND" =~ ^git\ push ]]; then
  echo "REMINDER: After push, call cortex_code_reindex to update code intelligence." >&2
fi
exit 0
