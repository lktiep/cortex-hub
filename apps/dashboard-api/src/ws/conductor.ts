// Worker WebSocket (spec §6.3, §6.5). A protocol-2 worker connects with its
// key, agent id and `protocol=2` in the query and is dispatched to once it has
// sent `worker.register`. A protocol-1 client with its agent id in the query
// (the extension) is ready on connect. A legacy script that connects with its
// key only is held under a placeholder id, unannounced and not dispatched to,
// until its `agent.register` names it. Task outcomes go through the lifecycle
// module, assignments through the dispatcher; connections live in the registry.
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import type { IncomingMessage, Server } from 'http'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  CLOSE_CODES, EXECUTORS,
  type EngineInfo, type Executor, type RegisteredMsg, type TaskHandoff, type TaskQuotaExhaustedMsg,
  type TaskResult, type TaskRevokedMsg, type WorkerView,
} from '@cortex/shared-types'
import { db } from '../db/client.js'
import { baseBranchFor } from '../conductor/config.js'
import { dispatch } from '../conductor/dispatcher.js'
import {
  acceptTask, completeTask, declineTask, failAttempt, onCompleted, quotaExhausted, recordProgress, returnTask,
  type Outcome,
} from '../conductor/lifecycle.js'
import { assignedMsg } from '../conductor/messages.js'
import {
  addConnection, broadcastToOwner, getByAgent, getConnection, isPlaceholderAgentId, listConnections, placeholderAgentId,
  rekeyConnection, removeConnection, sendTo, setStatus, touch, updateConnection, type WorkerConn,
} from '../conductor/registry.js'
import { ACTIVE_STATUSES, getTask, isoSeconds, logTask } from '../conductor/rows.js'
import { findProjectByRepo } from '../lib/project-match.js'
import { appVersion } from '../version.js'

const OPEN = 1
const KEEPALIVE_MS = 30_000
const STALE_MS = 60_000
const PROGRESS_MAX = 4000
const ACTIVE_IN = ACTIVE_STATUSES.map(() => '?').join(', ')
const COMPLETE_STATUSES = ['completed', 'review', 'failed'] as const
/** TaskResult fields the lifecycle and notifications read as text; a non-string value is dropped. */
const RESULT_TEXT_FIELDS = ['prUrl', 'branch', 'commit', 'testOutput', 'error'] as const

// ── Load valid capabilities from templates ──
let validCapabilityIds: Set<string> = new Set()
try {
  const templatesPath = resolve(process.cwd(), '../../.cortex/capability-templates.json')
  const templates = JSON.parse(readFileSync(templatesPath, 'utf-8'))
  validCapabilityIds = new Set(
    (templates.available_capabilities as { id: string }[]).map((c) => c.id)
  )
} catch {
  console.warn('[ws] Could not load capability-templates.json — capability validation disabled')
}

/** Validate and filter capabilities against known templates */
function validateCapabilities(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const caps = raw.filter((c): c is string => typeof c === 'string')
  if (validCapabilityIds.size === 0) return caps // no templates loaded, pass through
  const valid: string[] = []
  for (const cap of caps) {
    if (validCapabilityIds.has(cap)) {
      valid.push(cap)
    } else {
      console.warn(`[ws] Unknown capability ignored: "${cap}"`)
    }
  }
  return valid
}

/** The `capabilities` query parameter: a JSON array, possibly URI-encoded once more. */
function parseCapabilities(raw: string | null): unknown {
  const text = raw || '[]'
  try {
    return JSON.parse(decodeURIComponent(text))
  } catch {
    try { return JSON.parse(text) } catch { return [] }
  }
}

// ── Message field readers ──

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

function attemptOf(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined
}

function toExecutor(v: unknown): Executor | null {
  return typeof v === 'string' && (EXECUTORS as readonly string[]).includes(v) ? (v as Executor) : null
}

/** Engines with a known executor and a `models` array; non-string models are dropped. */
function toEngines(raw: unknown): EngineInfo[] {
  if (!Array.isArray(raw)) return []
  const engines: EngineInfo[] = []
  for (const e of raw) {
    if (!isRecord(e)) continue
    const executor = toExecutor(e['executor'])
    const models = e['models']
    if (executor === null || !Array.isArray(models)) continue
    engines.push({
      executor,
      models: models.filter((m): m is string => typeof m === 'string'),
      defaultModel: typeof e['defaultModel'] === 'string' ? e['defaultModel'] : null,
    })
  }
  return engines
}

/**
 * A worker's `result`: a legacy script sends a string, the extension an object
 * without `summary`. Either way the lifecycle gets a string `summary`; the
 * other fields are kept.
 */
