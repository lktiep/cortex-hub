#!/bin/bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
if [ -f "$STATE_DIR/session-started" ]; then
  if [ ! -f "$STATE_DIR/discovery-used" ]; then
    INPUT_PEEK=$(cat)
    PEEK_TOOL=$(echo "$INPUT_PEEK" | jq -r '.tool_name // empty' 2>/dev/null || true)
    if [[ "$PEEK_TOOL" = "Grep" ]]; then
      echo "HINT: Use cortex_code_search BEFORE grep." >&2
    fi
  fi
  exit 0
fi
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_name',''))" 2>/dev/null || true)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
[ -z "$TOOL_NAME" ] && { echo "BLOCKED: Cannot parse hook input." >&2; exit 2; }
case "$TOOL_NAME" in
  Edit|Write|NotebookEdit) echo "BLOCKED: Call cortex_session_start first." >&2; exit 2 ;;
  Bash)
    [[ "$COMMAND" =~ ^(ls|cat|head|tail|pwd|which|echo|git\ |pnpm\ |npm\ |yarn\ |cargo\ |go\ |python|curl|dotnet\ ) ]] && exit 0
    [[ "$COMMAND" =~ (git\ (add|commit|push|reset)|rm\ |mv\ |cp\ |mkdir\ |touch\ |chmod\ |sed\ -i) ]] && { echo "BLOCKED: Call cortex_session_start first." >&2; exit 2; }
    exit 0 ;;
esac

# All other tools — allow
exit 0
