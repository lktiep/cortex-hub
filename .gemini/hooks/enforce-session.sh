#!/bin/bash
# Cortex Session Enforcement (v6.1) — Gemini variant.
#
# v3 only checked that a session existed: once cortex_session_start had run, every tool was
# allowed. So the discovery-first rule was documentation, not enforcement. This mirrors the
# Claude hook — gate grep/glob until a cortex discovery tool has run, and gate writes until
# knowledge and memory have been recalled — in Gemini's JSON decision protocol.
# An explicit project dir beats guessing: `git rev-parse` points at the main checkout from
# inside a worktree, and at whatever repo the tests happen to run from.
PROJECT_DIR="${CORTEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"

allow() { echo '{"decision":"allow"}'; exit 0; }
deny()  { printf '{"decision":"deny","reason":%s}\n' "$(printf '%s' "$1" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"BLOCKED: cortex workflow step missing."')"; exit 0; }

INPUT=$(cat)
TOOL_NAME=""
COMMAND=""
if command -v jq >/dev/null 2>&1; then
  TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
  COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  # v3 read the command with jq only, so on a machine without jq the commit and write gates
  # quietly passed everything.
  eval "$(printf '%s' "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(f'TOOL_NAME={repr(d.get(\"tool_name\",\"\"))}')
print(f'COMMAND={repr(d.get(\"tool_input\",{}).get(\"command\",\"\"))}')
" 2>/dev/null || true)"
fi
[ -z "$TOOL_NAME" ] && allow

# Declared escape hatch: when the hub is unreachable the tools this gate points at cannot run.
[ -s "$STATE_DIR/gate-off" ] && allow

marker_ok() { [ -s "$STATE_DIR/$1" ] && grep -q '^tool=' "$STATE_DIR/$1" 2>/dev/null; }

is_codebase_search() {
  local cmd="${1%%<<*}"   # heredoc bodies are data being written, not commands being run
  printf '%s' "$cmd" | grep -Eq '(^|[;&]{1,2}[[:space:]]*|\([[:space:]]*)[[:space:]]*(sudo[[:space:]]+)?(grep|egrep|fgrep|rg|ag|ack|find|fd)[[:space:]]' && return 0
  printf '%s' "$cmd" | grep -Eq '(^|[;&]{1,2}[[:space:]]*)[[:space:]]*git[[:space:]]+grep[[:space:]]' && return 0
  return 1
}
is_gate_off_write() {
  printf '%s' "$1" | grep -Eq '>[[:space:]]*"?[^"[:space:]]*\.cortex/\.session-state/gate-off"?[[:space:]]*$'
}
is_file_write() {
  printf '%s' "$1" | grep -Eq '(^|[;&|]{1,2}[[:space:]]*)[[:space:]]*(sed[[:space:]]+-i|tee[[:space:]]|dd[[:space:]]|truncate[[:space:]]|install[[:space:]]+-)' && return 0
  local cmd
  cmd=$(printf '%s' "$1" | sed -E 's/[0-9]*>>?[[:space:]]*&[0-9-]//g; s/[0-9]*>>?[[:space:]]*"?\/dev\/[a-zA-Z0-9]+"?//g')
  printf '%s' "$cmd" | grep -Eq '>>?[[:space:]]*"?[^&|"[:space:]]' && return 0
  return 1
}

HOW_OUT="If the Cortex hub is unreachable, say so and write the reason: echo 'hub unreachable' > .cortex/.session-state/gate-off"

if [ -f "$STATE_DIR/session-started" ]; then
  if ! marker_ok discovery-used; then
    case "$TOOL_NAME" in
      search_file_content|glob)
        deny "BLOCKED: use cortex_code_search first — it is AST-aware and returns the target file inside the top 10 far more reliably than a pattern guess. $HOW_OUT" ;;
      run_shell_command|shell)
        is_codebase_search "$COMMAND" && deny "BLOCKED: use cortex_code_search first. find/grep/rg unlock once a cortex discovery tool has run — and stay the right choice for an exact literal (env var, config key, error string), not for a question about behaviour. $HOW_OUT" ;;
    esac
  fi

  # Recall is a precondition for writing, not a consolation prize for not having
  # searched — see the same fix in .claude/hooks/enforce-session.sh.
  WRITES_A_FILE=0
  case "$TOOL_NAME" in
    write_file|replace|edit_file|create_file|insert_text) WRITES_A_FILE=1 ;;
    run_shell_command|shell) is_file_write "$COMMAND" && ! is_gate_off_write "$COMMAND" && WRITES_A_FILE=1 ;;
  esac
  if [ "$WRITES_A_FILE" = "1" ]; then
    if ! marker_ok knowledge-recalled || ! marker_ok memory-recalled; then
      deny "BLOCKED: run cortex_knowledge_search and cortex_memory_search before editing — they restore what previous sessions already decided and already fixed. $HOW_OUT"
    fi
  fi
  allow
fi

# Session not started: block writes and codebase search, allow plain reads.
case "$TOOL_NAME" in
  write_file|replace|edit_file|create_file|insert_text)
    deny "BLOCKED: call cortex_session_start first. No edits without a session." ;;
  glob|search_file_content)
    deny "BLOCKED: call cortex_session_start first, then search with cortex_code_search. $HOW_OUT" ;;
  run_shell_command|shell)
    is_codebase_search "$COMMAND" && deny "BLOCKED: call cortex_session_start first, then search with cortex_code_search. $HOW_OUT"
    is_file_write "$COMMAND" && ! is_gate_off_write "$COMMAND" \
      && deny "BLOCKED: call cortex_session_start first. No file modifications without a session."
    printf '%s' "$COMMAND" | grep -Eq '(git[[:space:]]+(add|commit|push|reset)|^rm[[:space:]]|^mv[[:space:]]|^cp[[:space:]]|^mkdir[[:space:]])' \
      && deny "BLOCKED: call cortex_session_start first. No file modifications without a session." ;;
esac
allow