function toResult(raw: unknown): TaskResult {
  if (typeof raw === 'string') return { summary: raw }
  const fields: Record<string, unknown> = isRecord(raw) ? { ...raw } : {}
  for (const key of RESULT_TEXT_FIELDS) {
    if (key in fields && typeof fields[key] !== 'string') delete fields[key]
  }
  // the text fields are strings now; anything else is only stored as JSON
  return { ...fields, summary: typeof fields['summary'] === 'string' ? fields['summary'] : '' } as TaskResult
}

function toHandoff(raw: unknown): TaskHandoff | null {
  if (!isRecord(raw) || typeof raw['branch'] !== 'string') return null
  return {
    branch: raw['branch'],
    commit: typeof raw['commit'] === 'string' ? raw['commit'] : null,
    note: typeof raw['note'] === 'string' ? raw['note'] : '',
  }
}

/** Null when `taskId`, `executor`, `model` or `handoff` is missing or malformed. */
function toQuotaMsg(msg: Record<string, unknown>): TaskQuotaExhaustedMsg | null {
  const taskId = str(msg['taskId'])
  const executor = toExecutor(msg['executor'])
  const model = str(msg['model'])
  const handoff = toHandoff(msg['handoff'])
  if (taskId === null || executor === null || model === null || handoff === null) return null
  return {
    type: 'task.quota_exhausted',
    taskId,
    executor,
    model,
    modelScope: str(msg['modelScope']) ?? undefined,
    resetAt: str(msg['resetAt']) ?? undefined,
    raw: typeof msg['raw'] === 'string' ? msg['raw'] : '',
    handoff,
    attempt: attemptOf(msg['attempt']),
  }
}

// ── Sending ──

function reply(agent: WorkerConn, msg: object): void {
  if (agent.ws.readyState === OPEN) agent.ws.send(JSON.stringify(msg))
}

/** Every open socket, whatever its owner (dashboard events). */
function broadcastAll(msg: object): void {
  for (const conn of listConnections()) sendTo(conn.agentId, msg)
}

/** A step the lifecycle refused (not the holder, stale attempt, …) has been logged there; it is only reported here. */
function applied(agent: WorkerConn, step: string, outcome: Outcome): outcome is Extract<Outcome, { ok: true }> {
  if (!outcome.ok) console.warn(`[ws] ${step} from ${agent.agentId} ignored: ${outcome.error}`)
  return outcome.ok
}

/**
 * Unregisters the connection; `agent.offline` only when it was still
 * registered (not replaced or dropped already) and had been announced (not
 * under a placeholder id).
 */
function dropConnection(conn: WorkerConn): void {
  if (!removeConnection(conn.connectionId) || isPlaceholderAgentId(conn.agentId)) return
  broadcastToOwner(conn.apiKeyOwner, {
    type: 'agent.offline',
    agentId: conn.agentId,
    timestamp: new Date().toISOString(),
  })
  console.log(`[ws] Agent disconnected: ${conn.agentId}`)
}

/** Unregisters the connection, then closes its socket with `code`. */
function refuse(conn: WorkerConn, code: number, reason: string): void {
  dropConnection(conn)
  conn.ws.close(code, reason)
}

/** `agent.online` to the owner's other sockets. */
function announce(conn: WorkerConn): void {
  broadcastToOwner(
    conn.apiKeyOwner,
    {
      type: 'agent.online',
      agentId: conn.agentId,
      hostname: conn.hostname || undefined,
      ide: conn.ide ?? undefined,
      capabilities: conn.capabilities,
      platform: conn.platform ?? undefined,
      timestamp: new Date().toISOString(),
    },
    conn.agentId,
  )
}

