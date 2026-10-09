#!/bin/bash
# Cortex Session End Check (v7.1) — closes the cortex session when the session really ends.
#
# v6 posted to ${CORTEX_HUB_API_URL:-http://localhost:4000}. Nothing sets that variable, so on
# every machine but the hub itself the close went to a port nobody listens on; curl's failure
# was swallowed and `session-ended` was written anyway. Sessions were never closed, and the
# hook said they were. v7 goes where the agent's own cortex calls go — the hub's MCP endpoint,
# with the key from the IDE's MCP config — and only records a close the hub confirmed.
#
# The close is sent with auto:true: the hub records it as 'abandoned', keeps it out of memory
# and /cs recall, and leaves a session that /ce already completed alone.
#
# Claude Code gives a SessionEnd hook 1.5s unless it declares a timeout; settings.json gives
# this one 15s, and the requests below stop well inside that.
#
# v7.1: every conversation in a checkout shares this state directory, so `session-id` is
# whichever one ran /cs last — one conversation's exit closed another's session, and one that
# never ran /cs closed somebody else's. The tracker now files each session under the IDE's id
# for the conversation that opened it, and this hook closes that one and nothing else. With no
# such record (an older tracker, an IDE that sends no id) it falls back to `session-id`.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"

say() { echo "$1"; }

INPUT=$(cat 2>/dev/null || true)
CLIENT_ID=""
if [ -n "$INPUT" ]; then
  if command -v jq >/dev/null 2>&1; then
    CLIENT_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
  elif command -v python3 >/dev/null 2>&1; then
    CLIENT_ID=$(printf '%s' "$INPUT" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("session_id",""))' 2>/dev/null || true)
  fi
fi
CLIENT_ID=$(printf '%s' "$CLIENT_ID" | tr -cd 'A-Za-z0-9_-' | cut -c1-128)

SESSION_ID=""
OWN=""
if [ -n "$CLIENT_ID" ] && [ -d "$STATE_DIR/conversations" ]; then
  # Nothing filed under this conversation: it never opened a session, or /ce closed it.
  OWN="$STATE_DIR/conversations/$CLIENT_ID"
  [ -s "$OWN" ] || exit 0
  SESSION_ID=$(head -1 "$OWN" 2>/dev/null || true)
else
  [ -f "$STATE_DIR/session-started" ] || exit 0
  [ -f "$STATE_DIR/session-ended" ] && exit 0
  [ -s "$STATE_DIR/session-id" ] && SESSION_ID=$(cat "$STATE_DIR/session-id" 2>/dev/null || true)
fi

if [ -z "$SESSION_ID" ] || [ "$SESSION_ID" = "null" ]; then
  say "WARNING: cortex session not closed — no session id was recorded. Run /ce next time."
  exit 0
fi

ACTIONS=""
[ -s "$STATE_DIR/knowledge-recalled" ]   && ACTIONS="${ACTIONS} knowledge-searched"
[ -s "$STATE_DIR/memory-recalled" ]      && ACTIONS="${ACTIONS} memory-searched"
[ -s "$STATE_DIR/discovery-used" ]       && ACTIONS="${ACTIONS} code-searched"
[ -s "$STATE_DIR/changes-checked" ]      && ACTIONS="${ACTIONS} changes-checked"
[ -s "$STATE_DIR/quality-gates-passed" ] && ACTIONS="${ACTIONS} quality-passed"
[ -s "$STATE_DIR/quality-reported" ]     && ACTIONS="${ACTIONS} quality-reported"
[ -s "$STATE_DIR/tasks-checked" ]        && ACTIONS="${ACTIONS} tasks-checked"
[ -s "$STATE_DIR/gate-off" ]             && ACTIONS="${ACTIONS} gate-off($(head -c 80 "$STATE_DIR/gate-off" | tr -d '"\\\n'))"

SUMMARY="Session auto-closed (no /ce)."
[ -n "$ACTIONS" ] && SUMMARY="Session auto-closed. Activity:${ACTIONS}."

if ! command -v python3 >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  say "WARNING: cortex session $SESSION_ID not closed — needs python3 and curl. Run /ce next time."
  exit 0
fi

