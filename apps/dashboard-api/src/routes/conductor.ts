import { Hono, type Context } from 'hono'
import { randomUUID } from 'crypto'
import type {
  ClosedSessionView, ReviewRequest, RoutePatch, RouteSpec, SessionView, TaskResult, TreeCreateRequest,
} from '@cortex/shared-types'
import { db } from '../db/client.js'
import { getAllConnectedAgents, notifyAgents } from '../ws/conductor.js'
import { dispatch, pickForPull, servesProject } from '../conductor/dispatcher.js'
import { normalizeFiles } from '../conductor/files.js'
import {
  acceptTask, cancelTask, completeTask, onCompleted, recordProgress, rerouteTask, reviewTask, revokeTask, type Outcome,
} from '../conductor/lifecycle.js'
import { getByAgent } from '../conductor/registry.js'
import {
  ACTIVE_STATUSES, HAS_DEPENDENTS, dependentsOf, getTask, logTask, missingTasks, parseJson, stringList, taskContext,
  toTaskResult, type TaskRow,
} from '../conductor/rows.js'
import { createTree, fallbackProblem, knownExecutor, priorityValue, stringListProblem } from '../conductor/tree.js'

export const conductorRouter = new Hono()

const MESSAGE_MAX = 4000
const SESSION_LIMIT = 50
const LIST_LIMIT = 50
const LIST_LIMIT_MAX = 1000
const KINDS = ['work', 'gate', 'group'] as const

// ── Helpers ──

