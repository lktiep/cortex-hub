#!/bin/bash
# Cortex Quality Tracker (v4.2) — records what actually happened, as evidence.
#
# Two things changed from v3, both of them bugs found by reading a real hook payload:
#   1. The field is `tool_response`, not `tool_output`. v3 read `tool_output`, so the
#      session id was never captured and the auto-close on exit never had anything to
#      close — on this repo `.cortex/.session-state/session-id` had never once been written.
#   2. Markers were empty files, so a `touch` was indistinguishable from a tool call and
#      the gates could be satisfied without doing any of the work. They now carry the tool
#      name and a timestamp, and the enforcement hook requires that content.
#
# Note on exit codes: PostToolUse does not fire at all when a Bash command exits non-zero,
# so a failing `pnpm build` cannot mark its gate. What it can still do is hide the failure
# behind `|| true` or a pipe, which is why the output is scanned for failure signatures.
#
# v4.2 also files the hub session under the conversation that opened it, in
# conversations/<IDE session id>: the rest of this directory is shared by every conversation
# in the checkout, so the exit hook had no way to tell whose session `session-id` was.

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
mkdir -p "$STATE_DIR"

INPUT=$(cat)
COMMAND=""
TOOL_NAME=""
OUTPUT=""
CLIENT_ID=""

if command -v jq >/dev/null 2>&1; then
  COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
  TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
  OUTPUT=$(printf '%s' "$INPUT" | jq -r '[(.tool_response // .tool_output // empty)] | tostring' 2>/dev/null || true)
  CLIENT_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  eval "$(printf '%s' "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
r=d.get('tool_response', d.get('tool_output',''))
print(f'COMMAND={repr(d.get(\"tool_input\",{}).get(\"command\",\"\"))}')
print(f'TOOL_NAME={repr(d.get(\"tool_name\",\"\"))}')
print(f'OUTPUT={repr(json.dumps(r) if not isinstance(r,str) else r)}')
print(f'CLIENT_ID={repr(str(d.get(\"session_id\",\"\")))}')
" 2>/dev/null || true)"
fi

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# The IDE's id for this conversation, made safe to use as a file name.
CLIENT_ID=$(printf '%s' "$CLIENT_ID" | tr -cd 'A-Za-z0-9_-' | cut -c1-128)

# Evidence, not existence: the enforcement hook only accepts a marker that says who wrote it.
record() {
  printf 'tool=%s at=%s\n' "${2:-$TOOL_NAME}" "$NOW" > "$STATE_DIR/$1"
}

# A command that reports success while the build failed — `pnpm build || true`, or a pipe
# that swallows the status. If the output says it failed, the gate does not open.
looks_failed() {
  printf '%s' "$OUTPUT" | grep -Eq 'ERR_PNPM|ELIFECYCLE|error TS[0-9]|Command failed|✖|FAIL |Exit status [1-9]'
}

# 1 = this command is not one of the quality gates. mark_gate flips it, and the
# invalidation block at the bottom reads it, so `pnpm build | tee build.log` does not
# revoke the very marker it just armed.
GATE_COMMAND=1
mark_gate() {
  GATE_COMMAND=0
  looks_failed && return 0
  record "$1" "$COMMAND"
}

[[ "$COMMAND" =~ (pnpm|npm|yarn)\ build ]]    && mark_gate gate-build
[[ "$COMMAND" =~ (pnpm|npm|yarn)\ typecheck ]] && mark_gate gate-typecheck
[[ "$COMMAND" =~ (pnpm|npm|yarn)\ lint ]]      && mark_gate gate-lint
[[ "$COMMAND" =~ cargo\ build ]]               && mark_gate gate-build
[[ "$COMMAND" =~ cargo\ clippy ]]              && mark_gate gate-lint
[[ "$COMMAND" =~ go\ build ]]                  && mark_gate gate-build
[[ "$COMMAND" =~ go\ vet ]]                    && mark_gate gate-lint
[[ "$COMMAND" =~ dotnet\ build ]]              && mark_gate gate-build

# Quality gates pass when the commands passed — not when a tool was called to say so.
if [ -s "$STATE_DIR/gate-build" ] && [ -s "$STATE_DIR/gate-typecheck" ] && [ -s "$STATE_DIR/gate-lint" ]; then
  record quality-gates-passed "build+typecheck+lint"