# The hub's MCP endpoint and Authorization header, one per line, from the environment or the
# cortex-hub entry of whichever MCP config this machine has. Both shapes the installer writes
# are read: {url, headers} and the mcp-remote bridge {args: [url, --header, ...], env}.
hub_endpoint() {
  python3 - "$PROJECT_DIR" <<'PY' 2>/dev/null
import json, os, re, sys
project, home = sys.argv[1], os.path.expanduser('~')

def emit(url, auth):
    if url and auth:
        print(url)
        print(auth if auth.lower().startswith('bearer ') else 'Bearer ' + auth)
        sys.exit(0)

emit(os.environ.get('CORTEX_MCP_URL') or os.environ.get('HUB_MCP_URL'), os.environ.get('HUB_API_KEY'))

def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return {}

def servers(doc):
    out = {}
    for key in ('mcpServers', 'servers'):
        if isinstance(doc.get(key), dict):
            out.update(doc[key])
    return out

def entry(found):
    if 'cortex-hub' in found:
        return found['cortex-hub']
    return next((v for k, v in found.items() if 'cortex' in k.lower()), None)

def expand(value, env):
    return re.sub(r'\$\{(\w+)\}', lambda m: env.get(m.group(1)) or os.environ.get(m.group(1), ''), value)

def resolve(e):
    if not isinstance(e, dict):
        return
    env = e.get('env') if isinstance(e.get('env'), dict) else {}
    headers = e.get('headers') if isinstance(e.get('headers'), dict) else {}
    args = [a for a in e.get('args') or [] if isinstance(a, str)]
    url = e.get('url') or e.get('httpUrl') or e.get('serverUrl') or next((a for a in args if a.startswith('http')), None)
    auth = headers.get('Authorization') or headers.get('authorization')
    for i, a in enumerate(args[:-1]):
        if a == '--header' and args[i + 1].lower().startswith('authorization:'):
            auth = auth or args[i + 1].split(':', 1)[1]
    emit(url, expand(auth or '', env).strip())

claude = load(os.path.join(home, '.claude.json'))
for found in (
    servers(load(os.path.join(project, '.mcp.json'))),
    servers((claude.get('projects') or {}).get(project) or {}),
    servers(claude),
    servers(load(os.path.join(project, '.gemini', 'settings.json'))),
    servers(load(os.path.join(home, '.gemini', 'settings.json'))),
    servers(load(os.path.join(home, '.gemini', 'antigravity', 'mcp_config.json'))),
    servers(load(os.path.join(home, '.cursor', 'mcp.json'))),
    servers(load(os.path.join(home, '.codeium', 'windsurf', 'mcp_config.json'))),
    servers(load(os.path.join(project, '.vscode', 'mcp.json'))),
):
    resolve(entry(found))
PY
}

# A JSON body for the close. $1 = "mcp" for a tools/call, anything else for the REST route.
close_body() {
  python3 - "$1" "$SESSION_ID" "$SUMMARY" <<'PY'
import json, sys
kind, sid, summary = sys.argv[1:4]
args = {'sessionId': sid, 'summary': summary, 'auto': True}
if kind == 'mcp':
    print(json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                      'params': {'name': 'cortex_session_end', 'arguments': args}}))
else:
    print(json.dumps({'summary': summary, 'auto': True}))
PY
}

# Did the tools/call succeed? The reply is JSON, or the same JSON as SSE `data:` lines.
mcp_ok() {
  python3 -c '
import json, sys
raw = sys.stdin.read()
lines = [l[5:].strip() for l in raw.splitlines() if l.startswith("data:")] or [raw]
for line in lines:
    try:
        msg = json.loads(line)
    except Exception:
        continue
    if isinstance(msg, dict) and isinstance(msg.get("result"), dict) and not msg["result"].get("isError"):
        sys.exit(0)
sys.exit(1)'
}

CLOSED=1
WHY=""
if [ -n "${CORTEX_HUB_API_URL:-}" ]; then
  # An explicit API URL (a self-hosted hub on this machine) keeps the direct route.
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 4 -m 10 \
    -X POST "${CORTEX_HUB_API_URL%/}/api/sessions/${SESSION_ID}/end" \
    -H 'Content-Type: application/json' -d "$(close_body rest)" 2>/dev/null)
  case "$CODE" in 2??) CLOSED=0 ;; *) WHY="${CORTEX_HUB_API_URL} answered ${CODE:-nothing}" ;; esac
else
  ENDPOINT=$(hub_endpoint)
  MCP_URL=$(printf '%s\n' "$ENDPOINT" | sed -n 1p)
  MCP_AUTH=$(printf '%s\n' "$ENDPOINT" | sed -n 2p)
  if [ -z "$MCP_URL" ] || [ -z "$MCP_AUTH" ]; then
    WHY="no cortex-hub MCP server with an Authorization header in this machine's MCP config"
  else
    # The key goes in on stdin, never on the command line, where `ps` would show it.
    if printf 'Authorization: %s\n' "$MCP_AUTH" \
        | curl -sf --connect-timeout 4 -m 10 -X POST "$MCP_URL" -H @- \
            -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
            -d "$(close_body mcp)" 2>/dev/null | mcp_ok; then
      CLOSED=0
    else
      WHY="the hub at ${MCP_URL%%\?*} did not confirm it"
    fi
  fi
fi

if [ "$CLOSED" = "0" ]; then
  [ -n "$OWN" ] && rm -f "$OWN"
  # session-ended speaks for the checkout's current session, so only that one may write it.
  if [ -z "$OWN" ] || [ "$SESSION_ID" = "$(cat "$STATE_DIR/session-id" 2>/dev/null)" ]; then
    printf 'tool=session-end-check at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATE_DIR/session-ended"
  fi
  say "INFO: cortex session $SESSION_ID closed as abandoned.${ACTIONS:+ Activity:${ACTIONS}}"
else
  say "WARNING: cortex session $SESSION_ID not closed — ${WHY}. Run /ce next time."
fi
exit 0