export function setupConductorWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws/conductor' })

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // Extract params from query string: /ws/conductor?apiKey=sk_xxx&agentId=xxx
    const url = new URL(req.url || '', `http://${req.headers.host}`)
    const apiKey = url.searchParams.get('apiKey')
    if (!apiKey) {
      ws.close(CLOSE_CODES.missingKey, 'Missing apiKey')
      return
    }

    // Validate API key against stored keys (hash the raw key first)
    const keyHash = createHash('sha256').update(apiKey).digest('hex')
    const keyRow = db
      .prepare('SELECT name, project_id FROM api_keys WHERE key_hash = ?')
      .get(keyHash) as { name: string; project_id: string | null } | undefined
    if (!keyRow) {
      ws.close(CLOSE_CODES.badKey, 'Invalid apiKey')
      return
    }

    // no agent id (a legacy script names itself in agent.register): a placeholder until then
    const queryAgentId = str(url.searchParams.get('agentId'))
    const named = queryAgentId !== null && !isPlaceholderAgentId(queryAgentId)
    const added = addConnection({
      ws,
      agentId: named ? queryAgentId : placeholderAgentId(),
      apiKeyOwner: keyRow.name,
      apiKeyProjectId: keyRow.project_id,
      hostname: url.searchParams.get('hostname') || '',
      ide: url.searchParams.get('ide') || null,
      platform: url.searchParams.get('platform') || null,
      capabilities: validateCapabilities(parseCapabilities(url.searchParams.get('capabilities'))),
    })
    if (!added.ok) {
      ws.close(added.code, added.reason)
      return
    }
    const conn = added.conn
    // a protocol-1 client named in the query (the extension) may never register: it is ready now
    if (named && url.searchParams.get('protocol') !== '2') updateConnection(conn.connectionId, { ready: true })
    if (named) announce(conn)

    // Send welcome with current agent list
    reply(conn, {
      type: 'welcome',
      agentId: conn.agentId,
      onlineAgents: getOnlineAgents(conn.apiKeyOwner),
      timestamp: new Date().toISOString(),
    })

    console.log(`[ws] Agent connected: ${conn.agentId} (${conn.apiKeyOwner})${added.replaced ? ', replacing its previous connection' : ''}`)

    ws.on('message', (data: RawData) => onMessage(ws, conn.connectionId, data))
    ws.on('close', () => dropConnection(conn))
    ws.on('pong', () => touch(conn.connectionId))
    if (conn.ready) dispatch()
  })

  // Keepalive interval: terminate stale connections, ping active ones
  const keepalive = setInterval(() => {
    for (const conn of listConnections()) {
      if (!(conn.ws instanceof WebSocket)) continue
      if (Date.now() - Date.parse(conn.lastPing) > STALE_MS) {
        conn.ws.terminate()
        dropConnection(conn)
      } else if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.ping()
      }
    }
  }, KEEPALIVE_MS)
  wss.on('close', () => clearInterval(keepalive))

  return wss
}

/**
 * Parses one frame and hands it to its handler. A frame from a socket that has
 * been replaced or dropped is ignored; a handler that throws is logged.
 */
function onMessage(ws: WebSocket, connectionId: string, data: RawData): void {
  let msg: unknown
  try {
    msg = JSON.parse(data.toString())
  } catch {
    if (ws.readyState === OPEN) ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }))
    return
  }
  if (!isRecord(msg)) {
    if (ws.readyState === OPEN) ws.send(JSON.stringify({ type: 'error', message: 'Message must be a JSON object' }))
    return
  }
  const agent = getConnection(connectionId)
  if (agent === undefined) return
  try {
    handleMessage(agent, msg)
  } catch (err) {
    console.error(`[ws] ${String(msg['type'])} from ${agent.agentId} failed:`, err)
  }
}

/**
 * `worker.register` (protocol 2): resolves the project, records the worker,
 * answers `registered`, then (the first time on this connection) resumes or
 * revokes the task the worker reports and settles the other active tasks the
 * hub still holds for it; then dispatches.
 */
function onWorkerRegister(agent: WorkerConn, msg: Record<string, unknown>): void {
  if (isPlaceholderAgentId(agent.agentId)) {
    refuse(agent, CLOSE_CODES.missingKey, 'agentId required')
    return
  }
  const matched = findProjectByRepo(str(msg['repo']) ?? '')?.id ?? null
  if (matched !== null && agent.apiKeyProjectId !== null && matched !== agent.apiKeyProjectId) {
    console.warn(`[ws] ${agent.agentId}: repo is project ${matched}, its key is scoped to ${agent.apiKeyProjectId}`)
    refuse(agent, CLOSE_CODES.badKey, 'key is scoped to another project')
    return
  }
  const reregister = agent.ready && agent.protocol === 2
  const projectId = matched ?? agent.apiKeyProjectId
  updateConnection(agent.connectionId, {
    protocol: 2,
    os: str(msg['os']),
    version: str(msg['version']),
    capabilities: validateCapabilities(msg['capabilities']),
    engines: toEngines(msg['engines']),
    defaultExecutor: toExecutor(msg['defaultExecutor']),
    projectId,
    ready: true,
  })
  reply(agent, { type: 'registered', connectionId: agent.connectionId, projectId, hubVersion: appVersion } satisfies RegisteredMsg)
  console.log(`[ws] Worker registered: ${agent.agentId} v${agent.version ?? '?'} project=${projectId ?? 'none'}`)
  if (!reregister) settleRestart(agent, str(msg['activeTaskId']))
  dispatch()
}

