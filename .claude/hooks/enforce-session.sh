#!/bin/bash
# Cortex Session Enforcement (v6.1) — hold tools back until the cortex workflow is followed.
#
# What this can and cannot do: the hook shares a filesystem with the agent it gates, so
# it cannot stop an agent that decides to forge a marker. What it can do is make the
# correct path the easy one, and make the wrong path visible. That is why markers must
# now carry evidence of a real tool call instead of merely existing, and why the way out
# is an explicit, named file rather than a silent trick.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"

INPUT=$(cat)
TOOL_NAME=""
COMMAND=""
if command -v jq >/dev/null 2>&1; then
  TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
  COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  # Without this fallback the whole gate silently became a no-op on any machine without jq.
  eval "$(printf '%s' "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(f'TOOL_NAME={repr(d.get(\"tool_name\",\"\"))}')
print(f'COMMAND={repr(d.get(\"tool_input\",{}).get(\"command\",\"\"))}')
" 2>/dev/null || true)"
fi

[ -z "$TOOL_NAME" ] && { echo "BLOCKED: Cannot parse hook input (install jq or python3)." >&2; exit 2; }

# An escape hatch that has to be asked for out loud. When the hub is unreachable the
# tools this gate points at cannot run, and a gate with no path through it just stops
# the work — so there is a way out, it is one line, and it leaves a trace.
if [ -s "$STATE_DIR/gate-off" ]; then
  exit 0
fi

# A marker counts only if a tool wrote evidence into it. An empty file is a touch.
marker_ok() {
  [ -s "$STATE_DIR/$1" ] && grep -q '^tool=' "$STATE_DIR/$1" 2>/dev/null
}

# A search command counts as codebase search when it *starts* a command: `cd apps && grep -r x`
# is the search this gate is about. `pnpm build | grep error` filters output of something
# else and has nothing to do with finding code, so it stays allowed.
is_codebase_search() {
  # Everything after a heredoc marker is data being written, not commands being run —
  # a file whose text happens to contain the word grep is not a search.
  local cmd="${1%%<<*}"
  printf '%s' "$cmd" | grep -Eq '(^|[;&]{1,2}[[:space:]]*|\([[:space:]]*)[[:space:]]*(sudo[[:space:]]+)?(grep|egrep|fgrep|rg|ag|ack|find|fd)[[:space:]]' && return 0
  printf '%s' "$cmd" | grep -Eq '(^|[;&]{1,2}[[:space:]]*)[[:space:]]*git[[:space:]]+grep[[:space:]]' && return 0
  return 1
}

# Writing the escape hatch itself can never be blocked by the gate it opens, or the only
# way out of a gate armed against an unreachable hub is a trick.
is_gate_off_write() {
  printf '%s' "$1" | grep -Eq '>[[:space:]]*"?[^"[:space:]]*\.cortex/\.session-state/gate-off"?[[:space:]]*$'
}

# Editing through Bash is still editing. Gating Edit/Write while leaving `cat > file`,
# `sed -i` and `tee` open meant the recall gate only ever applied to agents that used
# the dedicated tools.
is_file_write() {
  printf '%s' "$1" | grep -Eq '(^|[;&|]{1,2}[[:space:]]*)[[:space:]]*(sed[[:space:]]+-i|tee[[:space:]]|dd[[:space:]]|truncate[[:space:]]|install[[:space:]]+-)' && return 0
  # Drop the redirects that write nowhere — `2>/dev/null` and `>&2` are not file edits —
  # then anything left pointing at a name is one.
  local cmd
  cmd=$(printf '%s' "$1" | sed -E 's/[0-9]*>>?[[:space:]]*&[0-9-]//g; s/[0-9]*>>?[[:space:]]*"?\/dev\/[a-zA-Z0-9]+"?//g')
  printf '%s' "$cmd" | grep -Eq '>>?[[:space:]]*"?[^&|"[:space:]]' && return 0
  return 1
}

HOW_OUT="If the Cortex hub is unreachable (MCP reports CONNECTION_CLOSED), say so and write the reason: echo 'hub unreachable' > .cortex/.session-state/gate-off"

# ── Session started: enforce discovery-first + knowledge/memory recall ──
if [ -f "$STATE_DIR/session-started" ]; then
  if ! marker_ok discovery-used; then
    if [ "$TOOL_NAME" = "Grep" ] || [ "$TOOL_NAME" = "Glob" ]; then
      echo "BLOCKED: use cortex_code_search first — it is AST-aware and returns the target file inside the top 10 far more reliably than a pattern guess. $HOW_OUT" >&2
      exit 2
    fi
    if [ "$TOOL_NAME" = "Bash" ] && is_codebase_search "$COMMAND"; then
      echo "BLOCKED: use cortex_code_search first. find/grep/rg unlock once a cortex discovery tool has run — and stay the right choice for an exact literal (env var, config key, error string), not for a question about behaviour. $HOW_OUT" >&2
      exit 2
    fi
    WRITES_A_FILE=0
    case "$TOOL_NAME" in
      Edit|Write|NotebookEdit) WRITES_A_FILE=1 ;;
      Bash) is_file_write "$COMMAND" && ! is_gate_off_write "$COMMAND" && WRITES_A_FILE=1 ;;
    esac
    if [ "$WRITES_A_FILE" = "1" ]; then
      if ! marker_ok knowledge-recalled || ! marker_ok memory-recalled; then
        echo "BLOCKED: run cortex_knowledge_search and cortex_memory_search before editing — they restore what previous sessions already decided and already fixed. Run /cs to do every step at once. $HOW_OUT" >&2
        exit 2
      fi
    fi
  fi
  exit 0
fi

# ── Session NOT started: block writes and codebase search, allow plain reads ──
# Until v7.1 of session-init this branch never ran: the init hook created the session-started
# marker itself, so every session looked started before cortex_session_start was ever called.
case "$TOOL_NAME" in
  Edit|Write|NotebookEdit)
    echo "BLOCKED: call cortex_session_start first (or run /cs). No edits without a session." >&2
    exit 2 ;;
  Grep|Glob)
    echo "BLOCKED: run /cs first (cortex_session_start + knowledge/memory recall), then search with cortex_code_search. $HOW_OUT" >&2
    exit 2 ;;
  Bash)
    if is_codebase_search "$COMMAND"; then
      echo "BLOCKED: run /cs first, then search with cortex_code_search. find/grep/rg unlock once a cortex discovery tool has run. $HOW_OUT" >&2
      exit 2
    fi
    # The write check goes before the read allowlist, or `cat > file` passes as a read.
    if is_file_write "$COMMAND" && ! is_gate_off_write "$COMMAND"; then
      echo "BLOCKED: call cortex_session_start first (or run /cs). No file modifications without a session." >&2
      exit 2
    fi
    [[ "$COMMAND" =~ ^(ls|cat|head|tail|pwd|which|echo|git\ (status|log|diff|branch|remote|show)|pnpm\ |npm\ |yarn\ |cargo\ |go\ |python|curl|dotnet\ |node\ ) ]] && exit 0
    [[ "$COMMAND" =~ (git\ (add|commit|push|reset)|rm\ |mv\ |cp\ |mkdir\ |touch\ |chmod\ ) ]] && {
      echo "BLOCKED: call cortex_session_start first (or run /cs). No file modifications without a session." >&2
      exit 2
    }
    exit 0 ;;
esac
exit 0
