import { Hono } from 'hono'
import { db } from '../db/client.js'

export const tasksRouter = new Hono()

function generateTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
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

// POST /api/tasks — create task
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
      priority?: number
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

    const id = generateTaskId()
    const now = new Date().toISOString()
    const status = assignTo ? 'assigned' : 'pending'

    const stmt = db.prepare(`
      INSERT INTO conductor_tasks
        (id, title, description, project_id, parent_task_id, created_by_agent,
         assigned_to_agent, status, priority, required_capabilities,
         depends_on, notify_on_complete, context, assigned_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    stmt.run(
      id,
      title,
      description ?? '',
      projectId ?? null,
      parentTaskId ?? null,
      createdByAgent ?? null,
      assignTo ?? null,
      status,
      priority ?? 5,
      JSON.stringify(requiredCapabilities ?? []),
      JSON.stringify(dependsOn ?? []),
      JSON.stringify(notifyOnComplete ?? []),
      JSON.stringify(context ?? {}),
      assignTo ? now : null,
    )

    // Log creation
    db.prepare(
      'INSERT INTO conductor_task_logs (task_id, agent_id, action, message) VALUES (?, ?, ?, ?)',
    ).run(id, createdByAgent ?? null, 'created', `Task "${title}" created`)

    if (assignTo) {
      db.prepare(
        'INSERT INTO conductor_task_logs (task_id, agent_id, action, message) VALUES (?, ?, ?, ?)',
      ).run(id, createdByAgent ?? null, 'assigned', `Assigned to ${assignTo}`)
    }

    const task = db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(id)
    return c.json({ task }, 201)
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

// PATCH /api/tasks/:id — update task (status, assign, etc)
tasksRouter.patch('/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req.json()

    const existing = db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(id)
    if (!existing) {
      return c.json({ error: 'Task not found' }, 404)
    }

    const allowedFields: Record<string, string> = {
      title: 'title',
      description: 'description',
      status: 'status',
      priority: 'priority',
      assignedToAgent: 'assigned_to_agent',
      assignedSessionId: 'assigned_session_id',
      requiredCapabilities: 'required_capabilities',
      dependsOn: 'depends_on',
      notifyOnComplete: 'notify_on_complete',
      context: 'context',
      result: 'result',
    }

    const setClauses: string[] = []
    const values: unknown[] = []

    for (const [key, column] of Object.entries(allowedFields)) {
      if (key in body) {
        let value = body[key]
        // Serialize arrays/objects to JSON strings
        if (typeof value === 'object' && value !== null) {
          value = JSON.stringify(value)
        }
        setClauses.push(`${column} = ?`)
        values.push(value)
      }
    }

    // Handle timestamp fields based on status changes
    if (body.status) {
      const now = new Date().toISOString()
      if (body.status === 'assigned') {
        setClauses.push('assigned_at = ?')
        values.push(now)
      } else if (body.status === 'accepted') {
        setClauses.push('accepted_at = ?')
        values.push(now)
      } else if (body.status === 'completed' || body.status === 'failed') {
        setClauses.push('completed_at = ?')
        values.push(now)
      }
    }

    if (setClauses.length === 0) {
      return c.json({ error: 'No valid fields to update' }, 400)
    }

    values.push(id)
    db.prepare(`UPDATE conductor_tasks SET ${setClauses.join(', ')} WHERE id = ?`).run(...values)

    // Log the update
    const changes = Object.keys(allowedFields).filter((k) => k in body)
    db.prepare(
      'INSERT INTO conductor_task_logs (task_id, agent_id, action, message) VALUES (?, ?, ?, ?)',
    ).run(id, body.agentId ?? null, 'updated', `Updated: ${changes.join(', ')}`)

    const task = db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(id)
    return c.json({ task })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// POST /api/tasks/:id/assign — assign to agent/session
tasksRouter.post('/:id/assign', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req.json()
    const { agentId, sessionId } = body as { agentId?: string; sessionId?: string }

    if (!agentId) {
      return c.json({ error: 'agentId is required' }, 400)
    }

    const existing = db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(id)
    if (!existing) {
      return c.json({ error: 'Task not found' }, 404)
    }

    const now = new Date().toISOString()
    db.prepare(
      'UPDATE conductor_tasks SET assigned_to_agent = ?, assigned_session_id = ?, status = ?, assigned_at = ? WHERE id = ?',
    ).run(agentId, sessionId ?? null, 'assigned', now, id)

    db.prepare(
      'INSERT INTO conductor_task_logs (task_id, agent_id, action, message) VALUES (?, ?, ?, ?)',
    ).run(id, agentId, 'assigned', `Assigned to ${agentId}${sessionId ? ` (session: ${sessionId})` : ''}`)

    const task = db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(id)
    return c.json({ task })
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

// DELETE /api/tasks/:id — cancel/delete task
tasksRouter.delete('/:id', (c) => {
  const id = c.req.param('id')
  try {
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

// PATCH /api/tasks/:id/cancel — soft cancel (set status to cancelled)
tasksRouter.patch('/:id/cancel', (c) => {
  const id = c.req.param('id')
  try {
    db.prepare("UPDATE conductor_tasks SET status = 'cancelled', completed_at = datetime('now') WHERE id = ?").run(id)
    return c.json({ success: true, id, status: 'cancelled' })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})
