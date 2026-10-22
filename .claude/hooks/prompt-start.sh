#!/bin/bash
# Cortex Prompt Start (v1) — opens the cortex session from the user's prompt, before the agent's first turn.
#
# cortex_session_start with the task answers the recall and the first code lookup in one call,
# but the agent still spent a whole turn making it: a turn that re-reads the entire context to
# write one tool call whose arguments a script already knows. Measured on a large repo, that
# turn was most of what a hub-backed run cost over a plain grep one. So the prompt goes to the
# hub here, the answer goes in front of the agent with the prompt, and the gates open on the
# hub's evidence lines, the same ones track-quality.sh accepts from the agent's own call.
#
# What is sent: the first 300 characters of the prompt (the hub's limit on a task), with
# anything that looks like a key, token or password replaced. The hub embeds it to search
# and keeps nothing of it; no model reads it. Slash commands and short replies ("ok", "go on")
# send nothing, and a hub that does not answer in time leaves the agent to start the session
# itself, as before.
#
# CORTEX_PROMPT_START=off turns it off; so does gate-off, since the hub is down. It is JavaScript
# in a shell file so the installers can ship it like every other hook; without node it does nothing.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"

[ "${CORTEX_PROMPT_START:-}" = "off" ] && exit 0
[ -s "$STATE_DIR/gate-off" ] && exit 0
command -v node >/dev/null 2>&1 || exit 0

# read, not $(cat << …): bash 3.2, macOS's own, misparses quotes in a heredoc inside $( ).
IFS= read -r -d '' START_JS << 'STARTJS' || true
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

/** The prompt waits on this hook: a slow hub costs the user this much, then the agent starts it. */
const START_TIMEOUT = 5000
const MIN_CHARS = 12
/** The hub's limit on a task, and more than enough to say what a prompt is about. */
const MAX_TASK = 300

const project = process.env.PROJECT_DIR
const stateDir = process.env.STATE_DIR

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

function git(...args) {
  try {
    return execFileSync('git', ['-C', project, ...args], { encoding: 'utf8', timeout: 2000 }).trim() || undefined
  } catch { return undefined }
}

