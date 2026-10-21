#!/bin/bash
# Cortex Session Id (v1.0) — fills in clientSessionId on cortex_session_start.
#
# The hub keeps two conversations in one checkout on separate sessions by this id. Until
# session-init v7.4 the agent copied it from a line that hook printed, but that line differs
# in every conversation and sits ahead of CLAUDE.md and the rest of the opening context, so
# the prompt cache could never reuse anything after it: ~6k tokens written anew per
# conversation, most of what made a hub lookup cost more than a plain grep. The hook payload
# already carries the id, so it goes straight into the call and the context stays the same.
INPUT=$(cat 2>/dev/null || true)
[ -z "$INPUT" ] && exit 0

# The same id, with the same characters kept, that the tracker and the exit hook file this
# conversation's session under. Whatever the agent passed is replaced: this one is current.
if command -v jq >/dev/null 2>&1; then
  printf '%s' "$INPUT" | jq -c '
    (.session_id // "" | gsub("[^A-Za-z0-9_-]"; "") | .[0:128]) as $id
    | select($id != "")
    | {hookSpecificOutput: {hookEventName: "PreToolUse",
        updatedInput: ((.tool_input // {}) + {clientSessionId: $id})}}' 2>/dev/null
elif command -v python3 >/dev/null 2>&1; then
  printf '%s' "$INPUT" | python3 -c '
import json, re, sys
d = json.load(sys.stdin)
cid = re.sub(r"[^A-Za-z0-9_-]", "", str(d.get("session_id") or ""))[:128]
if cid:
    args = dict(d.get("tool_input") or {}, clientSessionId=cid)
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "updatedInput": args}}))
' 2>/dev/null
fi
exit 0