elif [ -s "$STATE_DIR/gate-build" ] && [ -s "$STATE_DIR/gate-lint" ] && [ ! -s "$STATE_DIR/gate-typecheck" ]; then
  # Languages without a separate typecheck step (Go, Rust): build + lint is the full set.
  if [ -f "$PROJECT_DIR/.cortex/project-profile.json" ] \
     && ! grep -q '"typecheck"' "$PROJECT_DIR/.cortex/project-profile.json" 2>/dev/null; then
    record quality-gates-passed "build+lint (no typecheck in project-profile)"
  fi
fi

# ── Cortex tool calls ──
case "$TOOL_NAME" in
  *cortex_session_start*)
    record session-started
    # The id arrives inside an MCP text block, so the JSON is escaped one level deep —
    # dropping the backslashes first is what makes one pattern work for both shapes.
    # Only a hub id: every hook payload opens with the IDE's own "session_id" (a conversation
    # uuid), and `head -1` used to take that one, so the exit hook tried to close a session
    # the hub had never heard of. The hub mints nothing but sess_… ids.
    SESSION_ID=$(printf '%s' "$INPUT" | tr -d '\\' \
      | grep -Eo '"session_?[iI]d"[[:space:]]*:[[:space:]]*"sess_[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')
    [ -n "$SESSION_ID" ] && printf '%s\n' "$SESSION_ID" > "$STATE_DIR/session-id"
    if [ -n "$SESSION_ID" ] && [ -n "$CLIENT_ID" ]; then
      mkdir -p "$STATE_DIR/conversations"
      printf '%s\n' "$SESSION_ID" > "$STATE_DIR/conversations/$CLIENT_ID"
    fi
    # A new hub session is open, so an earlier one's "ended" no longer applies — left in
    # place it made the exit hook skip this session too.
    rm -f "$STATE_DIR/session-ended"
    ;;
  *cortex_session_end*)
    record session-ended
    # This conversation closed its own session; the exit hook has nothing left to do for it.
    [ -n "$CLIENT_ID" ] && rm -f "$STATE_DIR/conversations/$CLIENT_ID"
    ;;
  *cortex_quality_report*) record quality-reported ;;
  *cortex_code_search*|*cortex_code_context*|*cortex_code_impact*|*cortex_cypher*)
    record discovery-used ;;
  # Recall is not discovery: knowledge and memory answer "why" and "has this broken before",
  # not "where is the code". Arming discovery-used here would let /cs alone open Grep and Glob.
  *cortex_knowledge_search*) record knowledge-recalled ;;
  *cortex_memory_search*)    record memory-recalled ;;
  *cortex_task_pickup*)    record tasks-checked ;;
  *cortex_detect_changes*|*cortex_changes*) record changes-checked ;;
esac

# ── A passing build certifies a tree, not a session ──
#
# The gate markers used to survive any edit made after them, so
# "pnpm build && typecheck && lint" → edit one file → `git commit` passed the commit
# gate with code that had never been checked. Reproduced in a sandbox: arming the
# three gates, then feeding an Edit, left quality-gates-passed armed and the commit
# gate returned 0. A write invalidates the certificate — the gates have to run again
# on the tree that is actually being committed.
writes_a_file() {
  printf '%s' "$1" | grep -Eq '(^|[;&|]{1,2}[[:space:]]*)[[:space:]]*(sed[[:space:]]+-i|tee[[:space:]]|dd[[:space:]]|truncate[[:space:]]|install[[:space:]]+-)' && return 0
  local cmd
  cmd=$(printf '%s' "$1" | sed -E 's/[0-9]*>>?[[:space:]]*&[0-9-]//g; s/[0-9]*>>?[[:space:]]*"?\/dev\/[a-zA-Z0-9]+"?//g')
  printf '%s' "$cmd" | grep -Eq '>>?[[:space:]]*"?[^&|"[:space:]]' && return 0
  printf '%s' "$1" | grep -Eq '(^|[;&|]{1,2}[[:space:]]*)[[:space:]]*(cp|mv|rm|mkdir|touch|patch|git[[:space:]]+apply)[[:space:]]' && return 0
  return 1
}
INVALIDATES=0
case "$TOOL_NAME" in
  Edit|Write|NotebookEdit) INVALIDATES=1 ;;
  Bash)
    # Editing through a shell is still editing. But a gate command that pipes its own
    # output to a file must not revoke the marker it just armed one screen above.
    if [ "$GATE_COMMAND" = "1" ] && writes_a_file "$COMMAND"; then
      INVALIDATES=1
    fi
    ;;
esac
if [ "$INVALIDATES" = "1" ]; then
  rm -f "$STATE_DIR/quality-gates-passed" "$STATE_DIR/gate-build" \
        "$STATE_DIR/gate-typecheck" "$STATE_DIR/gate-lint"
fi
exit 0