/**
 * A worker that (re)started: the task it reports is resumed or revoked; the
 * other active tasks the hub still holds for it are returned (not started) or
 * failed (started).
 */
function settleRestart(agent: WorkerConn, activeTaskId: string | null): void {
  let resumed: string | null = null
  if (activeTaskId !== null) {
    const task = getTask(activeTaskId)
    if (task !== undefined && (ACTIVE_STATUSES as readonly string[]).includes(task.status) && task.assigned_to_agent === agent.agentId) {
      reply(agent, assignedMsg(task, baseBranchFor(task.project_id), 'task.resumed'))
      resumed = task.id
    } else {
      // the hub has taken it back (reclaimed, reassigned or finished): the worker stops; the row is not touched
      reply(agent, { type: 'task.revoked', taskId: activeTaskId, reason: 'reclaimed' } satisfies TaskRevokedMsg)
    }
  }

  // tasks the hub still holds for this agent that the restarted worker no longer runs
  const held = db.prepare(`SELECT id, status FROM conductor_tasks WHERE assigned_to_agent = ? AND status IN (${ACTIVE_IN})`)
    .all(agent.agentId, ...ACTIVE_STATUSES) as { id: string; status: string }[]
  for (const task of held) {
    if (task.id === resumed) continue
    if (task.status === 'assigned') returnTask(task.id, 'worker restarted')
    else failAttempt(task.id, agent.agentId, 'worker restarted without the task')
  }
}

/**
 * `agent.register` (protocol 1: cortex-agent.sh, cortex-agent.ps1). A socket
 * under a placeholder takes the agent id and hostname it names, by the
 * registry's rules (4009 when another host holds the id, 4001 without one),
 * and is announced. A socket named in the query keeps its identity. Then
 * metadata, ready, and a dispatch.
 */
function onAgentRegister(agent: WorkerConn, msg: Record<string, unknown>): void {
  const anonymous = isPlaceholderAgentId(agent.agentId)
  if (anonymous) {
    const agentId = str(msg['agentId'])
    if (agentId === null || isPlaceholderAgentId(agentId)) {
      refuse(agent, CLOSE_CODES.missingKey, 'agentId required')
      return
    }
    const rekeyed = rekeyConnection(agent.connectionId, agentId, str(msg['hostname']) ?? agent.hostname)
    if (rekeyed === undefined) return
    if (!rekeyed.ok) {
      refuse(agent, rekeyed.code, rekeyed.reason)
      return
    }
  }
  const caps = validateCapabilities(msg['capabilities'])
  updateConnection(agent.connectionId, {
    ...(caps.length > 0 ? { capabilities: caps } : {}),
    ide: str(msg['ide']) ?? agent.ide,
    platform: str(msg['platform']) ?? str(msg['os']) ?? agent.platform,
    ready: true,
  })
  if (anonymous) {
    announce(agent)
  } else {
    broadcastToOwner(agent.apiKeyOwner, {
      type: 'agent.capabilities_updated',
      agentId: agent.agentId,
      capabilities: agent.capabilities,
      timestamp: new Date().toISOString(),
    }, agent.agentId)
  }
  console.log(`[ws] Agent registered: ${agent.agentId} capabilities=[${agent.capabilities.join(',')}]`)
  dispatch()
}

