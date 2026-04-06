#!/bin/bash
# Cortex Quality Tracker (v3) — Marks gates as passed

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
mkdir -p "$STATE_DIR"

INPUT=$(cat)
COMMAND=""
TOOL_NAME=""

if command -v jq >/dev/null 2>&1; then
  COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
  TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  eval "$(echo "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(f'COMMAND={repr(d.get(\"tool_input\",{}).get(\"command\",\"\"))}')
print(f'TOOL_NAME={repr(d.get(\"tool_name\",\"\"))}')
" 2>/dev/null || true)"
fi

# Track build gates
[[ "$COMMAND" =~ (pnpm|npm|yarn)\ build ]]     && touch "$STATE_DIR/gate-build"
[[ "$COMMAND" =~ (pnpm|npm|yarn)\ typecheck ]]  && touch "$STATE_DIR/gate-typecheck"
[[ "$COMMAND" =~ (pnpm|npm|yarn)\ lint ]]       && touch "$STATE_DIR/gate-lint"
[[ "$COMMAND" =~ cargo\ build ]]                && touch "$STATE_DIR/gate-build"
[[ "$COMMAND" =~ cargo\ clippy ]]               && touch "$STATE_DIR/gate-lint"
[[ "$COMMAND" =~ go\ build ]]                   && touch "$STATE_DIR/gate-build"
[[ "$COMMAND" =~ go\ vet ]]                     && touch "$STATE_DIR/gate-lint"
[[ "$COMMAND" =~ dotnet\ build ]]               && touch "$STATE_DIR/gate-build"

# All gates passed?
if [ -f "$STATE_DIR/gate-build" ] && [ -f "$STATE_DIR/gate-typecheck" ] && [ -f "$STATE_DIR/gate-lint" ]; then
  touch "$STATE_DIR/quality-gates-passed"
fi
# For projects without typecheck (Go, Rust, etc.) — build + lint = passed
if [ -f "$STATE_DIR/gate-build" ] && [ -f "$STATE_DIR/gate-lint" ] && [ ! -f "$STATE_DIR/gate-typecheck" ]; then
  # Check if project has typecheck command
  if [ -f ".cortex/project-profile.json" ]; then
    HAS_TYPECHECK=$(grep -c "typecheck" .cortex/project-profile.json 2>/dev/null || echo "0")
    [ "$HAS_TYPECHECK" = "0" ] && touch "$STATE_DIR/quality-gates-passed"
  fi
fi

# Track MCP tool calls
[[ "$TOOL_NAME" =~ cortex_session_start ]]  && touch "$STATE_DIR/session-started"
[[ "$TOOL_NAME" =~ cortex_session_end ]]    && touch "$STATE_DIR/session-ended"
[[ "$TOOL_NAME" =~ cortex_quality_report ]] && touch "$STATE_DIR/quality-gates-passed"

# Track cortex discovery tool usage
[[ "$TOOL_NAME" =~ cortex_code_search ]]      && touch "$STATE_DIR/discovery-used"
[[ "$TOOL_NAME" =~ cortex_knowledge_search ]] && touch "$STATE_DIR/discovery-used" && touch "$STATE_DIR/knowledge-recalled"
[[ "$TOOL_NAME" =~ cortex_memory_search ]]    && touch "$STATE_DIR/discovery-used" && touch "$STATE_DIR/memory-recalled"
[[ "$TOOL_NAME" =~ cortex_code_context ]]     && touch "$STATE_DIR/discovery-used"
[[ "$TOOL_NAME" =~ cortex_code_impact ]]      && touch "$STATE_DIR/discovery-used"
[[ "$TOOL_NAME" =~ cortex_cypher ]]           && touch "$STATE_DIR/discovery-used"
[[ "$TOOL_NAME" =~ cortex_task_pickup ]]      && touch "$STATE_DIR/tasks-checked"
[[ "$TOOL_NAME" =~ cortex_detect_changes ]]   && touch "$STATE_DIR/changes-checked"
exit 0