/** Generate a task ID */
function generateTaskId(): string {
  return `task_${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

/** The JSON body when it is an object; null when it is missing, malformed or anything else. */
async function readObject(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json()
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The calling API key's owner, set by hub-mcp; absent for dashboard calls. */
function headerOwner(c: Context): string | undefined {
  return c.req.header('X-API-Key-Owner') || undefined
}

/** A lifecycle refusal as its HTTP answer. */
function refusal(c: Context, r: { status: 400 | 403 | 404 | 409; error: string; cycle?: string[] }) {
  return c.json(r.cycle === undefined ? { error: r.error } : { error: r.error, cycle: r.cycle }, r.status)
}

/**
 * The `count` most recently active task trees, each whole: a top-level task (or one whose parent
 * is gone) and everything below it. Paging plain rows cuts a big tree's root off, and its subtasks
 * then show up as unrelated top-level tasks. Rows come root by root, parents before children, so a
 * `limit` that cuts the last tree short never leaves a child without its parent.
 */
function listTrees(count: number, limit: number, projectId: string | undefined): TaskRow[] {
  return db.prepare(`WITH RECURSIVE tree(id, root, depth) AS (
      SELECT id, id, 0 FROM conductor_tasks
      WHERE (parent_task_id IS NULL OR parent_task_id NOT IN (SELECT id FROM conductor_tasks))
        AND (? IS NULL OR project_id = ?)
      UNION ALL
      SELECT t.id, tree.root, tree.depth + 1 FROM conductor_tasks t JOIN tree ON t.parent_task_id = tree.id
      WHERE tree.depth < 64
    ),
    ranked AS (
      SELECT tree.root, MAX(MAX(t.created_at, COALESCE(t.assigned_at, ''), COALESCE(t.accepted_at, ''),
        COALESCE(t.completed_at, ''))) AS active
      FROM tree JOIN conductor_tasks t ON t.id = tree.id
      GROUP BY tree.root ORDER BY active DESC LIMIT ?
    )
    SELECT t.* FROM tree JOIN ranked r ON r.root = tree.root JOIN conductor_tasks t ON t.id = tree.id
    ORDER BY r.active DESC, tree.root, tree.depth, t.created_at
    LIMIT ?`).all(projectId ?? null, projectId ?? null, count, limit) as TaskRow[]
}

function isActiveStatus(status: string): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(status)
}

/** Active sessions, the most recently active first. */
function activeSessions(): SessionView[] {
  return db.prepare(`
    SELECT id AS sessionId, from_agent AS agentId, hostname, ide, branch, project_id AS projectId,
           api_key_name AS apiKeyName, COALESCE(last_activity, created_at) AS lastActivity
    FROM session_handoffs
    WHERE status = 'active'
    ORDER BY lastActivity DESC
    LIMIT ?
  `).all(SESSION_LIMIT) as SessionView[]
}

/** Closed sessions, the most recently active first. */
function closedSessions(): ClosedSessionView[] {
  return db.prepare(`
    SELECT id AS sessionId, from_agent AS agentId, hostname, ide, branch, project_id AS projectId,
           api_key_name AS apiKeyName, COALESCE(last_activity, created_at) AS lastActivity, status
    FROM session_handoffs
    WHERE status IN ('completed', 'abandoned', 'expired')
    ORDER BY lastActivity DESC
    LIMIT ?
  `).all(SESSION_LIMIT) as ClosedSessionView[]
}

function allCompleted(ids: string[]): boolean {
  if (ids.length === 0) return true
  const placeholders = ids.map(() => '?').join(',')
  const done = db.prepare(
    `SELECT COUNT(*) as cnt FROM conductor_tasks WHERE id IN (${placeholders}) AND status = 'completed'`
  ).get(...ids) as { cnt: number }
  return done.cnt === ids.length
}

// ── Connected agents (real-time from WebSocket) and active sessions ──
conductorRouter.get('/agents', (c) => {
  try {
    const connected = getAllConnectedAgents()
    return c.json({
      agents: connected,
      online: connected.length,
      sessions: activeSessions(),
      closedSessions: closedSessions(),
    })
  } catch (error) {
    return c.json({ agents: [], online: 0, sessions: [], closedSessions: [], error: String(error) }, 500)
  }
})

// ── Agent capabilities (for orchestrator) ──
conductorRouter.get('/agents/capabilities', (c) => {
  try {
    const connected = getAllConnectedAgents()
    const agents = connected.map((a) => ({
      agentId: a.agentId,
      capabilities: a.capabilities,
      platform: a.platform ?? 'unknown',
      status: a.status,
      hostname: a.hostname,
      ide: a.ide,
    }))
    return c.json({ agents })
  } catch (error) {
    return c.json({ agents: [], error: String(error) }, 500)
  }
})

// ── Auto-assign task by capability ──
// Only a pending task is routed: when one connected agent has every capability
// the dispatcher assigns it; otherwise it is split into subtasks pinned to the
// agents that together cover them. Assignment itself is always the dispatcher's.
conductorRouter.post('/auto-assign', async (c) => {
  try {
    const body = await readObject(c)
    if (body === null) return c.json({ error: 'a JSON object body is required' }, 400)
    const { taskId, requiredCapabilities } = body
    if (typeof taskId !== 'string' || taskId === '') return c.json({ error: 'taskId is required' }, 400)
    const capsProblem = stringListProblem('requiredCapabilities', requiredCapabilities)
    if (capsProblem !== null) return c.json({ error: capsProblem }, 400)
    const given = requiredCapabilities as string[] | undefined

    const task = getTask(taskId)
    if (!task) return c.json({ error: 'Task not found' }, 404)

    if (isActiveStatus(task.status)) {
      return c.json({ task, assigned: true, agentId: task.assigned_to_agent })
    }
    if (task.status !== 'pending' && task.status !== 'blocked') {
      return c.json({ error: `Cannot auto-assign a task in status '${task.status}'` }, 409)
    }
    if (given !== undefined) {
      db.prepare('UPDATE conductor_tasks SET required_capabilities = ? WHERE id = ?').run(JSON.stringify(given), taskId)
    }
    // a blocked task is dispatched once its dependencies complete
    if (task.status === 'blocked') return c.json({ task: getTask(taskId), assigned: false })

    const caps = given ?? stringList(task.required_capabilities)
    const connected = getAllConnectedAgents()
    if (connected.length === 0) {
      return c.json({ error: 'No agents online', assigned: false }, 200)
    }

    if (connected.some((agent) => caps.every((req) => agent.capabilities.includes(req)))) {
      dispatch()
      const routed = getTask(taskId) ?? task
      return isActiveStatus(routed.status)
        ? c.json({ task: routed, assigned: true, agentId: routed.assigned_to_agent })
        : c.json({ task: routed, assigned: false })
    }

    // ── Delegation: no single agent has ALL capabilities → split into subtasks ──
    // Find which capabilities each agent CAN cover
    const capCoverage = new Map<string, { agentId: string; caps: string[]; score: number }>()
    for (const agent of connected) {
      const matching = caps.filter((req) => agent.capabilities.includes(req))
      if (matching.length > 0) {
        capCoverage.set(agent.agentId, {
          agentId: agent.agentId,
          caps: matching,
          score: matching.length + (agent.status === 'idle' ? 1 : 0),
        })
      }
    }

    if (capCoverage.size === 0) {
      return c.json({
        error: 'No agents match any required capabilities',
        assigned: false,
        requiredCapabilities: caps,
      }, 200)
    }

    // Greedy: assign capabilities to best-scoring agents until all covered
    const uncovered = new Set(caps)
    const delegation: { agentId: string; caps: string[] }[] = []
    const sortedAgents = [...capCoverage.values()].sort((a, b) => b.score - a.score)

    for (const agent of sortedAgents) {
      if (uncovered.size === 0) break
      const covers = agent.caps.filter((cap) => uncovered.has(cap))
      if (covers.length > 0) {
        delegation.push({ agentId: agent.agentId, caps: covers })
        covers.forEach((cap) => uncovered.delete(cap))
      }
    }

    if (uncovered.size > 0) {
      return c.json({
        error: `Cannot cover all capabilities. Missing: ${[...uncovered].join(', ')}`,
        assigned: false,
        delegation: delegation.length > 0 ? delegation : undefined,
        requiredCapabilities: caps,
      }, 200)
    }

    // The parent becomes a group that completes with its subtasks; each subtask
    // is pinned to its delegate and left to the dispatcher.
    const subtaskIds = db.transaction((): string[] => {
      const insert = db.prepare(`
        INSERT INTO conductor_tasks
          (id, title, description, priority, pinned_agent, created_by_agent,
           project_id, parent_task_id, required_capabilities, api_key_owner, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
      `)
      const created: string[] = []
      for (const del of delegation) {
        const subId = generateTaskId()
        insert.run(
          subId,
          `[Delegated] ${task.title} — ${del.caps.join(', ')}`,
          `Subtask delegated from ${taskId}. Required capabilities: ${del.caps.join(', ')}`,
          task.priority,
          del.agentId,
          'orchestrator',
          task.project_id,
          taskId,
          JSON.stringify(del.caps),
          task.api_key_owner,
        )
        logTask(subId, del.agentId, 'delegated', `Delegated capabilities: ${del.caps.join(', ')}`)
        created.push(subId)
      }
      db.prepare("UPDATE conductor_tasks SET kind = 'group', status = 'pending', context = ? WHERE id = ?")
        .run(JSON.stringify({ ...taskContext(task), delegatedTo: delegation, subtaskIds: created }), taskId)
      logTask(taskId, null, 'delegated', `Split into ${delegation.length} subtasks across ${delegation.map((d) => d.agentId).join(', ')}`)
      return created
    })()
    dispatch()

    return c.json({
      task: getTask(taskId),
      assigned: false,
      delegated: true,
      delegation,
      subtaskIds,
    })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── List tasks ──
conductorRouter.get('/', (c) => {
  try {
    const root = c.req.query('root')
    // a subtree is answered whole (up to the cap); a plain list pages by default
    let limit = root ? LIST_LIMIT_MAX : LIST_LIMIT
    const rawLimit = c.req.query('limit')
    if (rawLimit !== undefined) {
      const n = Number(rawLimit)
      if (!Number.isInteger(n) || n < 1) return c.json({ error: 'limit must be a positive integer' }, 400)
      limit = Math.min(n, LIST_LIMIT_MAX)
    }
    const status = c.req.query('status')
    const assignedTo = c.req.query('assigned_to')
    const parentTaskId = c.req.query('parent_task_id')
    const projectId = c.req.query('projectId')

    const rawTrees = c.req.query('trees')
    if (rawTrees !== undefined) {
      const n = Number(rawTrees)
      if (!Number.isInteger(n) || n < 1) return c.json({ error: 'trees must be a positive integer' }, 400)
      if (root || status || assignedTo || parentTaskId) {
        return c.json({ error: 'trees only combines with projectId and limit' }, 400)
      }
      return c.json({ tasks: listTrees(Math.min(n, LIST_LIMIT_MAX), rawLimit === undefined ? LIST_LIMIT_MAX : limit, projectId) })
    }

    let query = 'SELECT * FROM conductor_tasks'
    const conditions: string[] = []
    const params: (string | number)[] = []

    if (root) {
      // the root and everything below it
      query = `WITH RECURSIVE subtree(id) AS (
        SELECT ? UNION SELECT t.id FROM conductor_tasks t JOIN subtree s ON t.parent_task_id = s.id
      ) ${query}`
      params.push(root)
      conditions.push('id IN (SELECT id FROM subtree)')
    }
    if (status) {
      conditions.push('status = ?')
      params.push(status)
    }
    if (assignedTo) {
      conditions.push('(assigned_to_agent = ? OR assigned_to_agent IS NULL)')
      params.push(assignedTo)
    }
    if (projectId) {
      conditions.push('project_id = ?')
      params.push(projectId)
    }
    if (parentTaskId === 'none') {
      conditions.push('parent_task_id IS NULL')
    } else if (parentTaskId) {
      conditions.push('parent_task_id = ?')
      params.push(parentTaskId)
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ')
    }
    query += ' ORDER BY priority ASC, created_at DESC LIMIT ?'
    params.push(limit)

    const tasks = db.prepare(query).all(...params) as TaskRow[]
    return c.json({ tasks })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Plan tree: create (keys, groups, gates, dependencies) ──
conductorRouter.post('/tree', async (c) => {
  try {
    const body = await readObject(c)
    if (body === null) return c.json({ error: 'a JSON object body is required' }, 400)
    for (const field of ['parentId', 'projectId'] as const) {
      if (body[field] !== undefined && typeof body[field] !== 'string') {
        return c.json({ error: `${field} must be a string` }, 400)
      }
    }
    // createTree validates the tasks themselves
    const created = createTree(body as unknown as TreeCreateRequest, headerOwner(c) ?? null)
    if (!created.ok) return c.json(created.err, 400)
    return c.json(created.res, 201)
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Plan tree: a task, its descendants and the workers that can serve it ──
conductorRouter.get('/:id/tree', (c) => {
  try {
    const id = c.req.param('id')
    const root = getTask(id)
    if (!root) return c.json({ error: 'Task not found' }, 404)

    const tasks = db.prepare(`
      WITH RECURSIVE subtree(id) AS (
        SELECT id FROM conductor_tasks WHERE parent_task_id = ?
        UNION SELECT t.id FROM conductor_tasks t JOIN subtree s ON t.parent_task_id = s.id
      )
      SELECT * FROM conductor_tasks WHERE id IN (SELECT id FROM subtree) ORDER BY created_at ASC, rowid ASC
    `).all(id) as TaskRow[]
    // the workers the dispatcher would give the root's project to
    const workers = getAllConnectedAgents().filter((w) => {
      const conn = getByAgent(w.agentId)
      return conn !== undefined && servesProject(conn, { projectId: root.project_id })
    })

    return c.json({ root, tasks, workers })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── A task's log, for a live view: the rows after `after` (by id), oldest first ──
// Without `after`, the newest LOGS_PAGE rows. `now` is the hub's clock, for "N min ago".
const LOGS_PAGE = 200
conductorRouter.get('/:id/logs', (c) => {
  try {
    const id = c.req.param('id')
    if (!getTask(id)) return c.json({ error: 'Task not found' }, 404)
    const afterParam = c.req.query('after')
    const after = afterParam !== undefined && /^\d{1,15}$/.test(afterParam) ? Number(afterParam) : null
    type LogRow = { id: number; task_id: string; agent_id: string | null; action: string; message: string | null; created_at: string }
    const logs = after === null
      ? (db.prepare('SELECT * FROM conductor_task_logs WHERE task_id = ? ORDER BY id DESC LIMIT ?').all(id, LOGS_PAGE) as LogRow[]).reverse()
      : db.prepare('SELECT * FROM conductor_task_logs WHERE task_id = ? AND id > ? ORDER BY id ASC LIMIT ?').all(id, after, LOGS_PAGE) as LogRow[]
    return c.json({ logs, now: new Date().toISOString() })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Get single task ──
conductorRouter.get('/:id', (c) => {
  try {
    const id = c.req.param('id')
    // Avoid matching route keywords
    if (id === 'agents' || id === 'auto-assign') return c.notFound()

    const task = getTask(id)
    if (!task) return c.json({ error: 'Task not found' }, 404)

    // Include subtasks if this task has children
    const subtasks = db.prepare(
      'SELECT * FROM conductor_tasks WHERE parent_task_id = ? ORDER BY priority ASC, created_at ASC'
    ).all(id) as TaskRow[]

    // Include recent progress logs
    const logs = db.prepare(
      'SELECT * FROM conductor_task_logs WHERE task_id = ? ORDER BY id DESC LIMIT 30'
    ).all(id) as { id: number; task_id: string; agent_id: string | null; action: string; message: string | null; created_at: string }[]

    return c.json({
      task,
      subtasks: subtasks.length > 0 ? subtasks : undefined,
      logs: logs.reverse(),
    })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

interface CreateBody {
  title?: string
  description?: string
  priority?: number | string
  /** Pins the task to that agent; `assignTo` is accepted as an alias. */
  assignedTo?: string
  assignTo?: string
  projectId?: string
  metadata?: Record<string, unknown>
  parentTaskId?: string
  dependsOn?: string[]
  notifyOnComplete?: string[]
  requiredCapabilities?: string[]
  // Identity fields for auto-setting created_by_agent
  agentId?: string
  apiKeyOwner?: string
  sessionAgent?: string
  executor?: string | null
  model?: string
  effort?: string
  fallback?: RouteSpec[] | null
  files?: string[]
  branch?: string
  reviewRequired?: boolean
  kind?: string
}

/** The first problem with a create request, or null. */
function createProblem(b: CreateBody): string | null {
  if (typeof b.title !== 'string' || b.title === '') return 'Title is required'
  if (b.kind !== undefined && !(KINDS as readonly string[]).includes(b.kind)) return `unknown kind ${String(b.kind)}`
  if (priorityValue(b.priority) === null) return `unknown priority ${String(b.priority)}`
  if (b.executor !== undefined && b.executor !== null && !knownExecutor(b.executor)) return `unknown executor ${String(b.executor)}`
  const fallback = fallbackProblem(b.fallback)
  if (fallback !== null) return fallback
  for (const name of ['description', 'projectId', 'parentTaskId', 'model', 'effort', 'branch', 'assignedTo', 'assignTo'] as const) {
    if (b[name] !== undefined && typeof b[name] !== 'string') return `${name} must be a string`
  }
  if (b.metadata !== undefined && (typeof b.metadata !== 'object' || b.metadata === null || Array.isArray(b.metadata))) {
    return 'metadata must be an object'
  }
  if (b.reviewRequired !== undefined && typeof b.reviewRequired !== 'boolean') return 'reviewRequired must be a boolean'
  for (const name of ['dependsOn', 'files', 'requiredCapabilities', 'notifyOnComplete'] as const) {
    const bad = stringListProblem(name, b[name])
    if (bad !== null) return bad
  }
  return null
}

// ── Create task (with parent link, dependencies, notify_on_complete) ──
// An assignee is a pin: the dispatcher hands the task over when that agent is
// connected and idle.
conductorRouter.post('/', async (c) => {
  try {
    const body = await readObject(c)
    if (body === null) return c.json({ error: 'a JSON object body is required' }, 400)
    const b = body as CreateBody
    const header = headerOwner(c)

    const problem = createProblem(b)
    if (problem !== null) return c.json({ error: problem }, 400)
    let files: string[]
    try {
      files = normalizeFiles(b.files ?? [])
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
    const kind = b.kind ?? 'work'

    // Reassigned below when an agent's own active task becomes the parent.
    let parentTaskId = b.parentTaskId

    // Validate parent exists if specified
    if (parentTaskId) {
      const parent = db.prepare('SELECT id FROM conductor_tasks WHERE id = ?').get(parentTaskId)
      if (!parent) return c.json({ error: 'Parent task not found' }, 404)
    }

    // Validate dependency task IDs exist
    const deps = [...new Set(b.dependsOn ?? [])]
    if (missingTasks(deps).length > 0) {
      return c.json({ error: 'One or more dependency task IDs not found' }, 400)
    }

    const id = generateTaskId()
    const createdByAgent = b.agentId ?? b.apiKeyOwner ?? header ?? b.sessionAgent ?? 'dashboard'

    // Auto-link: if an agent creates a task without parentTaskId, link to their active task
    if (!parentTaskId && createdByAgent !== 'dashboard' && createdByAgent !== 'dashboard-ui') {
      const activeTask = db.prepare(
        "SELECT id FROM conductor_tasks WHERE assigned_to_agent = ? AND status IN ('accepted', 'in_progress') ORDER BY accepted_at DESC LIMIT 1"
      ).get(createdByAgent) as { id: string } | undefined
      if (activeTask) {
        parentTaskId = activeTask.id
      }
    }

    // 'blocked' until every dependency completes; a group waits through its tasks instead
    const initialStatus = kind !== 'group' && !allCompleted(deps) ? 'blocked' : 'pending'

    db.prepare(`
      INSERT INTO conductor_tasks
        (id, title, description, priority, pinned_agent, created_by_agent,
         project_id, context, parent_task_id, depends_on, notify_on_complete, required_capabilities, status,
         api_key_owner, kind, approver, executor, model, effort, fallback, files, branch, review_required)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      b.title,
      b.description ?? '',
      priorityValue(b.priority),
      b.assignedTo || b.assignTo || null,
      createdByAgent,
      b.projectId ?? null,
      b.metadata ? JSON.stringify(b.metadata) : '{}',
      parentTaskId ?? null,
      JSON.stringify(deps),
      JSON.stringify(b.notifyOnComplete ?? []),
      JSON.stringify(b.requiredCapabilities ?? []),
      initialStatus,
      header ?? null,
      kind,
      kind === 'gate' ? 'user' : null,
      b.executor ?? null,
      b.model ?? null,
      b.effort ?? null,
      b.fallback === undefined || b.fallback === null ? null : JSON.stringify(b.fallback),
      JSON.stringify(files),
      b.branch ?? null,
      b.reviewRequired ? 1 : 0,
    )

    logTask(id, createdByAgent, 'created', parentTaskId ? `Subtask of ${parentTaskId}` : undefined)
    dispatch()

    return c.json({ task: getTask(id) }, 201)
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Pickup task (pull mode: pinned to the caller, or open to anyone) ──
conductorRouter.post('/pickup', async (c) => {
  try {
    const body = (await readObject(c)) ?? {}
    const { agentId, apiKeyOwner = headerOwner(c), sessionAgent, projectId } = body as {
      agentId?: string
      apiKeyOwner?: string
      sessionAgent?: string
      projectId?: string | null
    }

    if (!agentId && !apiKeyOwner && !sessionAgent) {
      return c.json({ error: 'At least one identity field required (agentId, apiKeyOwner, or sessionAgent)' }, 400)
    }

    const task = pickForPull({
      agentId: agentId || undefined,
      apiKeyOwner: apiKeyOwner || undefined,
      sessionAgent: sessionAgent || undefined,
      projectId: typeof projectId === 'string' || projectId === null ? projectId : undefined,
    })
    if (!task) {
      return c.json({ task: null, message: 'No matching tasks available' })
    }
    return c.json({ task })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

interface UpdateBody {
  status?: string
  result?: unknown
  context?: Record<string, unknown>
  completedBy?: string
  reviewerAgent?: string
  message?: string
  parentTaskId?: string
}

/** Context merge and re-parenting, written after the status step. */
function applyFields(id: string, context: Record<string, unknown> | undefined, parentTaskId: string | undefined): void {
  if (context !== undefined) {
    const current = getTask(id)
    if (current) {
      db.prepare('UPDATE conductor_tasks SET context = ? WHERE id = ?')
        .run(JSON.stringify({ ...taskContext(current), ...context }), id)
    }
  }
  if (parentTaskId !== undefined) {
    db.prepare('UPDATE conductor_tasks SET parent_task_id = ? WHERE id = ?').run(parentTaskId || null, id)
  }
}

/** Fire-and-forget recipe capture (OpenSpace-inspired auto-learning). */
function captureRecipe(task: TaskRow): void {
  import('../services/recipe-capture.js').then(({ captureFromTask }) =>
    captureFromTask(task).catch(e => {
      console.warn('[recipe-capture] Task capture error:', (e as Error).message)
      try {
        db.prepare(
          `INSERT INTO recipe_capture_log (source, source_id, agent_id, project_id, status, error_message, created_at)
           VALUES ('task', ?, ?, ?, 'error', ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`
        ).run(task.id, task.assigned_to_agent ?? null, task.project_id ?? null, (e as Error).message?.slice(0, 500))
      } catch { /* ignore */ }
    })
  ).catch((e) => {
    console.warn('[recipe-capture] Module load error:', (e as Error).message)
    try {
      db.prepare(
        `INSERT INTO recipe_capture_log (source, source_id, status, error_message, created_at)
         VALUES ('task', ?, 'error', ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`
      ).run(task.id, `Module load: ${(e as Error).message}`.slice(0, 500))
    } catch { /* ignore */ }
  })
}

/** The legacy notices after a lifecycle step: review requests and approvals to the reviewer and the parent's creator. */
function notifyAfter(status: string, before: TaskRow, after: TaskRow, reviewerAgent: string | undefined): void {
  const parent = before.parent_task_id ? getTask(before.parent_task_id) : undefined
  const timestamp = new Date().toISOString()
  if (after.status === 'review') {
    const msg = { type: 'task.review_requested', taskId: after.id, title: before.title, submittedBy: before.assigned_to_agent, timestamp }
    if (reviewerAgent) notifyAgents([reviewerAgent], msg)
    if (parent?.created_by_agent) notifyAgents([parent.created_by_agent], { ...msg, parentTaskId: parent.id })
  }
  if (status === 'approved' && after.status === 'completed' && parent?.created_by_agent) {
    notifyAgents([parent.created_by_agent], {
      type: 'task.approved', taskId: after.id, title: before.title, parentTaskId: parent.id, timestamp,
    })
  }
}

/** A stored result column as a TaskResult, read with the same rule as a REST `result`. */
function storedResult(raw: string | null): TaskResult {
  return toTaskResult(raw === null || raw === '' ? undefined : parseJson<unknown>(raw, raw))
}

/** Marks a task taken without a live worker, so the scheduler does not reclaim it as offline. */
function markPull(id: string): void {
  const current = getTask(id)
  if (current) {
    db.prepare('UPDATE conductor_tasks SET context = ? WHERE id = ?').run(JSON.stringify({ ...taskContext(current), pull: true }), id)
  }
}

/**
 * PUT accepted/in_progress. A task held by an assignee is accepted when still
 * `assigned`, and `in_progress` then records progress (moving it on and
 * extending the lease); `accepted` on a task already accepted or running
 * changes nothing. A pending task is claimed for the calling key owner through
 * pull mode, restricted to that task. Anything else is a 409.
 */
function acceptOrProgress(
  existing: TaskRow, status: 'accepted' | 'in_progress', note: string | undefined, header: string | undefined,
): { outcome: Outcome; noted: boolean } {
  const id = existing.id
  const held = existing.assigned_to_agent
  let agent: string
  let outcome: Outcome
  let changed: boolean
  if (held && (existing.status === 'assigned' || existing.status === 'accepted' || existing.status === 'in_progress')) {
    agent = held
    changed = existing.status === 'assigned'
    outcome = changed ? acceptTask(id, agent) : { ok: true, task: existing }
  } else if (existing.status === 'pending') {
    if (header === undefined) {
      return { outcome: { ok: false, status: 409, error: 'claiming a pending task needs the X-API-Key-Owner header' }, noted: false }
    }
    const picked = pickForPull({ apiKeyOwner: header, taskId: id })
    if (picked === null) {
      return {
        outcome: {
          ok: false, status: 409,
          error: `${header} cannot claim this task: it is pinned elsewhere, routed by executor or capabilities, waiting on dependencies or files, or was declined`,
        },
        noted: false,
      }
    }
    agent = picked.assigned_to_agent ?? header
    changed = true
    outcome = { ok: true, task: picked }
  } else {
    return { outcome: { ok: false, status: 409, error: `cannot move a ${existing.status} task to ${status}` }, noted: false }
  }
  if (!outcome.ok) return { outcome, noted: false }

  let noted = false
  if (status === 'in_progress') {
    outcome = recordProgress(id, agent, note ?? 'started')
    noted = true
    changed = true
  }
  if (outcome.ok && changed && getByAgent(agent) === undefined) markPull(id)
  return { outcome, noted }
}

// ── Update task ──
// Status changes the lifecycle owns go through it: approved/rejected → review,
// review/completed/failed → completion, cancelled → cancel, accepted/in_progress
// → accept, claim and progress. pending/assigned/blocked belong to the
// dispatcher (409). Any other status is written as given. `message` is always
// logged.
conductorRouter.put('/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await readObject(c)
    if (body === null) return c.json({ error: 'a JSON object body is required' }, 400)
    const { status, result, context, completedBy, reviewerAgent, message, parentTaskId } = body as UpdateBody
    if (context !== undefined && (typeof context !== 'object' || context === null || Array.isArray(context))) {
      return c.json({ error: 'context must be an object' }, 400)
    }
    if (completedBy !== undefined && typeof completedBy !== 'string') {
      return c.json({ error: 'completedBy must be a string' }, 400)
    }

    const existing = getTask(id)
    if (!existing) return c.json({ error: 'Task not found' }, 404)

    // Block agents from completing/progressing a task that awaits user strategy approval
    if (existing.status === 'strategy_review' && status && status !== 'strategy_review') {
      return c.json({ error: 'Task is awaiting strategy approval — only the dashboard can change its status' }, 403)
    }

    const note = typeof message === 'string' && message !== '' ? message.slice(0, MESSAGE_MAX) : undefined
    const header = headerOwner(c)
    let outcome: Outcome | null = null
    // whether the lifecycle step already logged the message (as feedback or progress)
    let noted = false

    if (status === 'pending' || status === 'assigned' || status === 'blocked') {
      return c.json({ error: `status ${status} is not set through PUT: use /assign, /route or the dispatcher` }, 409)
    }
    if (status === 'approved' || status === 'rejected') {
      if (status === 'rejected' && note === undefined) {
        return c.json({ error: 'a rejection needs the feedback in message' }, 400)
      }
      const req: ReviewRequest = { verdict: status === 'approved' ? 'approve' : 'reject' }
      if (note !== undefined) req.feedback = note
      const by = completedBy ?? header
      if (by) req.by = by
      outcome = reviewTask(id, req, header ? 'mcp' : 'dashboard')
      noted = note !== undefined
    } else if (status === 'review' || status === 'completed' || status === 'failed') {
      // without a result the stored one stands, so marking work done keeps the worker's summary
      outcome = completeTask(id, null, status, result === undefined ? storedResult(existing.result) : toTaskResult(result))
      const by = completedBy ?? header
      if (outcome.ok && status === 'completed' && outcome.task.status === 'completed' && by !== undefined) {
        db.prepare('UPDATE conductor_tasks SET completed_by = ? WHERE id = ?').run(by, id)
      }
    } else if (status === 'cancelled') {
      outcome = cancelTask(id, header ?? 'dashboard')
    } else if (status === 'accepted' || status === 'in_progress') {
      const step = acceptOrProgress(existing, status, note, header)
      outcome = step.outcome
      noted = step.noted
    }

    if (outcome !== null) {
      if (!outcome.ok) return refusal(c, outcome)
      applyFields(id, context, parentTaskId)
      if (note !== undefined && !noted) logTask(id, completedBy ?? existing.assigned_to_agent ?? header ?? null, 'message', note)
      const task = getTask(id) ?? outcome.task
      notifyAfter(status ?? '', existing, task, reviewerAgent)
      if (status === 'completed' && task.status === 'completed' && task.result) captureRecipe(task)
      return c.json({ task })
    }

    // ── Any other status (the strategy flow and the like), or none: written as given ──
    const updates: string[] = []
    const params: (string | number | null)[] = []

    if (status !== undefined) {
      updates.push('status = ?')
      params.push(status)
    }
    if (result !== undefined) {
      updates.push('result = ?')
      params.push(typeof result === 'string' ? result : JSON.stringify(result))
    }
    if (completedBy !== undefined) {
      updates.push('completed_by = ?')
      params.push(completedBy)
    }
    if (context !== undefined) {
      updates.push('context = ?')
      params.push(JSON.stringify({ ...taskContext(existing), ...context }))
    }

    // Allow re-parenting tasks (fix orphans)
    if (parentTaskId !== undefined) {
      updates.push('parent_task_id = ?')
      params.push(parentTaskId || null)
    }

    if (updates.length > 0) {
      params.push(id)
      db.prepare(`UPDATE conductor_tasks SET ${updates.join(', ')} WHERE id = ?`).run(...params)
    }
    if (note !== undefined) logTask(id, completedBy ?? existing.assigned_to_agent, 'message', note)

    return c.json({ task: getTask(id) })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Review: the lead's verdict on work in review, or on a gate ──
conductorRouter.post('/:id/review', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await readObject(c)
    if (body === null) return c.json({ error: 'a JSON object body is required' }, 400)
    const { verdict, feedback, by } = body
    if (verdict !== 'approve' && verdict !== 'reject') return c.json({ error: "verdict must be 'approve' or 'reject'" }, 400)
    if (feedback !== undefined && typeof feedback !== 'string') return c.json({ error: 'feedback must be a string' }, 400)
    if (by !== undefined && typeof by !== 'string') return c.json({ error: 'by must be a string' }, 400)

    const header = headerOwner(c)
    const req: ReviewRequest = { verdict }
    if (feedback !== undefined) req.feedback = feedback
    const reviewer = by ?? header
    if (reviewer !== undefined) req.by = reviewer

    const outcome = reviewTask(id, req, header ? 'mcp' : 'dashboard')
    if (!outcome.ok) return refusal(c, outcome)
    return c.json({ task: outcome.task })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Route: change a task's executor, model, priority, files or dependencies ──
conductorRouter.post('/:id/route', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await readObject(c)
    if (body === null) return c.json({ error: 'a JSON object body is required' }, 400)
    // rerouteTask validates the patch before writing
    const outcome = rerouteTask(id, body as RoutePatch, headerOwner(c) ?? 'dashboard')
    if (!outcome.ok) return refusal(c, outcome)
    return c.json({ task: outcome.task })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Submit strategy (Lead Agent submits after analysis) ──
conductorRouter.put('/:id/strategy', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req.json()
    const { strategy } = body as {
      strategy: {
        summary: string
        roles: Array<{ role: string; label: string; agent: string; rationale: string; capabilities?: string[] }>
        subtasks: Array<{ title: string; description?: string; role: string; dependsOn?: string[]; priority?: number }>
        estimatedEffort?: string
      }
    }

    if (!strategy?.summary || !Array.isArray(strategy.roles) || !Array.isArray(strategy.subtasks)) {
      return c.json({ error: 'Invalid strategy: requires summary, roles[], and subtasks[]' }, 400)
    }

    const existing = getTask(id)
    if (!existing) return c.json({ error: 'Task not found' }, 404)

    // Save strategy into context and set status to strategy_review
    const existingCtx = parseJson<Record<string, unknown>>(existing.context, {})
    const updatedCtx = { ...existingCtx, strategy, phase: 'strategy_review' }

    db.prepare(`
      UPDATE conductor_tasks
      SET status = 'strategy_review', context = ?
      WHERE id = ?
    `).run(JSON.stringify(updatedCtx), id)

    logTask(id, existing.assigned_to_agent, 'strategy_submitted',
      `Strategy: ${strategy.roles.length} roles, ${strategy.subtasks.length} subtasks`)

    // Broadcast to dashboard via WS
    const { broadcastStrategyReady } = await import('../ws/conductor.js')
    broadcastStrategyReady(id, existing.title, strategy)

    return c.json({ task: getTask(id) })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Approve strategy (user approves from dashboard) ──
conductorRouter.post('/:id/strategy/approve', async (c) => {
  try {
    const id = c.req.param('id')
    const existing = getTask(id)
    if (!existing) return c.json({ error: 'Task not found' }, 404)

    if (existing.status !== 'strategy_review') {
      return c.json({ error: `Cannot approve strategy: task status is '${existing.status}', expected 'strategy_review'` }, 400)
    }

    const existingCtx = parseJson<Record<string, unknown>>(existing.context, {})
    const updatedCtx = { ...existingCtx, phase: 'execution', strategyApprovedAt: new Date().toISOString() }

    db.prepare(`
      UPDATE conductor_tasks
      SET status = 'in_progress', context = ?
      WHERE id = ?
    `).run(JSON.stringify(updatedCtx), id)

    logTask(id, null, 'strategy_approved', 'Strategy approved by user')

    return c.json({ task: getTask(id) })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Cancel task (an active one is revoked from its worker first) ──
conductorRouter.post('/:id/cancel', async (c) => {
  try {
    const id = c.req.param('id')
    const body = (await readObject(c)) ?? {}
    const reason = typeof body.reason === 'string' && body.reason !== '' ? body.reason.slice(0, MESSAGE_MAX) : undefined
    const by = headerOwner(c) ?? 'dashboard'

    const outcome = cancelTask(id, by)
    if (!outcome.ok) return refusal(c, outcome)
    if (reason !== undefined) logTask(id, by, 'message', reason)

    return c.json({ success: true, id })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Comments: list ──
conductorRouter.get('/:id/comments', (c) => {
  try {
    const taskId = c.req.param('id')
    const task = db.prepare('SELECT id FROM conductor_tasks WHERE id = ?').get(taskId)
    if (!task) return c.json({ error: 'Task not found' }, 404)

    const comments = db.prepare(
      'SELECT * FROM conductor_comments WHERE task_id = ? ORDER BY created_at ASC'
    ).all(taskId) as {
      id: number; task_id: string; finding_id: string | null; agent_id: string | null
      comment: string; comment_type: string; created_at: string
    }[]

    return c.json({ comments })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Comments: submit ──
conductorRouter.post('/:id/comments', async (c) => {
  try {
    const taskId = c.req.param('id')
    const task = db.prepare('SELECT id FROM conductor_tasks WHERE id = ?').get(taskId)
    if (!task) return c.json({ error: 'Task not found' }, 404)

    const body = await c.req.json()
    const { comment, findingId, agentId, commentType = 'comment' } = body as {
      comment?: string
      findingId?: string
      agentId?: string
      commentType?: 'comment' | 'agree' | 'disagree' | 'amendment'
    }

    if (!comment) return c.json({ error: 'comment is required' }, 400)
    if (!['comment', 'agree', 'disagree', 'amendment'].includes(commentType)) {
      return c.json({ error: 'Invalid comment_type' }, 400)
    }

    const result = db.prepare(
      'INSERT INTO conductor_comments (task_id, finding_id, agent_id, comment, comment_type) VALUES (?, ?, ?, ?, ?)'
    ).run(taskId, findingId ?? null, agentId ?? 'dashboard', comment, commentType)

    const created = db.prepare('SELECT * FROM conductor_comments WHERE id = ?').get(result.lastInsertRowid) as {
      id: number; task_id: string; finding_id: string | null; agent_id: string | null
      comment: string; comment_type: string; created_at: string
    }

    // Broadcast via WS
    const { broadcastComment } = await import('../ws/conductor.js')
    broadcastComment(taskId, created)

    return c.json({ comment: created }, 201)
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Decision Matrix: update finding decision ──
conductorRouter.put('/:id/matrix/:findingId', async (c) => {
  try {
    const taskId = c.req.param('id')
    const findingId = c.req.param('findingId')

    const existing = getTask(taskId)
    if (!existing) return c.json({ error: 'Task not found' }, 404)

    const body = await c.req.json()
    const { status, reason } = body as { status: 'approved' | 'rejected'; reason?: string }

    if (status !== 'approved' && status !== 'rejected') {
      return c.json({ error: 'status must be "approved" or "rejected"' }, 400)
    }

    // Update context.decisions
    const ctx = parseJson<Record<string, unknown>>(existing.context, {})
    const decisions = (ctx['decisions'] ?? {}) as Record<string, { status: string; reason?: string; decidedAt: string }>
    decisions[findingId] = { status, reason, decidedAt: new Date().toISOString() }
    ctx['decisions'] = decisions

    db.prepare('UPDATE conductor_tasks SET context = ? WHERE id = ?').run(JSON.stringify(ctx), taskId)

    logTask(taskId, null, `finding_${status}`, `Finding ${findingId} ${status}${reason ? ': ' + reason : ''}`)

    return c.json({ success: true, findingId, status, decisions })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Decision Matrix: finalize task with approved findings only ──
conductorRouter.post('/:id/finalize', async (c) => {
  try {
    const taskId = c.req.param('id')

    const existing = getTask(taskId)
    if (!existing) return c.json({ error: 'Task not found' }, 404)

    const ctx = parseJson<Record<string, unknown>>(existing.context, {})
    const decisions = (ctx['decisions'] ?? {}) as Record<string, { status: string; reason?: string; decidedAt: string }>

    // Parse result to get findings
    const resultObj = parseJson<{ summary?: string; findings?: Array<{ id: string; [k: string]: unknown }> }>(existing.result, {})
    const allFindings = resultObj.findings ?? []

    // Filter to only approved findings
    const approvedFindings = allFindings.filter((f) => decisions[f.id]?.status === 'approved')
    const rejectedFindings = allFindings.filter((f) => decisions[f.id]?.status === 'rejected')

    const finalResult = {
      summary: resultObj.summary ?? '',
      findings: approvedFindings,
      finalized: true,
      totalFindings: allFindings.length,
      approvedCount: approvedFindings.length,
      rejectedCount: rejectedFindings.length,
      finalizedAt: new Date().toISOString(),
    }

    db.prepare(`
      UPDATE conductor_tasks
      SET result = ?, status = 'completed', completed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?
    `).run(JSON.stringify(finalResult), taskId)

    logTask(taskId, null, 'finalized',
      `Finalized with ${approvedFindings.length}/${allFindings.length} findings approved`)

    const updatedTask = getTask(taskId)
    if (updatedTask) onCompleted(updatedTask)

    return c.json({ task: updatedTask })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Delete task ──
// Refused while an unfinished task depends on it; an active task is revoked
// through the lifecycle first; its logs go with it.
conductorRouter.delete('/:id', (c) => {
  try {
    const id = c.req.param('id')
    const existing = getTask(id)
    if (!existing) return c.json({ error: 'Task not found' }, 404)
    const dependents = dependentsOf(id)
    if (dependents.length > 0) return c.json({ error: HAS_DEPENDENTS, dependents }, 409)

    if (isActiveStatus(existing.status)) revokeTask(id, 'deleted')
    db.prepare('DELETE FROM conductor_task_logs WHERE task_id = ?').run(id)
    db.prepare('DELETE FROM conductor_tasks WHERE id = ?').run(id)
    return c.json({ success: true, id })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})
