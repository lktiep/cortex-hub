import { Hono, type Context } from 'hono'
import { db } from '../db/client.js'
import type { ReviewRequest, RoutePatch } from '@cortex/shared-types'
import { dispatch } from '../conductor/dispatcher.js'
import {
  acceptTask, cancelTask, completeTask, recordProgress, rerouteTask, reviewTask, revokeTask, type Outcome,
} from '../conductor/lifecycle.js'
import { ACTIVE_STATUSES, getTask, logTask, parseJson, toTaskResult, type TaskRow } from '../conductor/rows.js'
import { priorityValue } from '../conductor/tree.js'

export const tasksRouter = new Hono()

function generateTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
}

const USE_ASSIGN = 'use /assign or the dispatcher'
const COMPLETING = ['completed', 'failed', 'review'] as const
type Completing = (typeof COMPLETING)[number]

function allCompleted(ids: string[]): boolean {
  if (ids.length === 0) return true
  const done = db.prepare(
    `SELECT COUNT(*) AS cnt FROM conductor_tasks WHERE id IN (${ids.map(() => '?').join(',')}) AND status = 'completed'`,
  ).get(...ids) as { cnt: number }
  return done.cnt === ids.length
}

/** A lifecycle refusal as its HTTP answer. */
function refusal(c: Context, r: { status: 400 | 403 | 404 | 409; error: string; cycle?: string[] }) {
  return c.json(r.cycle === undefined ? { error: r.error } : { error: r.error, cycle: r.cycle }, r.status)
}

function isActive(status: string): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(status)
}

/** The refusal for PATCH accepted/in_progress on a row that cannot take it, or null. */
function acceptRefusal(row: TaskRow): Outcome | null {
  return row.assigned_to_agent && isActive(row.status) ? null : { ok: false, status: 409, error: USE_ASSIGN }
}

/** PATCH accepted/in_progress: the assignee accepts (when `assigned`) and in_progress records progress. */
function acceptOrStart(row: TaskRow, status: 'accepted' | 'in_progress'): Outcome {
  const refused = acceptRefusal(row)
  if (refused) return refused
  const agent = row.assigned_to_agent as string // acceptRefusal ensured an assignee
  let outcome: Outcome = { ok: true, task: row }
  if (row.status === 'assigned') outcome = acceptTask(row.id, agent)
  if (outcome.ok && status === 'in_progress') outcome = recordProgress(row.id, agent, 'started')
  return outcome
}

