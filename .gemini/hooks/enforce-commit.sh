#!/bin/bash
# Cortex Commit Enforcement (v5.1) — Gemini variant.
#
# v3 accepted quality-gates-passed, which the tracker wrote the moment cortex_quality_report was
# called — so reporting a failure unlocked the commit just as well as passing. The marker now
# comes only from build/typecheck/lint actually running green.
# An explicit project dir beats guessing: `git rev-parse` points at the main checkout from
# inside a worktree, and at whatever repo the tests happen to run from.
# v5.1 refuses to skip the repo's own git hooks (--no-verify, `commit -n`, LEFTHOOK=0): cortex
# writes this file, so the rule has to live here rather than be added by the repo.
PROJECT_DIR="${CORTEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}}"
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
# Checked before the `^git commit` match below, so `cd x && git push --no-verify` is caught too.
SKIP_REASON=$(skips_hooks "$COMMAND")
if [ -n "$SKIP_REASON" ]; then
  printf '{"decision":"deny","reason":"BLOCKED: this skips the git hooks of the repo (%s). Those hooks are its own checks: run the command without the skip and fix what they report; if a hook itself is broken, ask the user to run the command."}\n' "$SKIP_REASON"
  exit 0
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
