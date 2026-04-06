#!/bin/bash
# Cortex Session Enforcement (v5.0) — BLOCK tools until cortex workflow followed
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"

# Session started — enforce discovery-first + knowledge/memory recall
if [ -f "$STATE_DIR/session-started" ]; then
  if [ ! -f "$STATE_DIR/discovery-used" ]; then
    INPUT_PEEK=$(cat)
    PEEK_TOOL=$(echo "$INPUT_PEEK" | jq -r '.tool_name // empty' 2>/dev/null || true)
    PEEK_CMD=$(echo "$INPUT_PEEK" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
    if [[ "$PEEK_TOOL" = "Grep" ]]; then
      echo "BLOCKED: Use cortex_code_search or cortex_knowledge_search FIRST. Grep unlocked after cortex discovery tools. Run /cs to auto-complete all steps." >&2
      exit 2
    fi
    if [[ "$PEEK_TOOL" = "Bash" ]] && [[ "$PEEK_CMD" =~ ^(find |grep |rg |ag ) ]]; then
      echo "BLOCKED: Use cortex_code_search FIRST. find/grep unlocked after cortex discovery tools. Run /cs to auto-complete all steps." >&2
      exit 2
    fi
    # Block edits until knowledge + memory recalled (full /cs workflow)
    if [[ "$PEEK_TOOL" = "Edit" || "$PEEK_TOOL" = "Write" ]]; then
      if [ ! -f "$STATE_DIR/knowledge-recalled" ] || [ ! -f "$STATE_DIR/memory-recalled" ]; then
        echo "BLOCKED: Run cortex_knowledge_search and cortex_memory_search before editing. These restore context from previous sessions. Run /cs to auto-complete all steps." >&2
        exit 2
      fi
    fi
  fi
  exit 0
fi

# Session NOT started — block writes, allow reads
INPUT=$(cat)
TOOL_NAME=""
COMMAND=""
if command -v jq >/dev/null 2>&1; then
  TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
  COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  eval "$(echo "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(f'TOOL_NAME={repr(d.get(\"tool_name\",\"\"))}')
print(f'COMMAND={repr(d.get(\"tool_input\",{}).get(\"command\",\"\"))}')
" 2>/dev/null || true)"
fi

[ -z "$TOOL_NAME" ] && { echo "BLOCKED: Cannot parse hook input." >&2; exit 2; }

case "$TOOL_NAME" in
  Edit|Write|NotebookEdit)
    echo "BLOCKED: Call cortex_session_start first (or run /cs). No edits allowed without session." >&2
    exit 2 ;;
  Bash)
    # Allow safe read-only commands
    [[ "$COMMAND" =~ ^(ls|cat|head|tail|pwd|which|echo|git\ (status|log|diff|branch|remote|show)|pnpm\ |npm\ |yarn\ |cargo\ |go\ |python|curl|dotnet\ |node\ ) ]] && exit 0
    # Block write commands
    [[ "$COMMAND" =~ (git\ (add|commit|push|reset)|rm\ |mv\ |cp\ |mkdir\ |touch\ |chmod\ |sed\ -i) ]] && {
      echo "BLOCKED: Call cortex_session_start first (or run /cs). No file modifications without session." >&2
      exit 2
    }
    exit 0 ;;
esac
exit 0