// GET /api/tasks — list tasks with filters
tasksRouter.get('/', (c) => {
  try {
    const projectId = c.req.query('projectId')
    const status = c.req.query('status')
    const assignedTo = c.req.query('assignedTo')
    const parentId = c.req.query('parentId')
    const limit = Number(c.req.query('limit') || '50')

    const conditions: string[] = []
    const params: unknown[] = []

    if (projectId) {
      conditions.push('project_id = ?')
      params.push(projectId)
    }
    if (status) {
      conditions.push('status = ?')
      params.push(status)
    }
    if (assignedTo) {
      conditions.push('assigned_to_agent = ?')
      params.push(assignedTo)
    }
    if (parentId) {
      conditions.push('parent_task_id = ?')
      params.push(parentId)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const sql = `SELECT * FROM conductor_tasks ${where} ORDER BY created_at DESC LIMIT ?`
    params.push(limit)

    const tasks = db.prepare(sql).all(...params)
    return c.json({ tasks })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// POST /api/tasks — create task. An assignee is a pin: the dispatcher hands the
// task over when that agent is connected and idle.
tasksRouter.post('/', async (c) => {
  try {
    const body = await c.req.json()
    const {
      title,
      description,
      projectId,
      assignTo,
      priority,
      requiredCapabilities,
      dependsOn,
      notifyOnComplete,
      context,
      parentTaskId,
      createdByAgent,
    } = body as {
      title?: string
      description?: string
      projectId?: string
      assignTo?: string
      priority?: number | string
      requiredCapabilities?: string[]
      dependsOn?: string[]
      notifyOnComplete?: string[]
      context?: Record<string, unknown>
      parentTaskId?: string
      createdByAgent?: string
    }

    if (!title) {
      return c.json({ error: 'title is required' }, 400)
    }
    const priorityInt = priorityValue(priority as number | undefined)
    if (priorityInt === null) {
      return c.json({ error: `unknown priority ${String(priority)}` }, 400)
    }

    const id = generateTaskId()
    const deps = [...new Set(dependsOn ?? [])]
    // 'blocked' until every dependency completes
    const initialStatus = allCompleted(deps) ? 'pending' : 'blocked'
    const owner = c.req.header('X-API-Key-Owner') || null

    db.prepare(`
      INSERT INTO conductor_tasks
        (id, title, description, project_id, parent_task_id, created_by_agent,
         pinned_agent, status, priority, required_capabilities,
         depends_on, notify_on_complete, context, api_key_owner)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      title,
      description ?? '',
      projectId ?? null,
      parentTaskId ?? null,
      createdByAgent ?? null,
      assignTo || null,
      initialStatus,
      priorityInt,
      JSON.stringify(requiredCapabilities ?? []),
      JSON.stringify(deps),
      JSON.stringify(notifyOnComplete ?? []),
      JSON.stringify(context ?? {}),
      owner,
    )

    logTask(id, createdByAgent ?? null, 'created', `Task "${title}" created`)
    dispatch()

    return c.json({ task: getTask(id) }, 201)
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// GET /api/tasks/board — kanban grouped view
tasksRouter.get('/board', (c) => {
  try {
    const projectId = c.req.query('projectId')

    let sql: string
    const params: unknown[] = []

    if (projectId) {
      sql = 'SELECT * FROM conductor_tasks WHERE project_id = ? ORDER BY priority ASC, created_at DESC'
      params.push(projectId)
    } else {
      sql = 'SELECT * FROM conductor_tasks ORDER BY priority ASC, created_at DESC'
    }

    const tasks = db.prepare(sql).all(...params) as Array<{ status: string }>

    const columns: Record<string, unknown[]> = {
      pending: [],
      assigned: [],
      accepted: [],
      in_progress: [],
      review: [],
      completed: [],
      failed: [],
      cancelled: [],
    }

    for (const task of tasks) {
      const col = columns[task.status]
      if (col) {
        col.push(task)
      }
    }

    return c.json({ board: columns })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// GET /api/tasks/agent/:agentId — tasks for specific agent
tasksRouter.get('/agent/:agentId', (c) => {
  try {
    const agentId = c.req.param('agentId')
    const status = c.req.query('status')

    let sql: string
    const params: unknown[] = [agentId]

    if (status) {
      sql = 'SELECT * FROM conductor_tasks WHERE assigned_to_agent = ? AND status = ? ORDER BY priority ASC, created_at DESC'
      params.push(status)
    } else {
      sql = 'SELECT * FROM conductor_tasks WHERE assigned_to_agent = ? ORDER BY priority ASC, created_at DESC'
    }

    const tasks = db.prepare(sql).all(...params)
    return c.json({ tasks })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// GET /api/tasks/:id — single task with logs
tasksRouter.get('/:id', (c) => {
  try {
    const id = c.req.param('id')
    const task = db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(id)

    if (!task) {
      return c.json({ error: 'Task not found' }, 404)
    }

    const logs = db
      .prepare('SELECT * FROM conductor_task_logs WHERE task_id = ? ORDER BY created_at ASC')
      .all(id)

    return c.json({ task, logs })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// PATCH /api/tasks/:id — update task. Order: validate everything, reroute
// (dependsOn, assignedToAgent), plain fields, then the status step; nothing is
// written before a validation failure.
tasksRouter.patch('/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req.json() as Record<string, unknown>

    const existing = getTask(id)
    if (!existing) {
      return c.json({ error: 'Task not found' }, 404)
    }

    const status = typeof body.status === 'string' ? body.status : undefined
    const agentId = typeof body.agentId === 'string' ? body.agentId : undefined
    const feedback = [body.feedback, body.message].find((v): v is string => typeof v === 'string' && v !== '')

    // ── Validate ──
    const priority = 'priority' in body ? priorityValue(body.priority as number) : undefined
    if (priority === null) return c.json({ error: `unknown priority ${String(body.priority)}` }, 400)
    if (body.status !== undefined && status === undefined) return c.json({ error: 'status must be a string' }, 400)
    if (status === 'assigned' || status === 'pending') return c.json({ error: USE_ASSIGN }, 400)
    if (status === 'rejected' && feedback === undefined) {
      return c.json({ error: 'a rejection needs the feedback in feedback or message' }, 400)
    }
    const known = ['accepted', 'in_progress', 'approved', 'rejected', 'cancelled', ...COMPLETING]
    if (status !== undefined && !known.includes(status)) return c.json({ error: `unsupported status ${status}` }, 400)
    if (status === 'accepted' || status === 'in_progress') {
      const refused = acceptRefusal(existing)
      if (refused && !refused.ok) return refusal(c, refused)
    }
    const pinned = body.assignedToAgent
    if ('assignedToAgent' in body && pinned !== null && typeof pinned !== 'string') {
      return c.json({ error: 'assignedToAgent must be a string or null' }, 400)
    }

    const fields: Record<string, string> = {
      title: 'title',
      description: 'description',
      assignedSessionId: 'assigned_session_id',
      requiredCapabilities: 'required_capabilities',
      notifyOnComplete: 'notify_on_complete',
      context: 'context',
    }
    // a result sent with a completing status is the completion's; on its own it is stored as given
    if (!(COMPLETING as readonly string[]).includes(status ?? '')) fields.result = 'result'
    const setClauses: string[] = []
    const values: unknown[] = []
    for (const [key, column] of Object.entries(fields)) {
      if (key in body) {
        const value = body[key]
        setClauses.push(`${column} = ?`)
        values.push(typeof value === 'object' && value !== null ? JSON.stringify(value) : value)
      }
    }
    if (priority !== undefined) {
      setClauses.push('priority = ?')
      values.push(priority)
    }
    const route: RoutePatch = {}
    if ('dependsOn' in body) route.dependsOn = body.dependsOn as string[]
    if ('assignedToAgent' in body) route.pinnedAgent = (pinned as string | null) || null
    const rerouting = Object.keys(route).length > 0
    if (setClauses.length === 0 && !rerouting && status === undefined) {
      return c.json({ error: 'No valid fields to update' }, 400)
    }

    // ── Reroute, then fields, then status ──
    if (rerouting) {
      const moved = rerouteTask(id, route, agentId ?? 'dashboard')
      if (!moved.ok) return refusal(c, moved)
    }
    if (setClauses.length > 0) {
      db.prepare(`UPDATE conductor_tasks SET ${setClauses.join(', ')} WHERE id = ?`).run(...values, id)
      const changed = [...Object.keys(fields).filter((k) => k in body), ...(priority !== undefined ? ['priority'] : [])]
      logTask(id, agentId ?? null, 'updated', `Updated: ${changed.join(', ')}`)
    }

    if (status !== undefined) {
      const row = getTask(id) ?? existing
      let outcome: Outcome
      if (status === 'accepted' || status === 'in_progress') {
        outcome = acceptOrStart(row, status)
      } else if (status === 'approved' || status === 'rejected') {
        const req: ReviewRequest = { verdict: status === 'approved' ? 'approve' : 'reject' }
        if (feedback !== undefined) req.feedback = feedback
        if (agentId !== undefined) req.by = agentId
        outcome = reviewTask(id, req, 'dashboard')
      } else if (status === 'cancelled') {
        outcome = cancelTask(id, agentId ?? 'dashboard')
      } else {
        // without a result the stored one stands
        const result = 'result' in body ? toTaskResult(body.result) : toTaskResult(parseJson<unknown>(row.result, row.result))
        outcome = completeTask(id, null, status as Completing, result)
      }
      if (!outcome.ok) return refusal(c, outcome)
    }

    return c.json({ task: getTask(id) })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// POST /api/tasks/:id/assign — pin the task to an agent; the dispatcher hands it over
tasksRouter.post('/:id/assign', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req.json()
    const { agentId } = body as { agentId?: string; sessionId?: string }

    if (!agentId) {
      return c.json({ error: 'agentId is required' }, 400)
    }

    const moved = rerouteTask(id, { pinnedAgent: agentId }, 'dashboard')
    if (!moved.ok) return refusal(c, moved)
    dispatch()

    return c.json({ task: getTask(id) })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// GET /api/tasks/:id/logs — activity log
tasksRouter.get('/:id/logs', (c) => {
  try {
    const id = c.req.param('id')
    const limit = Number(c.req.query('limit') || '100')

    const logs = db
      .prepare('SELECT * FROM conductor_task_logs WHERE task_id = ? ORDER BY created_at ASC LIMIT ?')
      .all(id, limit)

    return c.json({ logs })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// POST /api/tasks/:id/logs — add log entry
tasksRouter.post('/:id/logs', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req.json()
    const { agentId, action, message } = body as {
      agentId?: string
      action?: string
      message?: string
    }

    if (!action) {
      return c.json({ error: 'action is required' }, 400)
    }

    const existing = db.prepare('SELECT id FROM conductor_tasks WHERE id = ?').get(id)
    if (!existing) {
      return c.json({ error: 'Task not found' }, 404)
    }

    const stmt = db.prepare(
      'INSERT INTO conductor_task_logs (task_id, agent_id, action, message) VALUES (?, ?, ?, ?)',
    )
    const result = stmt.run(id, agentId ?? null, action, message ?? null)

    const log = db.prepare('SELECT * FROM conductor_task_logs WHERE id = ?').get(result.lastInsertRowid)
    return c.json({ log }, 201)
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// DELETE /api/tasks/:id — delete task (an active one is revoked first)
tasksRouter.delete('/:id', (c) => {
  const id = c.req.param('id')
  try {
    const existing = getTask(id)
    if (existing && isActive(existing.status)) revokeTask(id, 'deleted')
    db.prepare('DELETE FROM conductor_task_logs WHERE task_id = ?').run(id)
    const result = db.prepare('DELETE FROM conductor_tasks WHERE id = ?').run(id)
    if (result.changes === 0) {
      return c.json({ error: 'Task not found' }, 404)
    }
    return c.json({ success: true, id })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// PATCH /api/tasks/:id/cancel — soft cancel through the lifecycle (revokes an active task)
tasksRouter.patch('/:id/cancel', (c) => {
  const id = c.req.param('id')
  try {
    const outcome = cancelTask(id, 'dashboard')
    if (!outcome.ok) return refusal(c, outcome)
    return c.json({ success: true, id, status: 'cancelled' })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})
