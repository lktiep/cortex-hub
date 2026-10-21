#!/bin/bash
# Cortex File Notes (v1) — what past work learned about a file, shown before the agent opens it.
#
# Risks, lessons and fixes stored with cortex_knowledge_store(files: [...]), and the risks a
# conductor task reported when it completed, are linked to repo files on the hub. An agent
# about to read or edit one of those files gets them as context here, once per conversation
# and agent, instead of having to know that a search would have found them. Never a block.
#
# The hub is asked once for every linked path of the project (cortex_file_notes), kept in
# .cortex/.session-state/notes/index.json for NOTES_TTL, so a read costs no request at all.
# A hub that does not answer is asked again after FAILED_TTL; meanwhile the hook says nothing.
#
# CORTEX_NOTES=off turns it off; so does gate-off, since the hub is down. It is JavaScript in
# a shell file so the installers can ship it like every other hook; without node it does nothing.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"

[ "${CORTEX_NOTES:-}" = "off" ] && exit 0
[ -s "$STATE_DIR/gate-off" ] && exit 0
command -v node >/dev/null 2>&1 || exit 0

# read, not $(cat << …): bash 3.2, macOS's own, misparses quotes in a heredoc inside $( ).
IFS= read -r -d '' NOTES_JS << 'NOTESJS' || true
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const NOTES_TTL = 10 * 60_000
const FAILED_TTL = 2 * 60_000
/** Another hook already asking the hub: its answer is waited for no longer than this. */
const LOCK_STALE = 15_000
const PER_FILE = 3

const project = process.env.PROJECT_DIR
const dir = path.join(process.env.STATE_DIR, 'notes')

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

async function askHub() {
  const hub = hubEndpoint()
  if (!hub) return null
  const res = await fetch(hub.url, {
    method: 'POST',
    headers: { Authorization: hub.auth, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'cortex_file_notes', arguments: { repo: remoteUrl() } },
    }),
    signal: AbortSignal.timeout(4000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = rpcResult(await res.text())
  return body.notes && typeof body.notes === 'object' ? body.notes : {}
}

/** Every linked path of the project and its notes: the cached index, else the hub's. */
async function index() {
  const file = path.join(dir, 'index.json')
  const cached = load(file)
  const age = Date.now() - (cached.at || 0)
  if (age < (cached.ok ? NOTES_TTL : FAILED_TTL)) return cached.notes || {}
  const lock = path.join(dir, 'lock')
  try {
    fs.mkdirSync(lock)
  } catch {
    try { if (Date.now() - fs.statSync(lock).mtimeMs < LOCK_STALE) return cached.notes || {} } catch {}
    fs.rmSync(lock, { recursive: true, force: true })
    try { fs.mkdirSync(lock) } catch { return cached.notes || {} }
  }
  try {
    const notes = await askHub().catch(() => null)
    // A hub that did not answer keeps what was known: stale notes beat none.
    const next = notes === null ? { at: Date.now(), ok: false, notes: cached.notes || {} } : { at: Date.now(), ok: true, notes }
    fs.writeFileSync(file, JSON.stringify(next))
    return next.notes
  } finally {
    fs.rmSync(lock, { recursive: true, force: true })
  }
}

/** The file as the hub links it, relative to the repo; null outside it. Symlinked checkouts (/tmp) match either way. */
function repoPath(target) {
  const inside = (root, file) => {
    const rel = path.relative(root, file).split(path.sep).join('/')
    return rel === '' || rel.startsWith('../') || path.isAbsolute(rel) ? null : rel
  }
  const file = path.resolve(project, target)
  let real = file
  try { real = path.join(fs.realpathSync(path.dirname(file)), path.basename(file)) } catch {}
  let root = project
  try { root = fs.realpathSync(project) } catch {}
  return inside(project, file) ?? inside(root, real)
}

async function main() {
  let event = {}
  try { event = JSON.parse(fs.readFileSync(0, 'utf8')) } catch { return }
  const input = event.tool_input || {}
  const target = input.file_path || input.notebook_path
  if (typeof target !== 'string' || target === '') return
  const rel = repoPath(target)
  if (rel === null) return

  fs.mkdirSync(dir, { recursive: true })
  const agent = [event.session_id, event.agent_id || 'main'].filter(Boolean).join('-').replace(/[^\w.-]/g, '_')
  const shownFile = path.join(dir, `shown-${agent}`)
  let shown = []
  try { shown = fs.readFileSync(shownFile, 'utf8').split('\n') } catch {}
  if (shown.includes(rel)) return

  const notes = await index()
  const found = []
  for (const [linked, list] of Object.entries(notes)) {
    if (linked !== rel && !(linked.endsWith('/') && rel.startsWith(linked))) continue
    for (const n of Array.isArray(list) ? list : []) if (!found.some((f) => f.id === n.id)) found.push(n)
  }
  fs.appendFileSync(shownFile, `${rel}\n`)
  if (found.length === 0) return
  found.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  const lines = found.slice(0, PER_FILE).map((n) => `- [${n.kind}] ${n.title}${n.note && n.note !== n.title ? ` — ${n.note}` : ''}`)
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: `📌 Cortex notes on ${rel}, from earlier work on it:\n${lines.join('\n')}`,
    },
  }))
}

main().catch(() => {})
NOTESJS
STATE_DIR="$STATE_DIR" PROJECT_DIR="$PROJECT_DIR" node -e "$NOTES_JS" 2>/dev/null
exit 0
