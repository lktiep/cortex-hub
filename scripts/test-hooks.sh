#!/bin/bash
# Tests for the Cortex enforcement hooks.
#
# These hooks decide whether an agent may search, edit or commit, and nothing checked
# them until now. Every case below is a hole that was open in a shipped version, so a
# failure here means that hole is back.
set -u
HOOKS_DIR="$(cd "$(dirname "$0")/../.claude/hooks" && pwd)"
PASS=0; FAIL=0

setup() {
  SANDBOX=$(mktemp -d)
  mkdir -p "$SANDBOX/.cortex/.session-state"
  STATE="$SANDBOX/.cortex/.session-state"
}
teardown() { rm -rf "$SANDBOX"; }

run() {
  printf '%s' "$2" | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$HOOKS_DIR/$1" >/dev/null 2>&1
  echo $?
}

check() {
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); printf '  ok   %s\n' "$1"
  else FAIL=$((FAIL+1)); printf '  FAIL %s (want exit %s, got %s)\n' "$1" "$2" "$3"; fi
}

bash_payload() { printf '{"tool_name":"Bash","tool_input":{"command":%s}}' "$(printf '%s' "$1" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')"; }
tool_payload() { printf '{"tool_name":"%s","tool_input":{}}' "$1"; }
discovered() { printf 'tool=cortex_code_search at=2026-09-28T00:00:00Z\n' > "$STATE/discovery-used"; }