// Keys pasted into a prompt stay on this machine: provider-shaped keys, JWTs, credentials in a
// URL, `token=…`-style assignments, and any long unbroken run of key-like characters.
const SECRETS = [
  [/(:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1<redacted>@'],
  [/\b((?:api[_-]?)?(?:key|token|secret|passw(?:or)?d|pwd))(\s*[=:]\s*)\S+/gi, '$1$2<redacted>'],
  [/\bBearer\s+\S+/gi, 'Bearer <redacted>'],
  [/\b(?:sk|pk|rk)[_-][A-Za-z0-9_-]{8,}/g, '<redacted>'],
  [/\bgh[pousr]_[A-Za-z0-9]{8,}/g, '<redacted>'],
  [/\bgithub_pat_[A-Za-z0-9_]{8,}/g, '<redacted>'],
  [/\bAKIA[0-9A-Z]{12,}/g, '<redacted>'],
  [/\bxox[abprs]-[A-Za-z0-9-]{8,}/g, '<redacted>'],
  [/\beyJ[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]+){1,2}/g, '<redacted>'],
  // Letters and digits mixed, 32 or more: a key or a hash. A long-named path or symbol has no digit.
  [/(?=[A-Za-z0-9+_=-]*\d)(?=[A-Za-z0-9+_=-]*[A-Za-z])[A-Za-z0-9+_=-]{32,}/g, '<redacted>'],
]

/** The prompt as the hub gets it: no secrets, one line, at most MAX_TASK characters. */
function scrub(prompt) {
  let task = prompt
  for (const [re, to] of SECRETS) task = task.replace(re, to)
  return task.replace(/\s+/g, ' ').trim().slice(0, MAX_TASK)
}

/** The same identity session-id.sh puts on the agent's own call, so the hub keeps one session. */
function identity() {
  const who = load(path.join(project, '.cortex', 'agent-identity.json'))
  const env = who.environment && typeof who.environment === 'object' ? who.environment : {}
  const found = {
    hostname: env.hostname, os: env.os, role: who.role, branch: git('branch', '--show-current'),
    ide: /vscode/.test(process.env.CLAUDE_CODE_ENTRYPOINT || '') ? 'claude-code-vscode' : 'claude-code-cli',
  }
  const out = Object.fromEntries(Object.entries(found).filter(([, v]) => typeof v === 'string' && v))
  if (Array.isArray(who.capabilities) && who.capabilities.length && who.capabilities.every((c) => typeof c === 'string')) {
    out.capabilities = who.capabilities
  }
  return out
}

/** An MCP answer, plain JSON or one server-sent event: its text blocks. */
function rpcTexts(text) {
  const data = text.trimStart().startsWith('{') ? text : text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('')
  const msg = JSON.parse(data)
  if (msg.error || msg.result?.isError) throw new Error('hub refused')
  return (msg.result.content || []).filter((b) => b.type === 'text').map((b) => b.text)
}

async function startSession(task, clientSessionId) {
  const hub = hubEndpoint()
  // Credentials in the remote stay here: only the host and path go to the hub.
  const repo = git('config', '--get', 'remote.origin.url')?.replace(/:\/\/[^/@]+@/, '://')
  if (!hub || !repo) return null
  const res = await fetch(hub.url, {
    method: 'POST',
    headers: { Authorization: hub.auth, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: {
        name: 'cortex_session_start',
        arguments: { ...identity(), repo, mode: 'development', agentId: 'claude-code', task, clientSessionId },
      },
    }),
    signal: AbortSignal.timeout(START_TIMEOUT),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const [head, ...brief] = rpcTexts(await res.text())
  const status = JSON.parse(head)
  // Without the hub the tool still answers, with an id only it knows: no session to speak of.
  if (status.hub_error || !/^sess_/.test(String(status.session_id || ''))) return null
  return { sessionId: status.session_id, note: status.project_note, brief: brief.join('\n') }
}

/** Evidence as track-quality.sh writes it, naming this hook. */
function record(name) {
  fs.writeFileSync(path.join(stateDir, name), `tool=prompt-start at=${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}\n`)
}

async function main() {
  let event = {}
  try { event = JSON.parse(fs.readFileSync(0, 'utf8')) } catch { return }
  const prompt = typeof event.prompt === 'string' ? event.prompt.trim() : ''
  // A slash command runs its own start; a short reply has no task to look up.
  if (prompt.length < MIN_CHARS || prompt.startsWith('/')) return
  const clientSessionId = String(event.session_id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128)
  if (!clientSessionId) return
  const task = scrub(prompt)
  if (task.length < MIN_CHARS) return

  const started = await startSession(task, clientSessionId).catch(() => null)
  if (!started) return

  fs.mkdirSync(path.join(stateDir, 'conversations'), { recursive: true })
  fs.writeFileSync(path.join(stateDir, 'session-id'), `${started.sessionId}\n`)
  fs.writeFileSync(path.join(stateDir, 'conversations', clientSessionId), `${started.sessionId}\n`)
  record('session-started')
  fs.rmSync(path.join(stateDir, 'session-ended'), { force: true })
  // The hub prints each line only when that part answered.
  if (/^recalled: knowledge\+memory for /m.test(started.brief)) { record('knowledge-recalled'); record('memory-recalled') }
  if (/^located: code for /m.test(started.brief)) record('discovery-used')

  const context = [
    `Cortex session ${started.sessionId} is open for this prompt: cortex_session_start already ran with it as the task, so do not call it again.`,
    started.note,
    started.brief,
  ].filter(Boolean).join('\n')
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }))
}

main().catch(() => {})
STARTJS
STATE_DIR="$STATE_DIR" PROJECT_DIR="$PROJECT_DIR" node -e "$START_JS" 2>/dev/null
exit 0