function handleMessage(agent: WorkerConn, msg: Record<string, unknown>) {
  const type = msg['type'] as string | undefined

  switch (type) {
    case 'worker.register':
      onWorkerRegister(agent, msg)
      break

    case 'agent.register':
      onAgentRegister(agent, msg)
      break

    case 'task.accept': {
      const taskId = str(msg['taskId'])
      if (taskId === null || !applied(agent, 'task.accept', acceptTask(taskId, agent.agentId))) break
      broadcastToOwner(agent.apiKeyOwner, {
        type: 'task.accepted',
        taskId,
        agentId: agent.agentId,
        timestamp: new Date().toISOString(),
      })
      break
    }

    case 'task.progress': {
      const taskId = str(msg['taskId'])
      if (taskId === null) break
      const message = (typeof msg['message'] === 'string' ? msg['message'] : '').slice(0, PROGRESS_MAX)
      const percent = typeof msg['percent'] === 'number' ? msg['percent'] : undefined
      if (!applied(agent, 'task.progress', recordProgress(taskId, agent.agentId, message, percent))) break
      broadcastToOwner(agent.apiKeyOwner, {
        type: 'task.progress',
        taskId,
        agentId: agent.agentId,
        message,
        percent,
        timestamp: new Date().toISOString(),
      })
      break
    }

    case 'task.complete': {
      const taskId = str(msg['taskId'])
      if (taskId === null) break
      // the extension, cortex-agent.ps1 and older cortex-agent.sh send no status: theirs is a completion
      const status = msg['status'] ?? 'completed'
      if (!COMPLETE_STATUSES.some((s) => s === status)) {
        console.warn(`[ws] task.complete from ${agent.agentId} ignored: unknown status ${JSON.stringify(status)}`)
        break
      }
      const result = toResult(msg['result'])
      const outcome = completeTask(
        taskId, agent.agentId, status as (typeof COMPLETE_STATUSES)[number], result, attemptOf(msg['attempt']),
      )
      if (!applied(agent, 'task.complete', outcome) || outcome.task.status !== 'completed') break
      broadcastToOwner(agent.apiKeyOwner, {
        type: 'task.completed',
        taskId,
        agentId: agent.agentId,
        result,
        timestamp: new Date().toISOString(),
      })
      break
    }

    case 'task.quota_exhausted': {
      const quota = toQuotaMsg(msg)
      if (quota === null) {
        console.warn(`[ws] task.quota_exhausted from ${agent.agentId} ignored: malformed`)
        break
      }
      applied(agent, 'task.quota_exhausted', quotaExhausted(quota.taskId, agent.agentId, quota))
      break
    }

    case 'task.decline': {
      const taskId = str(msg['taskId'])
      if (taskId === null) break
      const reason = str(msg['reason']) ?? 'no reason given'
      applied(agent, 'task.decline', declineTask(taskId, agent.agentId, reason, attemptOf(msg['attempt'])))
      break
    }

    case 'capabilities.update': {
      // Allow agents to update their capabilities at runtime (validated)
      const validated = validateCapabilities(msg['capabilities'])
      updateConnection(agent.connectionId, { capabilities: validated })
      broadcastToOwner(agent.apiKeyOwner, {
        type: 'agent.capabilities_updated',
        agentId: agent.agentId,
        capabilities: validated,
        timestamp: new Date().toISOString(),
      }, agent.agentId)
      break
    }

    case 'status.update': {
      // protocol 2 sends `state`; the extension sends `status`
      const state = msg['state'] ?? msg['status']
      if (state !== 'idle' && state !== 'busy') break
      setStatus(agent.agentId, state)
      if (state === 'idle') dispatch()
      break
    }

    case 'request.data': {
      // Extension requests project data via WS (no HTTP needed)
      const tasks = db.prepare(
        'SELECT * FROM conductor_tasks ORDER BY created_at DESC LIMIT 30'
      ).all() as Record<string, unknown>[]

      const sessions = db.prepare(
        'SELECT * FROM session_handoffs ORDER BY created_at DESC LIMIT 10'
      ).all() as Record<string, unknown>[]

      const qualitySummary = db.prepare(
        "SELECT COUNT(*) as total, AVG(score_total) as avgScore FROM quality_reports WHERE created_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-7 days')"
      ).get() as { total: number; avgScore: number | null } | undefined

      const taskStats = {
        total: tasks.length,
        completed: tasks.filter(t => t['status'] === 'completed').length,
        inProgress: tasks.filter(t => t['status'] === 'in_progress' || t['status'] === 'accepted').length,
        pending: tasks.filter(t => t['status'] === 'pending').length,
        failed: tasks.filter(t => t['status'] === 'failed').length,
      }

      const onlineAgents = getOnlineAgents(agent.apiKeyOwner)

      reply(agent, {
        type: 'data.response',
        tasks,
        sessions,
        agents: onlineAgents,
        taskStats,
        quality: qualitySummary ?? { total: 0, avgScore: null },
        timestamp: new Date().toISOString(),
      })
      break
    }

    case 'task.create': {
      // Create task via WebSocket (used by extension for review sub-tasks)
      const title = msg['title'] as string
      if (!title) break

      // Hard block: reject ALL task creation via WS that looks like strategy/review spam
      // Agents should implement their assigned task, not create new top-level tasks
      const titleLowerCheck = title.toLowerCase()
      const hasParent = !!msg['parentTaskId']
      if (titleLowerCheck.includes('strategy') || titleLowerCheck.includes('overhaul') || titleLowerCheck.includes('premium') || titleLowerCheck.includes('redesign')) {
        if (!hasParent) {
          console.warn(`[ws] task.create: BLOCKED top-level task "${title}" from ${agent.agentId} — agents cannot create strategy tasks`)
          reply(agent, {
            type: 'task.created',
            taskId: 'blocked',
            title,
            blocked: true,
            reason: 'Agents cannot create top-level strategy tasks. Implement your assigned task instead.',
            timestamp: new Date().toISOString(),
          })
          break
        }
      }
      if (titleLowerCheck.startsWith('[review]') || titleLowerCheck.startsWith('review:') || titleLowerCheck.includes('plan review')) {
        console.warn(`[ws] task.create: HARD BLOCKED review task "${title}" from ${agent.agentId}`)
        reply(agent, {
          type: 'task.created',
          taskId: 'blocked',
          title,
          blocked: true,
          deduplicated: true,
          timestamp: new Date().toISOString(),
        })
        break
      }

      // Global rate limiter: max 5 tasks per agent per 60 seconds
      const recentCount = db.prepare(
        "SELECT COUNT(*) as c FROM conductor_tasks WHERE created_by_agent = ? AND created_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-60 seconds')"
      ).get(agent.agentId) as { c: number }
      if (recentCount.c >= 5) {
        console.warn(`[ws] task.create: RATE LIMITED ${agent.agentId} (${recentCount.c} tasks in last 60s)`)
        reply(agent, {
          type: 'error',
          message: `Rate limited: too many tasks created (${recentCount.c}/5 per minute)`,
          timestamp: new Date().toISOString(),
        })
        break
      }

      const assignTo = msg['assignTo'] as string | undefined
      let parentTaskId = msg['parentTaskId'] as string | undefined
      const description = (msg['description'] as string) ?? ''
      const priority = (msg['priority'] as number) ?? 5
      const context = (msg['context'] as string) ?? '{}'

      // Auto-link: if agent has an active (accepted/in_progress) task and didn't set parentTaskId,
      // automatically set parent to the agent's current task
      if (!parentTaskId) {
        const activeTask = db.prepare(
          "SELECT id FROM conductor_tasks WHERE assigned_to_agent = ? AND status IN ('accepted', 'in_progress') ORDER BY accepted_at DESC LIMIT 1"
        ).get(agent.agentId) as { id: string } | undefined
        if (activeTask) {
          parentTaskId = activeTask.id
          console.log(`[ws] task.create: auto-linked "${title}" to parent ${activeTask.id} (agent ${agent.agentId}'s active task)`)
        }
      }

      // Block review task spam: if title starts with [Review], limit to 1 per parent per 5 minutes
      const titleLower = title.toLowerCase()
      if (titleLower.startsWith('[review]') || titleLower.includes('plan review')) {
        const recentReview = db.prepare(
          "SELECT id FROM conductor_tasks WHERE title LIKE '[Review]%' AND parent_task_id IS ? AND created_by_agent = ? AND created_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-300 seconds')"
        ).get(parentTaskId ?? null, agent.agentId) as { id: string } | undefined

        if (recentReview) {
          console.warn(`[ws] task.create: BLOCKED review spam "${title}" by ${agent.agentId} (existing: ${recentReview.id})`)
          reply(agent, {
            type: 'task.created',
            taskId: recentReview.id,
            title,
            assignedTo: assignTo,
            parentTaskId,
            deduplicated: true,
            blocked: true,
            timestamp: new Date().toISOString(),
          })
          break
        }
      }

      // Dedup: prevent creating duplicate tasks with same title+parent+agent within 30 seconds
      const recentDupe = db.prepare(
        "SELECT id FROM conductor_tasks WHERE title = ? AND parent_task_id IS ? AND created_by_agent = ? AND created_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-30 seconds')"
      ).get(title, parentTaskId ?? null, agent.agentId) as { id: string } | undefined

      if (recentDupe) {
        console.warn(`[ws] task.create: dedup hit for "${title}" by ${agent.agentId} (existing: ${recentDupe.id})`)
        reply(agent, {
          type: 'task.created',
          taskId: recentDupe.id,
          title,
          assignedTo: assignTo,
          parentTaskId,
          deduplicated: true,
          timestamp: new Date().toISOString(),
        })
        break
      }

      const newId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`

      // `assignTo` pins the task to that agent; the dispatcher assigns and pushes it
      db.prepare(`
        INSERT INTO conductor_tasks
          (id, title, description, priority, pinned_agent, created_by_agent,
           parent_task_id, context, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
      `).run(newId, title, description, priority, assignTo ?? null, agent.agentId,
        parentTaskId ?? null, context)

      console.log(`[ws] task.create: ${newId} "${title}" by ${agent.agentId} → ${assignTo ?? 'unassigned'}`)

      // Confirm back to creator
      reply(agent, {
        type: 'task.created',
        taskId: newId,
        title,
        assignedTo: assignTo,
        parentTaskId,
        timestamp: new Date().toISOString(),
      })
      dispatch()
      break
    }

    case 'task.synthesis': {
      // Lead Agent submits synthesis after all subtasks completed
      const taskId = msg['taskId'] as string | undefined
      const result = msg['result'] as Record<string, unknown> | undefined
      if (!taskId || !result) break

      const task = db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined
      if (!task || task['status'] !== 'synthesis') break

      // Complete the parent task with synthesized result
      db.prepare(`
        UPDATE conductor_tasks
        SET status = 'completed', completed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
            result = ?, completed_by = ?
        WHERE id = ?
      `).run(JSON.stringify(result), agent.agentId, taskId)

      db.prepare(
        'INSERT INTO conductor_task_logs (task_id, agent_id, action, message) VALUES (?, ?, ?, ?)'
      ).run(taskId, agent.agentId, 'synthesis_completed', 'Lead Agent synthesized subtask results')

      console.log(`[ws] task.synthesis: ${taskId} completed by ${agent.agentId}`)

      // Broadcast completion
      broadcastToOwner(agent.apiKeyOwner, {
        type: 'task.completed',
        taskId,
        title: task['title'],
        completedBy: agent.agentId,
        timestamp: new Date().toISOString(),
      })

      // Resolve completion chain for the parent
      const completedTask = getTask(taskId)
      if (completedTask) {
        onCompleted(completedTask)
      }
      break
    }

    case 'task.strategy': {
      // Lead Agent submits strategy for a task
      const taskId = msg['taskId'] as string | undefined
      const strategy = msg['strategy'] as Record<string, unknown> | undefined
      if (!taskId || !strategy) break

      const task = db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined
      if (!task) break

      // Save strategy into context
      let ctx: Record<string, unknown> = {}
      try { ctx = JSON.parse((task['context'] as string) ?? '{}') } catch { /* ignore */ }
      ctx['strategy'] = strategy
      ctx['phase'] = 'strategy_review'

      db.prepare(`
        UPDATE conductor_tasks SET status = 'strategy_review', context = ? WHERE id = ?
      `).run(JSON.stringify(ctx), taskId)

      // Log action
      db.prepare(
        'INSERT INTO conductor_task_logs (task_id, agent_id, action, message) VALUES (?, ?, ?, ?)'
      ).run(taskId, agent.agentId, 'strategy_submitted',
        `Strategy: ${(strategy['roles'] as unknown[])?.length ?? 0} roles, ${(strategy['subtasks'] as unknown[])?.length ?? 0} subtasks`)

      console.log(`[ws] task.strategy: ${taskId} by ${agent.agentId}`)

      // Broadcast to all (dashboard included)
      broadcastToOwner(agent.apiKeyOwner, {
        type: 'task.strategy_ready',
        taskId,
        title: task['title'],
        strategy,
        agentId: agent.agentId,
        timestamp: new Date().toISOString(),
      })
      break
    }

    case 'task.comment': {
      // Agent submits a comment on a task/finding
      const taskId = msg['taskId'] as string | undefined
      const comment = msg['comment'] as string | undefined
      if (!taskId || !comment) break

      const findingId = (msg['findingId'] as string) ?? null
      const commentType = (msg['commentType'] as string) ?? 'comment'

      const result = db.prepare(
        'INSERT INTO conductor_comments (task_id, finding_id, agent_id, comment, comment_type) VALUES (?, ?, ?, ?, ?)'
      ).run(taskId, findingId, agent.agentId, comment.slice(0, 4000), commentType)

      const created = db.prepare('SELECT * FROM conductor_comments WHERE id = ?').get(result.lastInsertRowid) as {
        id: number; task_id: string; finding_id: string | null; agent_id: string | null
        comment: string; comment_type: string; created_at: string
      }

      // Broadcast to all agents of same owner
      broadcastToOwner(agent.apiKeyOwner, {
        type: 'task.comment',
        taskId,
        comment: created,
        timestamp: new Date().toISOString(),
      })
      break
    }

    case 'message': {
      // Agent-to-agent messaging (same owner only)
      const targetId = msg['to'] as string | undefined
      if (!targetId) break
      const target = getByAgent(targetId)
      if (target && target.apiKeyOwner === agent.apiKeyOwner) {
        sendTo(targetId, {
          type: 'message',
          from: agent.agentId,
          content: msg['content'],
          timestamp: new Date().toISOString(),
        })
      }
      break
    }
  }
}

/** Named connections only: a socket under a placeholder has not said who it is yet. */
function namedConnections(): WorkerConn[] {
  return listConnections().filter((c) => !isPlaceholderAgentId(c.agentId))
}

function getOnlineAgents(owner: string) {
  return namedConnections()
    .filter((c) => c.apiKeyOwner === owner)
    .map((c) => ({
      agentId: c.agentId,
      hostname: c.hostname || undefined,
      ide: c.ide ?? undefined,
      capabilities: c.capabilities,
      platform: c.platform ?? undefined,
    }))
}

/**
 * Get ALL connected agents with capabilities (for dashboard API and orchestrator).
 * `currentTaskId` and `quota` (the live rows for the worker's host) come from the DB.
 */
export function getAllConnectedAgents(): WorkerView[] {
  const conns = namedConnections()
  if (conns.length === 0) return []
  const quota = db.prepare(
    'SELECT host, executor, model, exhausted_until, reason FROM conductor_quota WHERE exhausted_until > ? ORDER BY executor, model',
  ).all(isoSeconds()) as { host: string; executor: string; model: string; exhausted_until: string; reason: string | null }[]
  const currentTask = db.prepare(
    `SELECT id FROM conductor_tasks WHERE assigned_to_agent = ? AND status IN (${ACTIVE_IN}) ORDER BY assigned_at DESC LIMIT 1`,
  )
  return conns.map((c) => ({
    agentId: c.agentId,
    apiKeyOwner: c.apiKeyOwner,
    hostname: c.hostname || undefined,
    ide: c.ide ?? undefined,
    platform: c.platform ?? undefined,
    capabilities: c.capabilities,
    status: c.status,
    connectedAt: c.connectedAt,
    lastPing: c.lastPing,
    connectionId: c.connectionId,
    os: c.os,
    version: c.version,
    projectId: c.projectId,
    engines: c.engines,
    defaultExecutor: c.defaultExecutor,
    currentTaskId: (currentTask.get(c.agentId, ...ACTIVE_STATUSES) as { id: string } | undefined)?.id ?? null,
    quota: quota
      .filter((q) => q.host === c.hostname)
      // quota rows are written from validated quota messages only
      .map((q) => ({ executor: q.executor as Executor, model: q.model, exhaustedUntil: q.exhausted_until, reason: q.reason })),
  }))
}

function pinTask(taskId: string, agentId: string): void {
  db.prepare('UPDATE conductor_tasks SET pinned_agent = ? WHERE id = ?').run(agentId, taskId)
  logTask(taskId, agentId, 'pinned', `pinned to ${agentId}`)
}

/**
 * Kept for the routes that still assign directly. A task the dispatcher owns
 * (`pending`, or a legacy `assigned` row without a lease) is pinned to the
 * agent and dispatched, so it is pushed once and with a lease; the answer is
 * whether it ended up assigned to that agent. A `blocked` task is only
 * pinned (false): the dispatcher sends it once it unblocks. Any other task
 * (the strategy flow, `synthesis`) gets the flat legacy `task.assigned`; the
 * answer is whether it was delivered.
 */
export function pushTaskToAgent(
  assignedTo: string,
  taskId: string,
  title: string,
  description: string,
): boolean {
  const task = getTask(taskId)
  if (task?.status === 'blocked') {
    pinTask(taskId, assignedTo)
    return false
  }
  const dispatchable = task !== undefined
    && (task.status === 'pending' || (task.status === 'assigned' && task.lease_expires_at === null))
  if (!dispatchable) {
    return sendTo(assignedTo, { type: 'task.assigned', taskId, title, description, timestamp: new Date().toISOString() })
  }
  // pinned first, so that the dispatch pass returnTask runs already respects it
  pinTask(taskId, assignedTo)
  if (task.status === 'assigned') returnTask(taskId, `pinned to ${assignedTo}, handed to the dispatcher`)
  else dispatch()
  const after = getTask(taskId)
  return after?.status === 'assigned' && after.assigned_to_agent === assignedTo
}

/** Notify specific agents about a task event via WebSocket */
export function notifyAgents(
  agentIds: string[],
  message: Record<string, unknown>,
): string[] {
  return agentIds.filter((agentId) => sendTo(agentId, message))
}

/** Broadcast strategy ready event to all connected agents (the dashboard picks it up) */
export function broadcastStrategyReady(taskId: string, title: string, strategy: unknown): void {
  broadcastAll({
    type: 'task.strategy_ready',
    taskId,
    title,
    strategy,
    timestamp: new Date().toISOString(),
  })
}

/** Broadcast a new comment to all connected agents (for real-time updates) */
export function broadcastComment(taskId: string, comment: {
  id: number; task_id: string; finding_id: string | null; agent_id: string | null
  comment: string; comment_type: string; created_at: string
}): void {
  broadcastAll({
    type: 'task.comment',
    taskId,
    comment,
    timestamp: new Date().toISOString(),
  })
}

/** Mark an agent as busy/idle */
export function setAgentStatus(agentId: string, status: 'idle' | 'busy'): void {
  setStatus(agentId, status)
}
