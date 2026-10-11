#!/bin/bash
# Cortex Commit Enforcement (v5.1) — a commit needs the workflow behind it.
#
# v4 accepted `quality-gates-passed`, which the tracker used to write the moment
# cortex_quality_report was called — so reporting a failure unlocked the commit just as
# well as passing. The marker now comes only from build/typecheck/lint actually running
# green, and the report is a separate, softer expectation.
# v5.1 refuses to skip the repo's own git hooks (--no-verify, `commit -n`, LEFTHOOK=0).
# install.sh leaves a repo that runs its checks from git hooks to those hooks, so skipping
# them skips the checks. The rule lives here and not in the repo: cortex writes this file,
# and a rule the repo added to it would be overwritten by the next install.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
INPUT=$(cat)
COMMAND=""
if command -v jq >/dev/null 2>&1; then
  COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  COMMAND=$(printf '%s' "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null || true)
fi

# Prints why a command skips the repo's git hooks; prints nothing when it does not.
skips_hooks() {
  local cmd q="'"
  local b='(^|[;&|(`[:space:]])' seg='[^;&|)]' end='([;&|)[:space:]]|$)'
  # A heredoc body is text (a commit message), not flags: drop it and keep the line that
  # opens it. Then join `\` continuations and make every line a `;`-separated command.
  cmd=$(printf '%s\n' "$1" | awk '
    tag != "" { t = $0; sub(/^\t+/, "", t); if (t == tag) tag = ""; next }
    { print
      if (match($0, /(^|[^<])<<-?[ \t]*["\047]?[A-Za-z_][A-Za-z0-9_]*/)) {
        tag = substr($0, RSTART, RLENGTH); sub(/^[^<]?<<-?[ \t]*["\047]?/, "", tag)
      } }' | awk '/\\$/ { sub(/\\$/, ""); printf "%s ", $0; next } { print }' | tr '\n' ';')
  # Quoted arguments are messages and bodies; a flag named inside one is not a flag.
  # `LEFTHOOK="0"` keeps its quotes: they follow `=`, not a space.
  cmd=$(printf '%s' "$cmd" | sed -E "s/(^|[[:space:]])'[^']*'/\1/g; s/(^|[[:space:]])\"[^\"]*\"/\1/g; s/(--[a-z-]+=)'[^']*'/\1/g; s/(--[a-z-]+=)\"[^\"]*\"/\1/g")
  local re="${b}(export[[:space:]]+)?LEFTHOOK=[\"$q]?(0|false)([\"$q;&|)[:space:]]|\$)"
  if [[ "$cmd" =~ $re ]]; then echo "LEFTHOOK=0 turns lefthook off"; return; fi
  # git takes any unambiguous prefix of a long option, so --no-veri is --no-verify.
  re="${b}git[[:space:]]${seg}*[[:space:]]--no-veri[a-z]*(=|${end})"
  if [[ "$cmd" =~ $re ]]; then echo "--no-verify skips the hooks"; return; fi
  # `git commit -n` is --no-verify. Only flags that take no value may come before the n:
  # `-mnew` is `-m new`. `git push -n` is --dry-run and stays allowed.
  local opt='[[:space:]]+-[^[:space:];&|)]*([[:space:]]+[^-[:space:];&|)][^[:space:];&|)]*)?'
  re="${b}git(${opt})*[[:space:]]+commit([[:space:]]${seg}*)?[[:space:]]-[apseioqvz]*n[a-zA-Z]*${end}"
  if [[ "$cmd" =~ $re ]]; then echo "git commit -n is --no-verify"; return; fi
}
# Checked before the `^git` match below, so `cd x && git commit --no-verify` is caught too.
SKIP_REASON=$(skips_hooks "$COMMAND")
if [ -n "$SKIP_REASON" ]; then
  echo "BLOCKED: this skips the repo's git hooks ($SKIP_REASON)." >&2
  echo "Those hooks are the repo's own checks. Run the command without the skip and fix what they report;" >&2
  echo "if a hook itself is broken, ask the user to run the command." >&2
  exit 2
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
