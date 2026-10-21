#!/bin/bash
# Cortex Session Id (v1.1) — fills in clientSessionId and the agent identity on cortex_session_start.
#
# The hub keeps two conversations in one checkout on separate sessions by this id. Until
# session-init v7.4 the agent copied it from a line that hook printed, but that line differs
# in every conversation and sits ahead of CLAUDE.md and the rest of the opening context, so
# the prompt cache could never reuse anything after it: ~6k tokens written anew per
# conversation, most of what made a hub lookup cost more than a plain grep. The hook payload
# already carries the id, so it goes straight into the call and the context stays the same.
#
# v1.1: the identity too. CLAUDE.md told the agent to read .cortex/agent-identity.json and the
# git branch before its first call, two more turns in every conversation for values a script
# can look up. What the agent passes itself still wins; only the id is always this hook's.
INPUT=$(cat 2>/dev/null || true)
[ -z "$INPUT" ] && exit 0

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
IDENTITY_FILE="$PROJECT_DIR/.cortex/agent-identity.json"
BRANCH=$(git -C "$PROJECT_DIR" branch --show-current 2>/dev/null || true)
case "${CLAUDE_CODE_ENTRYPOINT:-}" in
  *vscode*) IDE=claude-code-vscode ;;
  *) IDE=claude-code-cli ;;
esac

# The same id, with the same characters kept, that the tracker and the exit hook file this
# conversation's session under. Whatever the agent passed is replaced: this one is current.
if command -v jq >/dev/null 2>&1; then
  IDENTITY=$(jq -c 'if type == "object" then . else {} end' "$IDENTITY_FILE" 2>/dev/null || true)
  [ -z "$IDENTITY" ] && IDENTITY='{}'
  printf '%s' "$INPUT" | jq -c --argjson who "$IDENTITY" --arg branch "$BRANCH" --arg ide "$IDE" '
    (.session_id // "" | gsub("[^A-Za-z0-9_-]"; "") | .[0:128]) as $id
    | select($id != "")
    | ($who.environment | if type == "object" then . else {} end) as $env
    # A value of the wrong type fails the schema of the tool, and with it the whole call, so a
    # hand-edited file only contributes what it got right.
    | (({hostname: $env.hostname, os: $env.os, role: $who.role, branch: $branch, ide: $ide}
        | with_entries(select(.value | type == "string" and . != "")))
       + ($who.capabilities | if type == "array" and length > 0 and all(type == "string")
           then {capabilities: .} else {} end)) as $found
    | {hookSpecificOutput: {hookEventName: "PreToolUse",
        updatedInput: ($found + (.tool_input // {}) + {clientSessionId: $id})}}' 2>/dev/null
elif command -v python3 >/dev/null 2>&1; then
  printf '%s' "$INPUT" | IDENTITY_FILE="$IDENTITY_FILE" BRANCH="$BRANCH" IDE="$IDE" python3 -c '
import json, os, re, sys
d = json.load(sys.stdin)
cid = re.sub(r"[^A-Za-z0-9_-]", "", str(d.get("session_id") or ""))[:128]
if cid:
    try:
        who = json.load(open(os.environ["IDENTITY_FILE"], encoding="utf-8-sig"))
        who = who if isinstance(who, dict) else {}
    except Exception:
        who = {}
    env = who.get("environment") if isinstance(who.get("environment"), dict) else {}
    found = {"hostname": env.get("hostname"), "os": env.get("os"), "role": who.get("role"),
             "branch": os.environ.get("BRANCH"), "ide": os.environ.get("IDE")}
    args = {k: v for k, v in found.items() if isinstance(v, str) and v}
    caps = who.get("capabilities")
    if isinstance(caps, list) and caps and all(isinstance(c, str) for c in caps):
        args["capabilities"] = caps
    args.update(d.get("tool_input") or {})
    args["clientSessionId"] = cid
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "updatedInput": args}}))
' 2>/dev/null
fi
exit 0
