#!/bin/bash
# Cortex Session Enforcement (v3) — HARD BLOCK without active session
# Improvements: robust path resolution, jq+python3 fallback, fail-closed

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"

# If session already started, allow everything
[ -f "$STATE_DIR/session-started" ] && exit 0

# Parse hook input (jq → python3 fallback)
INPUT=$(cat)
TOOL_NAME=""
COMMAND=""

if command -v jq >/dev/null 2>&1; then
  TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
  COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  TOOL_NAME=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_name',''))" 2>/dev/null || true)
  COMMAND=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('command',''))" 2>/dev/null || true)
fi

# If we couldn't parse at all, fail closed (block)
if [ -z "$TOOL_NAME" ]; then
  echo "BLOCKED: Cannot parse hook input. Install jq or python3." >&2
  exit 2
fi

case "$TOOL_NAME" in
  Edit|Write|NotebookEdit)
    echo "BLOCKED: Call cortex_session_start before editing files." >&2
    exit 2
    ;;
  Bash)
    # Allow read-only commands
    if [[ "$COMMAND" =~ ^(ls|cat|head|tail|pwd|which|echo|git\ (status|log|diff|branch|remote|rev-parse)|pnpm\ (build|typecheck|lint|test)|npm\ (run|test)|yarn\ |cargo\ (build|test|clippy)|go\ (build|test|vet)|python3?\ -m|curl|dotnet\ (build|test)) ]]; then
      exit 0
    fi
    # Block file-modifying commands
    if [[ "$COMMAND" =~ (git\ (add|commit|push|reset)|rm\ |mv\ |cp\ |mkdir\ |touch\ |chmod\ |sed\ -i|>\ ) ]]; then
      echo "BLOCKED: Call cortex_session_start before modifying files." >&2
      exit 2
    fi
    # Default: allow (likely read-only inspection)
    exit 0
    ;;
esac

# All other tools — allow
exit 0
