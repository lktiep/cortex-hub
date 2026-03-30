import { Hono } from 'hono'
import { db } from '../db/client.js'
import { randomUUID } from 'crypto'
import { getAllConnectedAgents, pushTaskToAgent } from '../ws/conductor.js'

export const conductorRouter = new Hono()

// ── Connected agents (real-time from WebSocket) ──
conductorRouter.get('/agents', (c) => {
  try {
    const connected = getAllConnectedAgents()
    return c.json({
      agents: connected,
      online: connected.length,
    })
  } catch (error) {
    return c.json({ agents: [], online: 0, error: String(error) }, 500)
  }
})

// ── Types (matches schema.sql conductor_tasks) ──
interface TaskRow {
  id: string
  title: string
  description: string
  project_id: string | null
  parent_task_id: string | null
  created_by_agent: string | null
  assigned_to_agent: string | null
  assigned_session_id: string | null
  status: string
  priority: number
  required_capabilities: string
  depends_on: string
  notify_on_complete: string
  notified_agents: string
  context: string
  result: string | null
  completed_by: string | null
  created_at: string
  assigned_at: string | null
  accepted_at: string | null
  completed_at: string | null
}

// ── Helpers ──

/** Normalize agent identity for flexible matching (lowercase, trimmed) */
function normalizeIdentity(id: string | null | undefined): string {
  if (!id) return ''
  return id.toLowerCase().trim()
}

/**
 * Check if a requesting agent matches a task's assigned_to field.
 * Matches on agentId, apiKeyOwner, or sessionAgent (any of them).
 */
function agentMatchesAssignment(
  assignedTo: string | null,
  agentId?: string | null,
  apiKeyOwner?: string | null,
  sessionAgent?: string | null
): boolean {
  if (!assignedTo) return true // unassigned tasks can be picked up by anyone
  const target = normalizeIdentity(assignedTo)
  const candidates = [agentId, apiKeyOwner, sessionAgent]
    .map(normalizeIdentity)
    .filter(Boolean)
  return candidates.some((c) => c === target || target.includes(c) || c.includes(target))
}

// ── List tasks ──
conductorRouter.get('/', (c) => {
  try {
    const limit = Number(c.req.query('limit') ?? '50')
    const status = c.req.query('status')
    const assignedTo = c.req.query('assigned_to')

    let query = 'SELECT * FROM conductor_tasks'
    const conditions: string[] = []
    const params: (string | number)[] = []

    if (status) {
      conditions.push('status = ?')
      params.push(status)
    }
    if (assignedTo) {
      conditions.push('(assigned_to_agent = ? OR assigned_to_agent IS NULL)')
      params.push(assignedTo)
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

// ── Get single task ──
conductorRouter.get('/:id', (c) => {
  try {
    const id = c.req.param('id')
    const task = db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(id) as TaskRow | undefined
    if (!task) return c.json({ error: 'Task not found' }, 404)
    return c.json({ task })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Create task ──
conductorRouter.post('/', async (c) => {
  try {
    const body = await c.req.json()
    const {
      title,
      description,
      priority = 5,
      assignedTo,
      projectId,
      metadata,
      // Identity fields for auto-setting created_by_agent
      agentId,
      apiKeyOwner,
      sessionAgent,
    } = body

    if (!title) return c.json({ error: 'Title is required' }, 400)

    const id = `task_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    // Auto-set created_by_agent from available identity, default to 'dashboard'
    const createdByAgent = agentId ?? apiKeyOwner ?? sessionAgent ?? 'dashboard'

    db.prepare(`
      INSERT INTO conductor_tasks (id, title, description, priority, assigned_to_agent, created_by_agent, project_id, context)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      title,
      description ?? '',
      priority,
      assignedTo ?? null,
      createdByAgent,
      projectId ?? null,
      metadata ? JSON.stringify(metadata) : '{}'
    )

    // Notify assigned agent via WebSocket
    if (assignedTo) {
      pushTaskToAgent(assignedTo, id, title, description ?? '')
    }

    const task = db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(id) as TaskRow
    return c.json({ task }, 201)
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Pickup task (flexible identity matching) ──
conductorRouter.post('/pickup', async (c) => {
  try {
    const body = await c.req.json()
    const { agentId, apiKeyOwner, sessionAgent } = body

    if (!agentId && !apiKeyOwner && !sessionAgent) {
      return c.json({ error: 'At least one identity field required (agentId, apiKeyOwner, or sessionAgent)' }, 400)
    }

    // Fetch all pending tasks, ordered by priority
    const pendingTasks = db.prepare(
      "SELECT * FROM conductor_tasks WHERE status = 'pending' ORDER BY priority ASC, created_at ASC"
    ).all() as TaskRow[]

    // Find first task that matches agent identity
    const matchedTask = pendingTasks.find((task) =>
      agentMatchesAssignment(task.assigned_to_agent, agentId, apiKeyOwner, sessionAgent)
    )

    if (!matchedTask) {
      return c.json({ task: null, message: 'No matching tasks available' })
    }

    // Claim the task
    const pickedUpBy = agentId ?? apiKeyOwner ?? sessionAgent
    db.prepare(`
      UPDATE conductor_tasks
      SET status = 'accepted', assigned_to_agent = COALESCE(assigned_to_agent, ?), accepted_at = datetime('now')
      WHERE id = ? AND status = 'pending'
    `).run(pickedUpBy, matchedTask.id)

    const task = db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(matchedTask.id) as TaskRow
    return c.json({ task })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Update task (status, result, context) ──
conductorRouter.put('/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req.json()
    const { status, result, context, completedBy } = body

    const existing = db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(id) as TaskRow | undefined
    if (!existing) return c.json({ error: 'Task not found' }, 404)

    const updates: string[] = []
    const params: (string | number | null)[] = []

    if (status !== undefined) {
      updates.push('status = ?')
      params.push(status)
      if (status === 'completed' || status === 'failed') {
        updates.push("completed_at = datetime('now')")
      }
      if (status === 'in_progress' && !existing.accepted_at) {
        updates.push("accepted_at = datetime('now')")
      }
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
      const existingCtx = existing.context ? JSON.parse(existing.context) : {}
      updates.push('context = ?')
      params.push(JSON.stringify({ ...existingCtx, ...context }))
    }

    if (updates.length === 0) {
      return c.json({ task: existing })
    }

    params.push(id)
    db.prepare(`UPDATE conductor_tasks SET ${updates.join(', ')} WHERE id = ?`).run(...params)

    const task = db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(id) as TaskRow
    return c.json({ task })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Cancel task ──
conductorRouter.post('/:id/cancel', (c) => {
  try {
    const id = c.req.param('id')
    const existing = db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(id) as TaskRow | undefined
    if (!existing) return c.json({ error: 'Task not found' }, 404)

    if (existing.status === 'completed' || existing.status === 'cancelled') {
      return c.json({ error: `Cannot cancel task with status '${existing.status}'` }, 400)
    }

    db.prepare(`
      UPDATE conductor_tasks
      SET status = 'cancelled', updated_at = datetime('now'), completed_at = datetime('now')
      WHERE id = ?
    `).run(id)

    return c.json({ success: true, id })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Delete task ──
conductorRouter.delete('/:id', (c) => {
  try {
    const id = c.req.param('id')
    const existing = db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(id) as TaskRow | undefined
    if (!existing) return c.json({ error: 'Task not found' }, 404)

    db.prepare('DELETE FROM conductor_tasks WHERE id = ?').run(id)
    return c.json({ success: true, id })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})