echo "enforce-session.sh — session started, no discovery yet"
setup; touch "$STATE/session-started"
check "Grep blocked"                       2 "$(run enforce-session.sh "$(tool_payload Grep)")"
check "Glob blocked"                       2 "$(run enforce-session.sh "$(tool_payload Glob)")"
check "bare grep blocked"                  2 "$(run enforce-session.sh "$(bash_payload 'grep -rn foo .')")"
check "cd && grep blocked"                 2 "$(run enforce-session.sh "$(bash_payload 'cd apps && grep -rn foo .')")"
check "; grep blocked"                     2 "$(run enforce-session.sh "$(bash_payload 'echo hi; grep -rn foo .')")"
check "rg blocked"                         2 "$(run enforce-session.sh "$(bash_payload 'rg foo apps/')")"
check "fd blocked"                         2 "$(run enforce-session.sh "$(bash_payload 'fd -e ts')")"
check "git grep blocked"                   2 "$(run enforce-session.sh "$(bash_payload 'git grep foo')")"
check "piped grep filters output, allowed"  0 "$(run enforce-session.sh "$(bash_payload 'pnpm build | grep error')")"
check "grep inside a heredoc is data"      0 "$(run enforce-session.sh "$(bash_payload 'cat << EOF
grep -rn foo .
EOF')")"
check "cat allowed"                        0 "$(run enforce-session.sh "$(bash_payload 'cat package.json')")"
check "Edit blocked without recall"        2 "$(run enforce-session.sh "$(tool_payload Edit)")"
check "NotebookEdit blocked"               2 "$(run enforce-session.sh "$(tool_payload NotebookEdit)")"
check "redirect write blocked"             2 "$(run enforce-session.sh "$(bash_payload 'echo x > out.txt')")"
check "sed -i blocked"                     2 "$(run enforce-session.sh "$(bash_payload 'sed -i s/a/b/ f.ts')")"
check "2>/dev/null is not a write"         0 "$(run enforce-session.sh "$(bash_payload 'ls foo 2>/dev/null')")"
check "writing gate-off is never blocked"  0 "$(run enforce-session.sh "$(bash_payload 'echo reason > .cortex/.session-state/gate-off')")"
teardown

echo "enforce-session.sh — a touched marker is not discovery"
setup; touch "$STATE/session-started" "$STATE/discovery-used"
check "empty marker does not unlock"       2 "$(run enforce-session.sh "$(tool_payload Grep)")"
discovered
check "marker with evidence unlocks"       0 "$(run enforce-session.sh "$(tool_payload Grep)")"
teardown

echo "enforce-session.sh — recall gate on edits"
setup; touch "$STATE/session-started"
printf 'tool=cortex_knowledge_search at=now\n' > "$STATE/knowledge-recalled"
check "knowledge alone is not enough"      2 "$(run enforce-session.sh "$(tool_payload Edit)")"
printf 'tool=cortex_memory_search at=now\n' > "$STATE/memory-recalled"
check "knowledge + memory unlocks Edit"    0 "$(run enforce-session.sh "$(tool_payload Edit)")"
teardown

echo "enforce-session.sh — discovery must not retire the recall gate"
# The recall check used to be nested inside `if ! marker_ok discovery-used`, so one
# cortex_code_search call bought the whole session a pass on both recalls — while
# CLAUDE.md said editing without them is refused, full stop.
setup; touch "$STATE/session-started"; discovered
check "Edit still blocked after discovery" 2 "$(run enforce-session.sh "$(tool_payload Edit)")"
check "cat > file blocked too"             2 "$(run enforce-session.sh "$(bash_payload 'cat > f.ts <<EOF
x
EOF')")"
printf 'tool=cortex_knowledge_search at=now\n' > "$STATE/knowledge-recalled"
printf 'tool=cortex_memory_search at=now\n' > "$STATE/memory-recalled"
check "both recalls unlock it"              0 "$(run enforce-session.sh "$(tool_payload Edit)")"
teardown

echo "enforce-session.sh — declared escape hatch"
setup; touch "$STATE/session-started" "$STATE/gate-off"
check "empty gate-off does nothing"        2 "$(run enforce-session.sh "$(tool_payload Grep)")"
printf 'hub unreachable\n' > "$STATE/gate-off"
check "gate-off with a reason opens it"     0 "$(run enforce-session.sh "$(tool_payload Grep)")"
teardown

echo "enforce-session.sh — no session at all"
setup
check "Edit blocked without session"       2 "$(run enforce-session.sh "$(tool_payload Edit)")"
check "ls allowed without session"         0 "$(run enforce-session.sh "$(bash_payload 'ls -la')")"
check "git commit blocked"                 2 "$(run enforce-session.sh "$(bash_payload 'git commit -m x')")"
check "Grep blocked without session"       2 "$(run enforce-session.sh "$(tool_payload Grep)")"
check "rg blocked without session"         2 "$(run enforce-session.sh "$(bash_payload 'rg foo apps/')")"
# `cat` is on the read allowlist, so the write check has to come first or this passes as a read
check "cat > file blocked without session" 2 "$(run enforce-session.sh "$(bash_payload 'cat > f.ts << EOF
x
EOF')")"
check "gate-off write allowed, no session"  0 "$(run enforce-session.sh "$(bash_payload 'echo why > .cortex/.session-state/gate-off')")"
teardown

echo "enforce-session.sh — parses without jq"
setup; touch "$STATE/session-started"
NOJQ=$(mktemp -d)
for b in bash cat grep sed printf python3 mktemp rm dirname pwd; do
  [ -x "$(command -v $b 2>/dev/null)" ] && ln -sf "$(command -v $b)" "$NOJQ/$b"
done
GOT=$(printf '%s' "$(tool_payload Grep)" | CLAUDE_PROJECT_DIR="$SANDBOX" PATH="$NOJQ" bash "$HOOKS_DIR/enforce-session.sh" >/dev/null 2>&1; echo $?)
check "still blocks with python3 only"     2 "$GOT"
rm -rf "$NOJQ"; teardown

echo "session-init.sh — compaction must not re-arm the gate"
setup; discovered
printf '{"source":"compact"}' | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$HOOKS_DIR/session-init.sh" >/dev/null 2>&1
check "discovery survives compact"         0 "$([ -s "$STATE/discovery-used" ] && echo 0 || echo 1)"
printf '{"source":"resume"}' | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$HOOKS_DIR/session-init.sh" >/dev/null 2>&1
check "discovery survives resume"          0 "$([ -s "$STATE/discovery-used" ] && echo 0 || echo 1)"
printf '{"source":"startup"}' | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$HOOKS_DIR/session-init.sh" >/dev/null 2>&1
check "startup clears discovery"           0 "$([ ! -f "$STATE/discovery-used" ] && echo 0 || echo 1)"
teardown

echo "session-init.sh — names the conversation for /cs"
# Two conversations in one checkout send the hub the same key, machine, IDE and branch; the
# conversation id is the only thing that tells their sessions apart, and only this hook has it.
setup
mkdir -p "$STATE/conversations"
printf 'sess_old\n' > "$STATE/conversations/gone"; touch -t 202001010000 "$STATE/conversations/gone"
printf 'sess_b\n' > "$STATE/conversations/conv-b"
OUT=$(printf '{"source":"startup","session_id":"conv-a"}' | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$HOOKS_DIR/session-init.sh" 2>&1)
check "startup prints clientSessionId"      0 "$(printf '%s' "$OUT" | grep -q 'clientSessionId is conv-a' && echo 0 || echo 1)"
check "another conversation's record stays" sess_b "$(cat "$STATE/conversations/conv-b" 2>/dev/null)"
check "a week-old record is dropped"        0 "$([ ! -f "$STATE/conversations/gone" ] && echo 0 || echo 1)"
OUT=$(printf '{"source":"compact","session_id":"conv-a"}' | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$HOOKS_DIR/session-init.sh" 2>&1)
check "and again after compaction"          0 "$(printf '%s' "$OUT" | grep -q 'clientSessionId is conv-a' && echo 0 || echo 1)"
OUT=$(printf '{"source":"startup","session_id":"../../x y"}' | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$HOOKS_DIR/session-init.sh" 2>&1)
check "only file-name-safe characters"      0 "$(printf '%s' "$OUT" | grep -q 'clientSessionId is xy ' && echo 0 || echo 1)"
check "exits 0 with no id at all"           0 "$(printf '{"source":"startup"}' | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$HOOKS_DIR/session-init.sh" >/dev/null 2>&1; echo $?)"
teardown

echo "session-init.sh — the session gate must not arm itself"
setup; printf 'tool=cortex_session_start at=old\n' > "$STATE/session-started"
printf '{"source":"startup"}' | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$HOOKS_DIR/session-init.sh" >/dev/null 2>&1
check "startup clears a stale session"     0 "$([ ! -f "$STATE/session-started" ] && echo 0 || echo 1)"
check "and does not create a new one"      2 "$(run enforce-session.sh "$(tool_payload Edit)")"
POST='{"tool_name":"mcp__cortex-hub__cortex_session_start","tool_input":{},"tool_response":{"content":[{"type":"text","text":"{\"session_id\":\"s1\"}"}]}}'
printf '%s' "$POST" | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$HOOKS_DIR/track-quality.sh" >/dev/null 2>&1
check "only the tracker arms it"           0 "$(grep -q '^tool=' "$STATE/session-started" 2>/dev/null && echo 0 || echo 1)"
teardown

setup; touch "$STATE/changes-checked" "$STATE/tasks-checked"
printf '{"source":"startup"}' | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$HOOKS_DIR/session-init.sh" >/dev/null 2>&1
check "stale changes-checked cleared"      0 "$([ ! -f "$STATE/changes-checked" ] && echo 0 || echo 1)"
check "stale tasks-checked cleared"        0 "$([ ! -f "$STATE/tasks-checked" ] && echo 0 || echo 1)"
teardown

echo "track-quality.sh — markers must carry evidence"
setup
POST='{"tool_name":"mcp__cortex-hub__cortex_code_search","tool_input":{},"tool_response":{"content":[{"type":"text","text":"3 results"}]}}'
printf '%s' "$POST" | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$HOOKS_DIR/track-quality.sh" >/dev/null 2>&1
check "code_search records discovery"      0 "$(grep -q '^tool=' "$STATE/discovery-used" 2>/dev/null && echo 0 || echo 1)"
check "code_search is not a knowledge recall" 0 "$([ ! -f "$STATE/knowledge-recalled" ] && echo 0 || echo 1)"
teardown

setup
POST='{"tool_name":"mcp__cortex-hub__cortex_memory_search","tool_input":{},"tool_response":{}}'
printf '%s' "$POST" | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$HOOKS_DIR/track-quality.sh" >/dev/null 2>&1
check "memory_search records the recall"   0 "$(grep -q '^tool=' "$STATE/memory-recalled" 2>/dev/null && echo 0 || echo 1)"
# Recall must not open the discovery gate, or /cs alone unlocks Grep and Glob and the agent
# never has to ask cortex where the code is.
check "memory_search is not discovery"     0 "$([ ! -f "$STATE/discovery-used" ] && echo 0 || echo 1)"
teardown

echo "track-quality.sh — session id comes from tool_response"
setup
POST='{"tool_name":"mcp__cortex-hub__cortex_session_start","tool_input":{},"tool_response":{"content":[{"type":"text","text":"{\"session_id\":\"sess_42\",\"projectId\":\"proj-1\"}"}]}}'
printf '%s' "$POST" | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$HOOKS_DIR/track-quality.sh" >/dev/null 2>&1
check "session id captured"                0 "$([ "$(cat "$STATE/session-id" 2>/dev/null)" = "sess_42" ] && echo 0 || echo 1)"
teardown

echo "track-quality.sh — the hub's session id, not the IDE's"
# A real PostToolUse payload opens with Claude Code's own "session_id" — the conversation
# uuid — and the tracker took that one, so the exit hook asked the hub to close a session
# it had never heard of. The hub's id only appears inside tool_response.
setup; printf 'tool=session-end-check at=old\n' > "$STATE/session-ended"
POST='{"session_id":"2d30fc59-4abd-480a-8ebc-9ae418357563","transcript_path":"/t.jsonl","hook_event_name":"PostToolUse","tool_name":"mcp__cortex-hub__cortex_session_start","tool_input":{"repo":"r"},"tool_response":[{"type":"text","text":"{\"session_id\":\"sess_1791036137558_s8k8w\",\"projectId\":\"proj-1\"}"}]}'
printf '%s' "$POST" | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$HOOKS_DIR/track-quality.sh" >/dev/null 2>&1
check "hub id wins over the conversation id" 0 "$([ "$(cat "$STATE/session-id" 2>/dev/null)" = "sess_1791036137558_s8k8w" ] && echo 0 || echo 1)"
# A marker from an earlier session made the exit hook skip this one.
check "a new session clears session-ended"  0 "$([ ! -f "$STATE/session-ended" ] && echo 0 || echo 1)"
POST='{"session_id":"2d30fc59-4abd-480a-8ebc-9ae418357563","tool_name":"mcp__cortex-hub__cortex_session_start","tool_input":{},"tool_response":[{"type":"text","text":"hub unreachable"}]}'
printf '%s' "$POST" | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$HOOKS_DIR/track-quality.sh" >/dev/null 2>&1
check "no hub id, the old one stays"        0 "$([ "$(cat "$STATE/session-id" 2>/dev/null)" = "sess_1791036137558_s8k8w" ] && echo 0 || echo 1)"
teardown

echo "track-quality.sh — each conversation's session filed under that conversation"
setup
track() {  # $1 = conversation id, $2 = tool, $3 = hub id in the reply (optional)
  printf '{"session_id":"%s","tool_name":"mcp__cortex-hub__%s","tool_input":{},"tool_response":[{"type":"text","text":"{\\"session_id\\":\\"%s\\"}"}]}' "$1" "$2" "${3:-}" \
    | CLAUDE_PROJECT_DIR="$SANDBOX" bash "${TRACKER_DIR:-$HOOKS_DIR}/track-quality.sh" >/dev/null 2>&1
}
track conv-a cortex_session_start sess_a
track conv-b cortex_session_start sess_b
check "conversation a's session"            sess_a "$(cat "$STATE/conversations/conv-a" 2>/dev/null)"
check "conversation b's session"            sess_b "$(cat "$STATE/conversations/conv-b" 2>/dev/null)"
check "session-id is still the latest"      sess_b "$(cat "$STATE/session-id" 2>/dev/null)"
track conv-a cortex_session_end
check "a's /ce drops a's record"            0 "$([ ! -f "$STATE/conversations/conv-a" ] && echo 0 || echo 1)"
check "and leaves b's"                      sess_b "$(cat "$STATE/conversations/conv-b" 2>/dev/null)"
track '../../evil' cortex_session_start sess_e
check "a hostile id stays inside"           sess_e "$(cat "$STATE/conversations/evil" 2>/dev/null)"
teardown

# ── session-end-check.sh against a stand-in hub ──
# v6 posted to localhost:4000, which nothing listens on outside the hub machine, and wrote
# session-ended anyway. These run the hook against a local stub that records what it got.
# $1 = ok | error | 500. Sets STUB_URL and STUB_LOG; stop_stub kills it.
start_stub() {
  STUB_LOG=$(mktemp); local portfile; portfile=$(mktemp)
  python3 - "$1" "$STUB_LOG" "$portfile" <<'PY' >/dev/null 2>&1 &
import http.server, json, sys
mode, log, portfile = sys.argv[1:4]
class Hub(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length') or 0))
        with open(log, 'a') as f:
            f.write(json.dumps({'path': self.path, 'auth': self.headers.get('Authorization'),
                                'accept': self.headers.get('Accept'), 'body': json.loads(body or b'null')}) + '\n')
        result = {'content': [{'type': 'text', 'text': '{}'}]}
        if mode == 'error':
            result['isError'] = True
        out = json.dumps({'jsonrpc': '2.0', 'id': 1, 'result': result}).encode()
        self.send_response(500 if mode == '500' else 200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(out)))
        self.end_headers()
        self.wfile.write(out)
    def log_message(self, *args):
        pass
srv = http.server.HTTPServer(('127.0.0.1', 0), Hub)
open(portfile, 'w').write(str(srv.server_address[1]))
srv.serve_forever()
PY
  STUB_PID=$!
  for _ in $(seq 50); do [ -s "$portfile" ] && break; sleep 0.1; done
  STUB_URL="http://127.0.0.1:$(cat "$portfile")"; rm -f "$portfile"
}
stop_stub() { kill "$STUB_PID" 2>/dev/null; wait "$STUB_PID" 2>/dev/null; rm -f "$STUB_LOG"; }
# What the stub received, as one field of its first request.
got() { python3 -c 'import json,sys
reqs=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
v=eval(sys.argv[2], {}, {"r": reqs[0]}) if reqs else "<no request>"
print(v)' "$STUB_LOG" "$1" 2>/dev/null; }
# The same, of the request numbered $2 (1-based).
got_at() { python3 -c 'import json,sys
reqs=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
n=int(sys.argv[3])
print(eval(sys.argv[2], {}, {"r": reqs[n-1]}) if len(reqs) >= n else "<no request>")' "$STUB_LOG" "$1" "$2" 2>/dev/null; }
requests() { wc -l < "$STUB_LOG" | tr -d ' '; }
# A session that ran /cs and nothing else, on a machine whose only MCP config is $1 (a path
# under the fake HOME) holding $2. Nothing from the real environment may leak in.
armed() {
  setup; mkdir -p "$SANDBOX/home"
  printf 'tool=cortex_session_start at=now\n' > "$STATE/session-started"
  printf 'sess_42\n' > "$STATE/session-id"
  if [ -n "${1:-}" ]; then mkdir -p "$(dirname "$SANDBOX/home/$1")"; printf '%s' "$2" > "$SANDBOX/home/$1"; fi
}
end_hook() {  # $1 = hooks dir; extra env as further args
  local dir=$1; shift
  printf '{"session_id":"%s","hook_event_name":"SessionEnd","reason":"exit"}' "${END_CLIENT:-2d30fc59}" \
    | env -u CORTEX_HUB_API_URL -u HUB_API_KEY -u HUB_MCP_URL -u CORTEX_MCP_URL \
        HOME="$SANDBOX/home" CLAUDE_PROJECT_DIR="$SANDBOX" CORTEX_PROJECT_DIR="$SANDBOX" "$@" \
        bash "$dir/session-end-check.sh" 2>&1
}
ended() { [ -f "$STATE/session-ended" ] && echo 0 || echo 1; }

echo "session-end-check.sh — closes through the hub's MCP endpoint"
start_stub ok
armed .claude.json "{\"mcpServers\":{\"cortex-hub\":{\"type\":\"http\",\"url\":\"$STUB_URL/mcp\",\"headers\":{\"Authorization\":\"Bearer test-key\"}}}}"
OUT=$(end_hook "$HOOKS_DIR")
check "posts to the configured MCP url"     /mcp "$(got 'r["path"]')"
check "as a tools/call"                     tools/call "$(got 'r["body"]["method"]')"
check "of cortex_session_end"               cortex_session_end "$(got 'r["body"]["params"]["name"]')"
check "for the recorded session"            sess_42 "$(got 'r["body"]["params"]["arguments"]["sessionId"]')"
check "marked automatic"                    True "$(got 'r["body"]["params"]["arguments"]["auto"]')"
check "with the configured key"             "Bearer test-key" "$(got 'r["auth"]')"
check "accepting both MCP reply types"      "application/json, text/event-stream" "$(got 'r["accept"]')"
check "records the close"                   0 "$(ended)"
check "and never prints the key"            0 "$(printf '%s' "$OUT" | grep -q test-key && echo 1 || echo 0)"
OUT=$(end_hook "$HOOKS_DIR")
check "closes once"                         1 "$(requests)"
teardown; stop_stub

echo "session-end-check.sh — finds the key wherever the installer put it"
# The mcp-remote bridge: the url is an argument and the header comes from an env var.
start_stub ok
armed .claude.json "{\"projects\":{\"__DIR__\":{\"mcpServers\":{\"cortex-hub\":{\"command\":\"npx\",\"args\":[\"-y\",\"mcp-remote\",\"$STUB_URL/mcp\",\"--header\",\"Authorization:\${AUTH_HEADER}\"],\"env\":{\"AUTH_HEADER\":\"Bearer bridge-key\"}}}}}}"
sed -i.bak "s|__DIR__|$SANDBOX|" "$SANDBOX/home/.claude.json"
end_hook "$HOOKS_DIR" >/dev/null
check "mcp-remote args in projects[dir]"   "Bearer bridge-key" "$(got 'r["auth"]')"
check "records the close"                   0 "$(ended)"
teardown; stop_stub

start_stub ok; armed
end_hook "$HOOKS_DIR" HUB_MCP_URL="$STUB_URL/mcp" HUB_API_KEY=env-key >/dev/null
check "HUB_MCP_URL + HUB_API_KEY"          "Bearer env-key" "$(got 'r["auth"]')"
teardown; stop_stub

echo "session-end-check.sh — only a confirmed close counts"
armed
OUT=$(end_hook "$HOOKS_DIR")
check "no MCP config: not recorded"         1 "$(ended)"
check "and says why"                        0 "$(printf '%s' "$OUT" | grep -q 'not closed' && echo 0 || echo 1)"
check "and exits 0"                         0 "$(end_hook "$HOOKS_DIR" >/dev/null; echo $?)"
teardown
for mode in 500 error; do
  start_stub "$mode"
  armed .claude.json "{\"mcpServers\":{\"cortex-hub\":{\"url\":\"$STUB_URL/mcp\",\"headers\":{\"Authorization\":\"Bearer test-key\"}}}}"
  end_hook "$HOOKS_DIR" >/dev/null
  check "hub answers $mode: not recorded"    1 "$(ended)"
  teardown; stop_stub
done
start_stub ok
armed .claude.json "{\"mcpServers\":{\"cortex-hub\":{\"url\":\"$STUB_URL/mcp\",\"headers\":{\"Authorization\":\"Bearer test-key\"}}}}"
printf 'tool=cortex_session_end at=now\n' > "$STATE/session-ended"
end_hook "$HOOKS_DIR" >/dev/null
check "after /ce: nothing sent"             0 "$(requests)"
teardown; stop_stub

echo "session-end-check.sh — CORTEX_HUB_API_URL keeps the direct route"
start_stub ok; armed
end_hook "$HOOKS_DIR" CORTEX_HUB_API_URL="$STUB_URL/" >/dev/null
check "posts to /api/sessions/:id/end"      /api/sessions/sess_42/end "$(got 'r["path"]')"
check "marked automatic"                    True "$(got 'r["body"]["auto"]')"
check "records the close"                   0 "$(ended)"
teardown; stop_stub

echo "session-end-check.sh — a conversation closes its own session, not its neighbour's"
# Two conversations in one checkout: b ran /cs last, so session-id is b's. v7 closed b's
# session when a exited, and left a's open.
two_conversations() {  # $1 = stub mode, ok by default
  start_stub "${1:-ok}"
  armed .claude.json "{\"mcpServers\":{\"cortex-hub\":{\"url\":\"$STUB_URL/mcp\",\"headers\":{\"Authorization\":\"Bearer test-key\"}}}}"
  mkdir -p "$STATE/conversations"
  printf 'sess_a\n' > "$STATE/conversations/conv-a"
  printf 'sess_b\n' > "$STATE/conversations/conv-b"
  printf 'sess_b\n' > "$STATE/session-id"
}
two_conversations
END_CLIENT=conv-a end_hook "$HOOKS_DIR" >/dev/null
check "a's exit closes a's session"         sess_a "$(got 'r["body"]["params"]["arguments"]["sessionId"]')"
check "and drops a's record"                0 "$([ ! -f "$STATE/conversations/conv-a" ] && echo 0 || echo 1)"
check "b's record is untouched"             sess_b "$(cat "$STATE/conversations/conv-b" 2>/dev/null)"
check "session-ended stays b's to write"    1 "$(ended)"
END_CLIENT=conv-b end_hook "$HOOKS_DIR" >/dev/null
check "b's exit closes b's session"         sess_b "$(got_at 'r["body"]["params"]["arguments"]["sessionId"]' 2)"
check "and records the checkout's close"    0 "$(ended)"
END_CLIENT=conv-a end_hook "$HOOKS_DIR" >/dev/null
check "a second exit sends nothing more"    2 "$(requests)"
teardown; stop_stub

two_conversations
END_CLIENT=conv-c end_hook "$HOOKS_DIR" >/dev/null
check "a conversation that never ran /cs closes nothing" 0 "$(requests)"
teardown; stop_stub

two_conversations
# A third conversation starting up wipes the checkout's markers; a's session is still a's.
rm -f "$STATE/session-started" "$STATE/session-id"
END_CLIENT=conv-a end_hook "$HOOKS_DIR" >/dev/null
check "a still closes after a neighbour's startup" sess_a "$(got 'r["body"]["params"]["arguments"]["sessionId"]')"
teardown; stop_stub

two_conversations 500
END_CLIENT=conv-a end_hook "$HOOKS_DIR" >/dev/null
check "an unconfirmed close keeps the record" sess_a "$(cat "$STATE/conversations/conv-a" 2>/dev/null)"
teardown; stop_stub

echo "track-quality.sh — quality gates need the commands, not a report"
setup
POST='{"tool_name":"mcp__cortex-hub__cortex_quality_report","tool_input":{},"tool_response":{}}'
printf '%s' "$POST" | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$HOOKS_DIR/track-quality.sh" >/dev/null 2>&1
check "report alone does not pass gates"   0 "$([ ! -f "$STATE/quality-gates-passed" ] && echo 0 || echo 1)"
check "report is recorded separately"      0 "$(grep -q '^tool=' "$STATE/quality-reported" 2>/dev/null && echo 0 || echo 1)"
teardown

setup
for c in build typecheck lint; do
  printf '{"tool_name":"Bash","tool_input":{"command":"pnpm %s"},"tool_response":{"stdout":"Tasks: 12 successful","stderr":""}}' "$c" \
    | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$HOOKS_DIR/track-quality.sh" >/dev/null 2>&1
done
check "three green commands pass the gates" 0 "$(grep -q '^tool=' "$STATE/quality-gates-passed" 2>/dev/null && echo 0 || echo 1)"
teardown

setup
printf '{"tool_name":"Bash","tool_input":{"command":"pnpm build || true"},"tool_response":{"stdout":"ELIFECYCLE Command failed with exit code 1","stderr":""}}' \
  | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$HOOKS_DIR/track-quality.sh" >/dev/null 2>&1
check "a hidden build failure opens nothing" 0 "$([ ! -f "$STATE/gate-build" ] && echo 0 || echo 1)"
teardown

echo "track-quality.sh — a green build certifies a tree, not a session"
# Gates passed, then one Edit, then `git commit`: the commit gate said yes to code that had
# never been built. The certificate has to die the moment the tree changes under it.
arm_gates() {
  for c in build typecheck lint; do
    printf '{"tool_name":"Bash","tool_input":{"command":"pnpm %s"},"tool_response":{"stdout":"Tasks: 12 successful","stderr":""}}' "$c" \
      | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$HOOKS_DIR/track-quality.sh" >/dev/null 2>&1
  done
}
post() { printf '%s' "$1" | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$HOOKS_DIR/track-quality.sh" >/dev/null 2>&1; }

setup; printf 'tool=cortex_session_start at=now\n' > "$STATE/session-started"; discovered
arm_gates
check "gates armed"                         0 "$([ -s "$STATE/quality-gates-passed" ] && echo 0 || echo 1)"
check "commit allowed on a checked tree"    0 "$(run enforce-commit.sh "$(bash_payload 'git commit -m x')")"
post '{"tool_name":"Edit","tool_input":{"file_path":"a.ts"},"tool_response":{}}'
check "an Edit revokes the certificate"     0 "$([ ! -f "$STATE/quality-gates-passed" ] && echo 0 || echo 1)"
check "and the three gates with it"         0 "$([ ! -f "$STATE/gate-build" ] && [ ! -f "$STATE/gate-typecheck" ] && [ ! -f "$STATE/gate-lint" ] && echo 0 || echo 1)"
check "commit refused after the edit"       2 "$(run enforce-commit.sh "$(bash_payload 'git commit -m x')")"
arm_gates
check "re-running the gates re-opens it"    0 "$(run enforce-commit.sh "$(bash_payload 'git commit -m x')")"
teardown

setup; printf 'tool=cortex_session_start at=now\n' > "$STATE/session-started"
arm_gates
post '{"tool_name":"Bash","tool_input":{"command":"sed -i s/a/b/ src/x.ts"},"tool_response":{}}'
check "sed -i revokes it too"               0 "$([ ! -f "$STATE/quality-gates-passed" ] && echo 0 || echo 1)"
arm_gates
post '{"tool_name":"Bash","tool_input":{"command":"ls -la 2>/dev/null"},"tool_response":{}}'
check "a read leaves it alone"              0 "$([ -s "$STATE/quality-gates-passed" ] && echo 0 || echo 1)"
# The gate command is the one thing that must not revoke its own marker.
printf '{"tool_name":"Bash","tool_input":{"command":"pnpm lint > lint.log"},"tool_response":{"stdout":"Tasks: 12 successful"}}' \
  | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$HOOKS_DIR/track-quality.sh" >/dev/null 2>&1
check "a gate logging to a file survives"   0 "$([ -s "$STATE/quality-gates-passed" ] && echo 0 || echo 1)"
teardown

# ── Gemini variants ──────────────────────────────────────────────────────────────────────
# Same gates, different protocol: gemini reads {"decision":"deny"} from stdout and the hook
# always exits 0. The variants shipped three versions behind and enforced almost none of this.
GHOOKS="$(cd "$(dirname "$0")/../.gemini/hooks" && pwd)"
gdecision() {
  printf '%s' "$2" | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$GHOOKS/$1" 2>/dev/null \
    | grep -q '"decision":"deny"' && echo deny || echo allow
}
gpayload() { printf '{"tool_name":"%s","tool_input":{"command":%s}}' "$1" "$(printf '%s' "${2:-}" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')"; }

echo "gemini enforce-session.sh — discovery gate"
setup; printf 'tool=cortex_session_start at=now\n' > "$STATE/session-started"
check "search_file_content denied"         deny "$(gdecision enforce-session.sh "$(gpayload search_file_content)")"
check "glob denied"                        deny "$(gdecision enforce-session.sh "$(gpayload glob)")"
check "shell grep denied"                  deny "$(gdecision enforce-session.sh "$(gpayload run_shell_command 'grep -rn foo .')")"
check "piped grep allowed"                 allow "$(gdecision enforce-session.sh "$(gpayload run_shell_command 'pnpm build | grep error')")"
check "replace denied before recall"       deny "$(gdecision enforce-session.sh "$(gpayload replace)")"
discovered
check "search allowed after discovery"     allow "$(gdecision enforce-session.sh "$(gpayload search_file_content)")"
teardown

echo "gemini enforce-session.sh — recall gate and escape hatch"
setup; printf 'tool=cortex_session_start at=now\n' > "$STATE/session-started"
printf 'tool=cortex_knowledge_search at=now\n' > "$STATE/knowledge-recalled"
check "knowledge alone is not enough"      deny "$(gdecision enforce-session.sh "$(gpayload write_file)")"
printf 'tool=cortex_memory_search at=now\n' > "$STATE/memory-recalled"
check "knowledge + memory unlocks write"   allow "$(gdecision enforce-session.sh "$(gpayload write_file)")"
printf 'hub unreachable\n' > "$STATE/gate-off"
check "gate-off opens the gemini gate"     allow "$(gdecision enforce-session.sh "$(gpayload glob)")"
teardown

echo "gemini enforce-session.sh — no session at all"
setup
check "write_file denied without session"  deny "$(gdecision enforce-session.sh "$(gpayload write_file)")"
check "glob denied without session"        deny "$(gdecision enforce-session.sh "$(gpayload glob)")"
check "ls allowed without session"         allow "$(gdecision enforce-session.sh "$(gpayload run_shell_command 'ls -la')")"
teardown

echo "gemini enforce-commit.sh — a report is not a passing build"
setup; printf 'tool=cortex_session_start at=now\n' > "$STATE/session-started"; discovered
printf 'tool=cortex_quality_report at=now\n' > "$STATE/quality-reported"
check "commit denied without green gates"  deny "$(gdecision enforce-commit.sh "$(gpayload run_shell_command 'git commit -m x')")"
printf 'tool=build+typecheck+lint at=now\n' > "$STATE/quality-gates-passed"
check "commit allowed once gates pass"     allow "$(gdecision enforce-commit.sh "$(gpayload run_shell_command 'git commit -m x')")"
teardown

echo "gemini track-quality.sh — evidence, not touches"
setup
POST='{"tool_name":"mcp__cortex-hub__cortex_code_search","tool_input":{},"tool_response":{"content":[{"type":"text","text":"3 results"}]}}'
printf '%s' "$POST" | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$GHOOKS/track-quality.sh" >/dev/null 2>&1
check "discovery marker has evidence"      0 "$(grep -q '^tool=' "$STATE/discovery-used" 2>/dev/null && echo 0 || echo 1)"
POST='{"tool_name":"mcp__cortex-hub__cortex_quality_report","tool_input":{},"tool_response":{}}'
printf '%s' "$POST" | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$GHOOKS/track-quality.sh" >/dev/null 2>&1
check "report does not pass the gates"     0 "$([ ! -f "$STATE/quality-gates-passed" ] && echo 0 || echo 1)"
printf '{"tool_name":"run_shell_command","tool_input":{"command":"pnpm build"},"tool_response":{"stdout":"ELIFECYCLE Command failed"}}' \
  | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$GHOOKS/track-quality.sh" >/dev/null 2>&1
check "a hidden failure opens nothing"     0 "$([ ! -f "$STATE/gate-build" ] && echo 0 || echo 1)"
teardown

echo "gemini — both holes, same shape"
setup; printf 'tool=cortex_session_start at=now\n' > "$STATE/session-started"; discovered
check "write_file still denied after discovery" deny "$(gdecision enforce-session.sh "$(gpayload write_file)")"
for c in build typecheck lint; do
  printf '{"tool_name":"run_shell_command","tool_input":{"command":"pnpm %s"},"tool_response":{"stdout":"Tasks: 12 successful"}}' "$c" \
    | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$GHOOKS/track-quality.sh" >/dev/null 2>&1
done
check "gates armed"                        0 "$([ -s "$STATE/quality-gates-passed" ] && echo 0 || echo 1)"
printf '{"tool_name":"replace","tool_input":{},"tool_response":{}}' \
  | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$GHOOKS/track-quality.sh" >/dev/null 2>&1
check "replace revokes the certificate"    0 "$([ ! -f "$STATE/quality-gates-passed" ] && echo 0 || echo 1)"
check "commit denied after the edit"       deny "$(gdecision enforce-commit.sh "$(gpayload run_shell_command 'git commit -m x')")"
teardown

echo "gemini session-end-check.sh — closes through the hub's MCP endpoint"
setup
POST='{"session_id":"g-uuid","tool_name":"mcp_cortex-hub_cortex_session_start","tool_input":{},"tool_response":{"llmContent":"{\"session_id\":\"sess_77\"}"}}'
printf '%s' "$POST" | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$GHOOKS/track-quality.sh" >/dev/null 2>&1
check "tracker takes the hub id"            sess_77 "$(cat "$STATE/session-id" 2>/dev/null)"
teardown
start_stub ok
armed .gemini/antigravity/mcp_config.json "{\"mcpServers\":{\"cortex-hub\":{\"serverUrl\":\"$STUB_URL/mcp\",\"headers\":{\"Authorization\":\"Bearer gem-key\"}}}}"
OUT=$(end_hook "$GHOOKS")
check "antigravity serverUrl config"        "Bearer gem-key" "$(got 'r["auth"]')"
check "marked automatic"                    True "$(got 'r["body"]["params"]["arguments"]["auto"]')"
check "records the close"                   0 "$(ended)"
check "speaks gemini's protocol"            0 "$(printf '%s' "$OUT" | python3 -c 'import json,sys;json.load(sys.stdin)["systemMessage"]' 2>/dev/null && echo 0 || echo 1)"
teardown; stop_stub
armed
check "no config: not recorded"             1 "$(end_hook "$GHOOKS" >/dev/null; ended)"
teardown

echo "gemini session-init.sh — compaction must not re-arm the gate"
setup; discovered
printf '{"source":"compact"}' | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$GHOOKS/session-init.sh" >/dev/null 2>&1
check "discovery survives compact"         0 "$([ -s "$STATE/discovery-used" ] && echo 0 || echo 1)"
printf '{"source":"startup"}' | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$GHOOKS/session-init.sh" >/dev/null 2>&1
check "startup clears discovery"           0 "$([ ! -f "$STATE/discovery-used" ] && echo 0 || echo 1)"
check "and does not arm the session"       0 "$([ ! -f "$STATE/session-started" ] && echo 0 || echo 1)"
teardown

echo "gemini — one session per conversation, same shape"
setup
mkdir -p "$STATE/conversations"
printf 'sess_old\n' > "$STATE/conversations/gone"; touch -t 202001010000 "$STATE/conversations/gone"
gmessage() { python3 -c 'import json,sys;print(json.load(sys.stdin)["systemMessage"])' 2>/dev/null; }
OUT=$(printf '{"source":"startup","session_id":"g-a"}' | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$GHOOKS/session-init.sh" 2>/dev/null)
check "startup names the conversation"      0 "$(printf '%s' "$OUT" | gmessage | grep -q 'clientSessionId is g-a' && echo 0 || echo 1)"
check "a week-old record is dropped"        0 "$([ ! -f "$STATE/conversations/gone" ] && echo 0 || echo 1)"
OUT=$(printf '{"source":"compact","session_id":"g-a"}' | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$GHOOKS/session-init.sh" 2>/dev/null)
check "and again after compaction"          0 "$(printf '%s' "$OUT" | gmessage | grep -q 'clientSessionId is g-a' && echo 0 || echo 1)"
gtrack() {  # $1 = conversation id, $2 = tool, $3 = hub id in the reply (optional)
  printf '{"session_id":"%s","tool_name":"mcp_cortex-hub_%s","tool_input":{},"tool_response":{"llmContent":"{\\"session_id\\":\\"%s\\"}"}}' "$1" "$2" "${3:-}" \
    | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$GHOOKS/track-quality.sh" >/dev/null 2>&1
}
gtrack g-a cortex_session_start sess_ga
gtrack g-b cortex_session_start sess_gb
check "tracker files a's session"           sess_ga "$(cat "$STATE/conversations/g-a" 2>/dev/null)"
gtrack g-b cortex_session_end
check "b's /ce drops only b's record"       0 "$([ ! -f "$STATE/conversations/g-b" ] && [ -s "$STATE/conversations/g-a" ] && echo 0 || echo 1)"
teardown
start_stub ok
armed .gemini/antigravity/mcp_config.json "{\"mcpServers\":{\"cortex-hub\":{\"serverUrl\":\"$STUB_URL/mcp\",\"headers\":{\"Authorization\":\"Bearer gem-key\"}}}}"
mkdir -p "$STATE/conversations"
printf 'sess_ga\n' > "$STATE/conversations/g-a"; printf 'sess_gb\n' > "$STATE/conversations/g-b"
printf 'sess_gb\n' > "$STATE/session-id"
OUT=$(END_CLIENT=g-a end_hook "$GHOOKS")
check "a's exit closes a's session"         sess_ga "$(got 'r["body"]["params"]["arguments"]["sessionId"]')"
check "b's record is untouched"             sess_gb "$(cat "$STATE/conversations/g-b" 2>/dev/null)"
check "still speaks gemini's protocol"      0 "$(printf '%s' "$OUT" | gmessage >/dev/null && echo 0 || echo 1)"
END_CLIENT=g-c end_hook "$GHOOKS" >/dev/null
check "no /cs in that conversation: nothing sent" 1 "$(requests)"
teardown; stop_stub

echo "onboarding scripts must not carry their own copy of the hooks or the rules"
# scripts/onboard.sh is what the public "Member" path runs (install.sh at the repo root and
# scripts/bootstrap.sh both exec it), and it shipped its own hooks three versions behind the
# ones tested above — so a fresh onboard installed a session gate that never fired.
REPO="$(cd "$(dirname "$0")/.." && pwd)"
check "onboard.sh writes no hooks itself"  0 "$(grep -q 'HOOKEOF' "$REPO/scripts/onboard.sh" && echo 1 || echo 0)"
check "onboard.sh delegates to install.sh" 0 "$(grep -q 'INSTALL_SH" --skip-global' "$REPO/scripts/onboard.sh" && echo 0 || echo 1)"
check "onboard.ps1 delegates to install.ps1" 0 "$(grep -q 'installPs1 -SkipGlobal' "$REPO/scripts/onboard.ps1" && echo 0 || echo 1)"
for f in scripts/onboard.sh scripts/onboard.ps1 scripts/install.sh scripts/install.ps1 .cortex/agent-rules.md; do
  check "no STATE.md in $f"                0 "$(grep -q 'Read .*STATE.md' "$REPO/$f" && echo 1 || echo 0)"
  check "no old tool ladder in $f"         0 "$(grep -q 'Tool Priority' "$REPO/$f" && echo 1 || echo 0)"
done

echo "install.sh — the commit gate must actually be installed, not just configured"
# Every case here was live on cortex-hub itself. `git hook run pre-commit` produced no
# output while lefthook's real hook sat unused in .git/hooks/, because husky's `prepare`
# script pointed core.hooksPath at .husky/_ and the installer swallowed lefthook's refusal
# as "non-fatal". lefthook.yml existed, the summary said "configured", nothing gated.
INSTALL_SH="$REPO/scripts/install.sh"

# A stub keeps this offline and tests OUR logic — whether we call the installer at all and
# whether we clear the path first — rather than lefthook's.
lefthook_stub() {
  mkdir -p "$1"
  cat > "$1/lefthook" <<'STUB'
#!/bin/sh
mkdir -p .git/hooks
printf '#!/bin/sh\n# lefthook stub\n' > .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
STUB
  chmod +x "$1/lefthook"
}

# $1 = extra setup run inside the fresh repo. Sets PROJ, OUT and RC as globals —
# not via command substitution, which would run this in a subshell and throw them away.
install_in_sandbox() {
  PROJ=$(mktemp -d)
  lefthook_stub "$PROJ/.bin"
  OUT="$PROJ/install.out"
  (
    cd "$PROJ" || exit 1
    git init -q . && git config user.email t@t && git config user.name t
    eval "$1"
    git add -A >/dev/null 2>&1; git commit -qm init >/dev/null 2>&1
    PATH="$PROJ/.bin:$PATH" HOME="$PROJ" bash "$INSTALL_SH" --skip-global --tools cursor
  ) > "$OUT" 2>&1
  RC=$?
}

echo "  .gitignore must not claim to ignore a path git already tracks"
# In cortex-hub .claude/, .codex/ and .cursorrules ARE the committed source of truth.
# An ignore line for a tracked path changes nothing today, then silently drops the file
# for whoever removes and re-adds it.
install_in_sandbox "printf 'x\n' > .cursorrules; printf 'node_modules/\n' > .gitignore"
check "installer exits clean"               0 "$RC"
check "tracked .cursorrules not ignored"    0 "$(grep -qxF '.cursorrules' "$PROJ/.gitignore" && echo 1 || echo 0)"
check "untracked .windsurfrules ignored"    0 "$(grep -qxF '.windsurfrules' "$PROJ/.gitignore" && echo 0 || echo 1)"
check "and it says which it skipped"        0 "$(grep -q 'left tracked paths alone' "$OUT" && echo 0 || echo 1)"
check ".cursorrules still tracked"          0 "$(git -C "$PROJ" ls-files --error-unmatch .cursorrules >/dev/null 2>&1 && echo 0 || echo 1)"
rm -rf "$PROJ"

echo "  a project with no recognised stack must still install"
# `printf '%s\n' "${DETECTED_STACKS[@]}"` on an empty array aborts under bash 3.2 + set -u,
# so install.sh died outright on any stack it did not know — a docs repo, C++, anything.
install_in_sandbox "printf 'hi\n' > README.md"
check "unknown stack does not abort"        0 "$RC"
check "no unbound variable"                 0 "$(grep -q 'unbound variable' "$OUT" && echo 1 || echo 0)"
check "profile still written"               0 "$([ -f "$PROJ/.cortex/project-profile.json" ] && echo 0 || echo 1)"
rm -rf "$PROJ"

echo "  core.hooksPath pointing at someone else's hooks must not be overwritten"
install_in_sandbox "printf '{}' > package.json; mkdir -p .myhooks; printf '#!/bin/sh\necho mine\n' > .myhooks/pre-commit; chmod +x .myhooks/pre-commit; git config core.hooksPath .myhooks"
check "installer exits clean"               0 "$RC"
check "their hooksPath is left set"         0 "$([ "$(git -C "$PROJ" config --get core.hooksPath)" = ".myhooks" ] && echo 0 || echo 1)"
check "their hook is not overwritten"       0 "$(grep -q 'echo mine' "$PROJ/.myhooks/pre-commit" && echo 0 || echo 1)"
check "the dead gate is reported, not hidden" 0 "$(grep -q 'NOT installing over them' "$OUT" && echo 0 || echo 1)"
check "summary does not claim configured"   0 "$(grep -q 'no git hook runs' "$OUT" && echo 0 || echo 1)"
rm -rf "$PROJ"

echo "  a husky hooksPath with no hooks of its own must be handed to lefthook"
install_in_sandbox "printf '{}' > package.json; mkdir -p .husky/_; printf '#!/usr/bin/env sh\n. \"\$(dirname \"\$0\")/h\"\n' > .husky/_/pre-commit; chmod +x .husky/_/pre-commit; git config core.hooksPath .husky/_"
check "installer exits clean"               0 "$RC"
check "the shadowing hooksPath is cleared"  0 "$([ -z "$(git -C "$PROJ" config --get core.hooksPath)" ] && echo 0 || echo 1)"
check "lefthook owns .git/hooks/pre-commit" 0 "$(grep -qi lefthook "$PROJ/.git/hooks/pre-commit" 2>/dev/null && echo 0 || echo 1)"
check "and the gate is reported live"       0 "$(grep -q 'pre-commit gate live' "$OUT" && echo 0 || echo 1)"
rm -rf "$PROJ"

echo "  this repo must not re-introduce a hooksPath that shadows lefthook"
# husky was a devDependency whose only effect was `prepare: husky` setting core.hooksPath.
check "no husky in package.json"            0 "$(grep -q '"husky"' "$REPO/package.json" && echo 1 || echo 0)"
check "no prepare script reinstating it"    0 "$(grep -q '"prepare"' "$REPO/package.json" && echo 1 || echo 0)"
check "lefthook is a devDependency"         0 "$(grep -q '"lefthook"' "$REPO/package.json" && echo 0 || echo 1)"

echo "memory recall must read the field the API actually returns"
# /api/mem9/search returns Mem9Memory, whose body is `memory`. hub-mcp read `m.text`, which
# does not exist on that payload, so every recall rendered headers with an empty body —
# it read exactly like a project with no memories, for as long as it shipped.
MEM="$REPO/apps/hub-mcp/src/tools/memory.ts"
check "hub-mcp no longer reads m.text"      0 "$(grep -q 'm\.text' "$MEM" && echo 1 || echo 0)"
check "hub-mcp reads m.memory"              0 "$(grep -q 'm\.memory' "$MEM" && echo 0 || echo 1)"
check "and the shared type still says memory" 0 "$(grep -q '^  memory: string$' "$REPO/packages/shared-mem9/src/types.ts" && echo 0 || echo 1)"
check "an empty body is named, not blank"   0 "$(grep -q 'stored with an empty body' "$MEM" && echo 0 || echo 1)"

echo "hook commands must resolve from any cwd, not only the repo root"
# Claude Code runs a hook in the Bash tool's cwd, which follows every cd. Registered as
# `bash .claude/hooks/x.sh`, a hook run below the root failed with "No such file", which
# Claude Code reports as a non-blocking error and then lets the tool call through: every
# gate was open for as long as the agent's shell sat in a subdirectory.
SB=$(mktemp -d); mkdir -p "$SB/apps/web" "$SB/.cortex/.session-state"; cp -R "$REPO/.claude" "$SB/.claude"
hook_cmds() { python3 -c 'import json,sys
for evs in json.load(open(sys.argv[1]))["hooks"].values():
    for m in evs:
        for h in m["hooks"]: print(h["command"])' "$1"; }
run_registered() {  # $1 = command as registered, stdin = payload; prints "rc|output"
  local out rc
  out=$(cd "$SB/apps/web" && CLAUDE_PROJECT_DIR="$SB" CORTEX_HUB_API_URL=http://127.0.0.1:9 sh -c "$1" 2>&1); rc=$?
  printf '%s|%s' "$rc" "$out"
}
not_found() {
  case "$1" in
    127\|*|*'No such file'*) echo 1 ;;
    *) echo 0 ;;
  esac
}
while IFS= read -r cmd; do
  name=$(printf '%s' "$cmd" | sed -E 's|.*/([a-z-]+\.sh).*|\1|')
  res=$(printf '%s' "$(tool_payload Edit)" | run_registered "$cmd")
  check "$name found from a subdirectory"   0 "$(not_found "$res")"
done < <(hook_cmds "$REPO/.claude/settings.json")
EDIT_CMD=$(hook_cmds "$REPO/.claude/settings.json" | grep enforce-session)
check "and still blocks Edit from there"    2 "$(printf '%s' "$(tool_payload Edit)" | run_registered "$EDIT_CMD" | cut -d'|' -f1)"
check "the old relative form did not"       127 "$(printf '%s' "$(tool_payload Edit)" | run_registered 'bash .claude/hooks/enforce-session.sh' | cut -d'|' -f1)"
rm -rf "$SB"
# The installer writes settings.json from its own heredoc, so the two must not drift.
INSTALLED=$(awk "/cat > .claude\/settings.json << 'EOF'/{f=1;next} f&&/^EOF\$/{exit} f" "$REPO/scripts/install.sh")
check "install.sh writes the same settings.json" 0 "$([ "$INSTALLED" = "$(cat "$REPO/.claude/settings.json")" ] && echo 0 || echo 1)"

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]
