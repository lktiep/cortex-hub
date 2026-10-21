#!/bin/bash
# Cortex Prompt Recall (v1) — what the project already knows about a prompt, shown with it.
#
# Searching knowledge is a decision the agent has to make, and it does not always make it:
# asked about a page the team had already published, an agent searched files and old
# transcripts while the hub held the answer all along. So every user prompt is sent to
# cortex_recall, and the project's knowledge and memories that match it above a relevance
# floor are put in front of the agent as context. Never a block.
#
# Each document or memory is shown once per conversation. Slash commands, short prompts and a
# hub that does not answer within RECALL_TIMEOUT say nothing.
#
# CORTEX_RECALL=off turns it off; so does gate-off, since the hub is down. It is JavaScript in
# a shell file so the installers can ship it like every other hook; without node it does nothing.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"

[ "${CORTEX_RECALL:-}" = "off" ] && exit 0
[ -s "$STATE_DIR/gate-off" ] && exit 0
command -v node >/dev/null 2>&1 || exit 0

# read, not $(cat << …): bash 3.2, macOS's own, misparses quotes in a heredoc inside $( ).
IFS= read -r -d '' RECALL_JS << 'RECALLJS' || true
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

/** The prompt waits on this hook: a slow hub costs the user this much, then nothing is shown. */
const RECALL_TIMEOUT = 3000
const MIN_CHARS = 12
/** Enough of a prompt to say what it is about; the rest only dilutes the embedding. */
const MAX_QUERY = 1000
const LIMIT = 3

const project = process.env.PROJECT_DIR
const dir = path.join(process.env.STATE_DIR, 'recall')

function load(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return {} }
}

// The hub this machine's agents talk to, found where session-end-check.sh finds it: the env,
// then the MCP configs of each IDE. The key never leaves this process.
function hubEndpoint() {
  const bearer = (auth) => (/^bearer /i.test(auth) ? auth : `Bearer ${auth}`)
  const envUrl = process.env.CORTEX_MCP_URL || process.env.HUB_MCP_URL
  if (envUrl && process.env.HUB_API_KEY) return { url: envUrl, auth: bearer(process.env.HUB_API_KEY) }
  const home = os.homedir()
  const servers = (doc) => ({ ...(doc.mcpServers || {}), ...(doc.servers || {}) })
  const claude = load(path.join(home, '.claude.json'))
  const configs = [
    servers(load(path.join(project, '.mcp.json'))),
    servers((claude.projects || {})[project] || {}),
    servers(claude),
    servers(load(path.join(project, '.gemini', 'settings.json'))),
    servers(load(path.join(home, '.gemini', 'settings.json'))),
    servers(load(path.join(home, '.gemini', 'antigravity', 'mcp_config.json'))),
    servers(load(path.join(home, '.cursor', 'mcp.json'))),
    servers(load(path.join(home, '.codeium', 'windsurf', 'mcp_config.json'))),
    servers(load(path.join(project, '.vscode', 'mcp.json'))),
  ]
  for (const found of configs) {
    const e = found['cortex-hub'] || Object.entries(found).find(([k]) => k.toLowerCase().includes('cortex'))?.[1]
    if (!e || typeof e !== 'object') continue
    const env = e.env && typeof e.env === 'object' ? e.env : {}
    const args = (e.args || []).filter((a) => typeof a === 'string')
    const url = e.url || e.httpUrl || e.serverUrl || args.find((a) => a.startsWith('http'))
    let auth = (e.headers || {}).Authorization || (e.headers || {}).authorization
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '--header' && /^authorization:/i.test(args[i + 1])) auth = auth || args[i + 1].split(':').slice(1).join(':')
    }
    auth = String(auth || '').replace(/\$\{(\w+)\}/g, (_, v) => env[v] || process.env[v] || '').trim()
    if (url && auth) return { url, auth: bearer(auth) }
  }
  return null
}

function remoteUrl() {
  try {
    return execFileSync('git', ['-C', project, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8', timeout: 2000 }).trim() || undefined
  } catch { return undefined }
}

/** An MCP answer, plain JSON or one server-sent event. */
function rpcResult(text) {
  const data = text.trimStart().startsWith('{') ? text : text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('')
  const msg = JSON.parse(data)
  if (msg.error || msg.result?.isError) throw new Error('hub refused')
  return JSON.parse(msg.result.content[0].text)
}

async function askHub(query) {
  const hub = hubEndpoint()
  if (!hub) return null
  const res = await fetch(hub.url, {
    method: 'POST',
    headers: { Authorization: hub.auth, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'cortex_recall', arguments: { query, repo: remoteUrl(), limit: LIMIT } },
    }),
    signal: AbortSignal.timeout(RECALL_TIMEOUT),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return rpcResult(await res.text())
}

async function main() {
  let event = {}
  try { event = JSON.parse(fs.readFileSync(0, 'utf8')) } catch { return }
  const prompt = typeof event.prompt === 'string' ? event.prompt.trim() : ''
  // A slash command runs its own recall; a short reply ("yes", "go on") has nothing to match.
  if (prompt.length < MIN_CHARS || prompt.startsWith('/')) return

  const found = await askHub(prompt.slice(0, MAX_QUERY)).catch(() => null)
  if (!found) return

  fs.mkdirSync(dir, { recursive: true })
  const shownFile = path.join(dir, `shown-${String(event.session_id || 'session').replace(/[^\w.-]/g, '_')}`)
  let shown = []
  try { shown = fs.readFileSync(shownFile, 'utf8').split('\n') } catch {}
  const fresh = (list) => (Array.isArray(list) ? list : []).filter((x) => x && x.id && !shown.includes(String(x.id)))
  const knowledge = fresh(found.knowledge)
  const memories = fresh(found.memories)
  if (knowledge.length + memories.length === 0) return
  fs.appendFileSync(shownFile, [...knowledge, ...memories].map((x) => `${x.id}\n`).join(''))

  const lines = [
    ...knowledge.map((k) => `- [knowledge ${k.id}] ${k.title}${k.snippet ? ` — ${k.snippet}` : ''}`),
    ...memories.map((m) => `- [memory] ${m.text}`),
  ]
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `📚 Cortex recall: this project already has these on the prompt.\n${lines.join('\n')}\n`
        + 'Read the full document with cortex_knowledge_search before rebuilding or re-deriving what it covers.',
    },
  }))
}

main().catch(() => {})
RECALLJS
STATE_DIR="$STATE_DIR" PROJECT_DIR="$PROJECT_DIR" node -e "$RECALL_JS" 2>/dev/null
exit 0
