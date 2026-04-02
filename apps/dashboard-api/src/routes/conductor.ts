import { Hono } from 'hono'
import { db } from '../db/client.js'
import { randomUUID } from 'crypto'
import {
  getAllConnectedAgents,
  pushTaskToAgent,
  notifyAgents,
  setAgentStatus,
} from '../ws/conductor.js'

export const conductorRouter = new Hono()

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

/** Parse a JSON string field safely, returning fallback on error */
function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

/** Generate a task ID */
function generateTaskId(): string {
  return `task_${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

/** Log a task action */
function logTaskAction(taskId: string, agentId: string | null, action: string, message?: string): void {
  db.prepare(
    'INSERT INTO conductor_task_logs (task_id, agent_id, action, message) VALUES (?, ?, ?, ?)'
  ).run(taskId, agentId, action, message ?? null)
}

/**
 * Check if all dependencies of a task are completed.
 * Returns true if all dependency tasks have status='completed'.
 */
function allDependenciesMet(dependsOn: string[]): boolean {
  if (dependsOn.length === 0) return true
  const placeholders = dependsOn.map(() => '?').join(',')
  const completedCount = db.prepare(
    `SELECT COUNT(*) as cnt FROM conductor_tasks WHERE id IN (${placeholders}) AND status = 'completed'`
  ).get(...dependsOn) as { cnt: number }
  return completedCount.cnt === dependsOn.length
}

/**
 * After a task completes, resolve downstream dependencies:
 * 1. Unblock tasks that depend on this one (if all deps met)
 * 2. Notify agents in notify_on_complete
 * 3. Check if parent task's subtasks are all complete
 */
/** Guard against re-entrant resolveCompletionChain calls (prevents infinite loops) */
const _resolving = new Set<string>()

export function resolveCompletionChain(completedTask: TaskRow): void {
  const completedId = completedTask.id

  // ── Anti-recursion guard: skip if already resolving this task ──
  if (_resolving.has(completedId)) {
    console.warn(`[conductor] resolveCompletionChain: skipping ${completedId} (already resolving)`)
    return
  }
  _resolving.add(completedId)

  try {
    // 1. Find tasks that depend on this completed task and unblock them
    const dependentTasks = db.prepare(
      "SELECT * FROM conductor_tasks WHERE status = 'blocked'"
    ).all() as TaskRow[]

    for (const task of dependentTasks) {
      const deps = safeJsonParse<string[]>(task.depends_on, [])
      if (!deps.includes(completedId)) continue

      // Check if ALL dependencies for this task are now met
      if (allDependenciesMet(deps)) {
        db.prepare(
          "UPDATE conductor_tasks SET status = 'pending' WHERE id = ?"
        ).run(task.id)

        logTaskAction(task.id, null, 'unblocked', `All dependencies met after ${completedId} completed`)

        // If the task has an assigned agent, notify them
        if (task.assigned_to_agent) {
          pushTaskToAgent(task.assigned_to_agent, task.id, task.title, task.description)
        }
      }
    }

    // 2. Notify agents listed in notify_on_complete
    const notifyList = safeJsonParse<string[]>(completedTask.notify_on_complete, [])
    if (notifyList.length > 0) {
      const notified = notifyAgents(notifyList, {
        type: 'task.completed',
        taskId: completedId,
        title: completedTask.title,
        result: completedTask.result ? safeJsonParse(completedTask.result, {}) : null,
        completedBy: completedTask.completed_by,
        timestamp: new Date().toISOString(),
      })

      // Record which agents were actually notified
      const existingNotified = safeJsonParse<string[]>(completedTask.notified_agents, [])
      const allNotified = [...new Set([...existingNotified, ...notified])]
      db.prepare(
        'UPDATE conductor_tasks SET notified_agents = ? WHERE id = ?'
      ).run(JSON.stringify(allNotified), completedId)
    }

    // 3. Auto-review DISABLED — was causing recursive task spam loops.
    //    Reviews should be explicitly created by the strategy/pipeline, not auto-generated.
    //    TODO: Re-enable when review scheduling is properly integrated into pipeline strategy.

    // 4. Check if this is a subtask and all siblings are complete -> update parent
    if (completedTask.parent_task_id) {
      checkParentCompletion(completedTask.parent_task_id)
    }
  } finally {
    _resolving.delete(completedId)
  }
}

/**
 * Check if all subtasks of a parent are complete.
 * If so, mark the parent as completed with a summary result.
 */
function checkParentCompletion(parentId: string): void {
  const parent = db.prepare(
    'SELECT * FROM conductor_tasks WHERE id = ?'
  ).get(parentId) as TaskRow | undefined

  if (!parent) return
  // Don't update if parent is already in a terminal state
  if (parent.status === 'completed' || parent.status === 'cancelled' || parent.status === 'failed') return

  const subtasks = db.prepare(
    'SELECT * FROM conductor_tasks WHERE parent_task_id = ?'
  ).all(parentId) as TaskRow[]

  if (subtasks.length === 0) return

  // Only consider non-cancelled subtasks
  const activeSubtasks = subtasks.filter((t) => t.status !== 'cancelled')
  if (activeSubtasks.length === 0) return

  // Parent completes ONLY when ALL active subtasks are completed (no pending/blocked/in_progress)
  const allComplete = activeSubtasks.every((t) => t.status === 'completed' || t.status === 'approved')
  const anyPending = activeSubtasks.some((t) => ['pending', 'blocked', 'assigned', 'accepted', 'in_progress', 'review'].includes(t.status))
  const anyFailed = activeSubtasks.some((t) => t.status === 'failed')

  // Don't auto-complete if any subtask is still in progress
  if (anyPending) return

  if (allComplete) {
    const subtaskResults = subtasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      assignedTo: t.assigned_to_agent,
      completedBy: t.completed_by,
      result: t.result ? safeJsonParse(t.result, null) : null,
    }))

    // If parent has a Lead Agent assigned, enter synthesis mode instead of auto-completing
    if (parent.assigned_to_agent) {
      const existingCtx = safeJsonParse<Record<string, unknown>>(parent.context, {})
      const updatedCtx = { ...existingCtx, subtaskResults, phase: 'synthesis' }

      db.prepare(`
        UPDATE conductor_tasks
        SET status = 'synthesis', context = ?
        WHERE id = ?
      `).run(JSON.stringify(updatedCtx), parentId)

      logTaskAction(parentId, null, 'synthesis_ready',
        `All ${activeSubtasks.length} subtasks completed. Awaiting Lead Agent synthesis.`)

      // Notify Lead Agent via WS to synthesize
      pushTaskToAgent(parent.assigned_to_agent, parentId, parent.title,
        `All ${activeSubtasks.length} subtasks completed. Please synthesize results and submit final summary.`)

      console.log(`[conductor] Synthesis requested: ${parentId} → ${parent.assigned_to_agent}`)
    } else {
      // No Lead Agent — fallback to auto-complete
      db.prepare(`
        UPDATE conductor_tasks
        SET status = 'completed', completed_at = datetime('now'),
            result = ?
        WHERE id = ?
      `).run(JSON.stringify({ subtaskResults, autoCompleted: true }), parentId)

      logTaskAction(parentId, null, 'auto_completed', `All ${subtasks.length} subtasks completed`)

      const updatedParent = db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(parentId) as TaskRow
      resolveCompletionChain(updatedParent)
    }
  } else if (anyFailed) {
    // If any subtask failed, mark parent for review
    const failedTasks = subtasks.filter((t) => t.status === 'failed').map((t) => t.id)
    logTaskAction(parentId, null, 'subtask_failed', `Subtasks failed: ${failedTasks.join(', ')}`)
  }
}

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
conductorRouter.post('/auto-assign', async (c) => {
  try {
    const body = await c.req.json()
    const {
      taskId,
      requiredCapabilities = [] as string[],
      preferredPlatform,
    } = body as {
      taskId: string
      requiredCapabilities?: string[]
      preferredPlatform?: string
    }

    if (!taskId) return c.json({ error: 'taskId is required' }, 400)

    const task = db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(taskId) as TaskRow | undefined
    if (!task) return c.json({ error: 'Task not found' }, 404)

    const connected = getAllConnectedAgents()
    if (connected.length === 0) {
      return c.json({ error: 'No agents online', assigned: false }, 200)
    }

    // Score each agent: +10 per matching capability, +5 for preferred platform, +3 for idle
    type ScoredAgent = { agentId: string; score: number }
    const scored: ScoredAgent[] = connected.map((agent) => {
      let score = 0

      // Check required capabilities
      const agentCaps = agent.capabilities
      for (const req of requiredCapabilities) {
        if (agentCaps.includes(req)) {
          score += 10
        }
      }

      // Must have ALL required capabilities to be eligible
      const hasAllRequired = requiredCapabilities.every((req) => agentCaps.includes(req))
      if (!hasAllRequired && requiredCapabilities.length > 0) {
        return { agentId: agent.agentId, score: -1 }
      }

      // Prefer matching platform
      if (preferredPlatform && agent.platform?.toLowerCase() === preferredPlatform.toLowerCase()) {
        score += 5
      }

      // Prefer idle agents
      if (agent.status === 'idle') {
        score += 3
      }

      return { agentId: agent.agentId, score }
    })

    // Filter out ineligible agents (score < 0) and sort by score descending
    const eligible = scored.filter((a) => a.score >= 0).sort((a, b) => b.score - a.score)

    if (eligible.length > 0) {
      const bestAgent = eligible[0]!

      // Assign the task
      db.prepare(`
        UPDATE conductor_tasks
        SET assigned_to_agent = ?, assigned_at = datetime('now'), status = CASE WHEN status = 'blocked' THEN 'blocked' ELSE 'pending' END
        WHERE id = ?
      `).run(bestAgent.agentId, taskId)

      // Push notification via WebSocket
      pushTaskToAgent(bestAgent.agentId, task.id, task.title, task.description)
      setAgentStatus(bestAgent.agentId, 'busy')

      logTaskAction(taskId, bestAgent.agentId, 'auto_assigned',
        `Auto-assigned based on capabilities: ${requiredCapabilities.join(', ')}`)

      const updatedTask = db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(taskId) as TaskRow
      return c.json({ task: updatedTask, assigned: true, agentId: bestAgent.agentId })
    }

    // ── Delegation: no single agent has ALL capabilities → split into subtasks ──
    // Find which capabilities each agent CAN cover
    const capCoverage = new Map<string, { agentId: string; caps: string[]; score: number }>()
    for (const agent of connected) {
      const matching = requiredCapabilities.filter((req) => agent.capabilities.includes(req))
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
        requiredCapabilities,
      }, 200)
    }

    // Greedy: assign capabilities to best-scoring agents until all covered
    const uncovered = new Set(requiredCapabilities)
    const delegation: { agentId: string; caps: string[] }[] = []
    const sortedAgents = [...capCoverage.values()].sort((a, b) => b.score - a.score)

    for (const agent of sortedAgents) {
      if (uncovered.size === 0) break
      const covers = agent.caps.filter((c) => uncovered.has(c))
      if (covers.length > 0) {
        delegation.push({ agentId: agent.agentId, caps: covers })
        covers.forEach((c) => uncovered.delete(c))
      }
    }

    if (uncovered.size > 0) {
      return c.json({
        error: `Cannot cover all capabilities. Missing: ${[...uncovered].join(', ')}`,
        assigned: false,
        delegation: delegation.length > 0 ? delegation : undefined,
        requiredCapabilities,
      }, 200)
    }

    // Create subtasks for each delegate agent
    const subtaskIds: string[] = []
    for (const del of delegation) {
      const subId = generateTaskId()
      db.prepare(`
        INSERT INTO conductor_tasks
          (id, title, description, priority, assigned_to_agent, created_by_agent,
           project_id, parent_task_id, required_capabilities, status, assigned_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
      `).run(
        subId,
        `[Delegated] ${task.title} — ${del.caps.join(', ')}`,
        `Subtask delegated from ${taskId}. Required capabilities: ${del.caps.join(', ')}`,
        task.priority,
        del.agentId,
        'orchestrator',
        task.project_id,
        taskId,
        JSON.stringify(del.caps),
      )

      pushTaskToAgent(del.agentId, subId, `[Delegated] ${task.title}`, `Capabilities: ${del.caps.join(', ')}`)
      setAgentStatus(del.agentId, 'busy')
      logTaskAction(subId, del.agentId, 'delegated', `Delegated capabilities: ${del.caps.join(', ')}`)
      subtaskIds.push(subId)
    }

    // Mark parent task as in_progress (being orchestrated)
    db.prepare(`
      UPDATE conductor_tasks SET status = 'in_progress', context = ? WHERE id = ?
    `).run(JSON.stringify({ delegatedTo: delegation, subtaskIds }), taskId)
    logTaskAction(taskId, null, 'delegated', `Split into ${delegation.length} subtasks across ${delegation.map((d) => d.agentId).join(', ')}`)

    const updatedTask = db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(taskId) as TaskRow
    return c.json({
      task: updatedTask,
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
    const limit = Number(c.req.query('limit') ?? '50')
    const status = c.req.query('status')
    const assignedTo = c.req.query('assigned_to')
    const parentTaskId = c.req.query('parent_task_id')

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
    if (parentTaskId) {
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

// ── Get single task ──
conductorRouter.get('/:id', (c) => {
  try {
    const id = c.req.param('id')
    // Avoid matching route keywords
    if (id === 'agents' || id === 'auto-assign') return c.notFound()

    const task = db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(id) as TaskRow | undefined
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

// ── Create task (with parent link, dependencies, notify_on_complete) ──
conductorRouter.post('/', async (c) => {
  try {
    const body = await c.req.json()
    let {
      title,
      description,
      priority = 5,
      assignedTo,
      projectId,
      metadata,
      parentTaskId,
      dependsOn,
      notifyOnComplete,
      requiredCapabilities,
      // Identity fields for auto-setting created_by_agent
      agentId,
      apiKeyOwner,
      sessionAgent,
    } = body as {
      title?: string
      description?: string
      priority?: number
      assignedTo?: string
      projectId?: string
      metadata?: Record<string, unknown>
      parentTaskId?: string
      dependsOn?: string[]
      notifyOnComplete?: string[]
      requiredCapabilities?: string[]
      agentId?: string
      apiKeyOwner?: string
      sessionAgent?: string
    }

    if (!title) return c.json({ error: 'Title is required' }, 400)

    // Validate parent exists if specified
    if (parentTaskId) {
      const parent = db.prepare('SELECT id FROM conductor_tasks WHERE id = ?').get(parentTaskId)
      if (!parent) return c.json({ error: 'Parent task not found' }, 404)
    }

    // Validate dependency task IDs exist
    const deps = dependsOn ?? []
    if (deps.length > 0) {
      const placeholders = deps.map(() => '?').join(',')
      const found = db.prepare(
        `SELECT COUNT(*) as cnt FROM conductor_tasks WHERE id IN (${placeholders})`
      ).get(...deps) as { cnt: number }
      if (found.cnt !== deps.length) {
        return c.json({ error: 'One or more dependency task IDs not found' }, 400)
      }
    }

    const id = generateTaskId()
    const createdByAgent = agentId ?? apiKeyOwner ?? sessionAgent ?? 'dashboard'

    // Auto-link: if an agent creates a task without parentTaskId, link to their active task
    if (!parentTaskId && createdByAgent !== 'dashboard' && createdByAgent !== 'dashboard-ui') {
      const activeTask = db.prepare(
        "SELECT id FROM conductor_tasks WHERE assigned_to_agent = ? AND status IN ('accepted', 'in_progress') ORDER BY accepted_at DESC LIMIT 1"
      ).get(createdByAgent) as { id: string } | undefined
      if (activeTask) {
        parentTaskId = activeTask.id
      }
    }

    // Determine initial status: 'blocked' if dependencies are not all met, else 'pending'
    let initialStatus = 'pending'
    if (deps.length > 0 && !allDependenciesMet(deps)) {
      initialStatus = 'blocked'
    }

    db.prepare(`
      INSERT INTO conductor_tasks
        (id, title, description, priority, assigned_to_agent, created_by_agent,
         project_id, context, parent_task_id, depends_on, notify_on_complete, required_capabilities, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      title,
      description ?? '',
      priority,
      assignedTo ?? null,
      createdByAgent,
      projectId ?? null,
      metadata ? JSON.stringify(metadata) : '{}',
      parentTaskId ?? null,
      JSON.stringify(deps),
      JSON.stringify(notifyOnComplete ?? []),
      JSON.stringify(requiredCapabilities ?? []),
      initialStatus,
    )

    logTaskAction(id, createdByAgent, 'created',
      parentTaskId ? `Subtask of ${parentTaskId}` : undefined)

    // Notify assigned agent via WebSocket (only if not blocked)
    if (assignedTo && initialStatus !== 'blocked') {
      pushTaskToAgent(assignedTo, id, title, description ?? '')
      setAgentStatus(assignedTo, 'busy')
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
    const { agentId, apiKeyOwner, sessionAgent } = body as {
      agentId?: string
      apiKeyOwner?: string
      sessionAgent?: string
    }

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

    logTaskAction(matchedTask.id, pickedUpBy ?? null, 'picked_up', 'Agent picked up task')

    const task = db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(matchedTask.id) as TaskRow
    return c.json({ task })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Update task (status, result, context) with chain resolution and review loop ──
conductorRouter.put('/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req.json()
    const { status, result, context, completedBy, reviewerAgent } = body as {
      status?: string
      result?: unknown
      context?: Record<string, unknown>
      completedBy?: string
      reviewerAgent?: string
    }

    const existing = db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(id) as TaskRow | undefined
    if (!existing) return c.json({ error: 'Task not found' }, 404)

    // Block agents from completing/progressing a task that awaits user strategy approval
    if (existing.status === 'strategy_review' && status && status !== 'strategy_review') {
      return c.json({ error: 'Task is awaiting strategy approval — only the dashboard can change its status' }, 403)
    }

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
      const existingCtx = safeJsonParse<Record<string, unknown>>(existing.context, {})
      updates.push('context = ?')
      params.push(JSON.stringify({ ...existingCtx, ...context }))
    }

    // Allow re-parenting tasks (fix orphans)
    const parentTaskId = (body as Record<string, unknown>).parentTaskId as string | undefined
    if (parentTaskId !== undefined) {
      updates.push('parent_task_id = ?')
      params.push(parentTaskId || null)
    }

    if (updates.length === 0) {
      return c.json({ task: existing })
    }

    params.push(id)
    db.prepare(`UPDATE conductor_tasks SET ${updates.join(', ')} WHERE id = ?`).run(...params)

    const updatedTask = db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(id) as TaskRow

    // ── Post-update chain logic ──

    // Handle completion → resolve dependency chain + set agent idle + recipe capture
    if (status === 'completed') {
      logTaskAction(id, completedBy ?? null, 'completed', undefined)
      if (existing.assigned_to_agent) {
        setAgentStatus(existing.assigned_to_agent, 'idle')
      }
      resolveCompletionChain(updatedTask)

      // Fire-and-forget recipe capture (OpenSpace-inspired auto-learning)
      if (updatedTask.result) {
        import('../services/recipe-capture.js').then(({ captureFromTask }) =>
          captureFromTask(updatedTask).catch(e =>
            console.warn('[recipe-capture] Task capture error:', (e as Error).message)
          )
        ).catch(() => { /* module load failure — non-critical */ })
      }
    }
    if (status === 'failed') {
      if (existing.assigned_to_agent) {
        setAgentStatus(existing.assigned_to_agent, 'idle')
      }
    }

    // Handle review submission
    if (status === 'review') {
      logTaskAction(id, existing.assigned_to_agent, 'submitted_for_review', undefined)
      // Notify reviewer if specified
      if (reviewerAgent) {
        notifyAgents([reviewerAgent], {
          type: 'task.review_requested',
          taskId: id,
          title: existing.title,
          submittedBy: existing.assigned_to_agent,
          timestamp: new Date().toISOString(),
        })
      }
      // Also notify parent creator/orchestrator
      if (existing.parent_task_id) {
        const parent = db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(existing.parent_task_id) as TaskRow | undefined
        if (parent?.created_by_agent) {
          notifyAgents([parent.created_by_agent], {
            type: 'task.review_requested',
            taskId: id,
            title: existing.title,
            parentTaskId: parent.id,
            submittedBy: existing.assigned_to_agent,
            timestamp: new Date().toISOString(),
          })
        }
      }
    }

    // Handle rejection → create revision subtask for original agent
    if (status === 'rejected') {
      logTaskAction(id, completedBy ?? null, 'rejected', typeof result === 'string' ? result : JSON.stringify(result))

      const feedback = typeof result === 'string' ? result : JSON.stringify(result ?? 'Revision needed')
      const originalAgent = existing.assigned_to_agent

      // Create a revision subtask linked to the rejected task
      const revisionId = generateTaskId()
      db.prepare(`
        INSERT INTO conductor_tasks
          (id, title, description, priority, assigned_to_agent, created_by_agent,
           project_id, context, parent_task_id, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
      `).run(
        revisionId,
        `Revision: ${existing.title}`,
        `Review feedback for task ${id}:\n\n${feedback}`,
        Math.max(1, existing.priority - 1), // bump priority
        originalAgent,
        completedBy ?? 'reviewer',
        existing.project_id,
        JSON.stringify({
          originalTaskId: id,
          feedback,
          revisionOf: id,
        }),
        existing.parent_task_id ?? id, // link to parent or original
      )

      logTaskAction(revisionId, completedBy ?? null, 'created',
        `Revision subtask from rejected task ${id}`)

      // Notify original agent about the revision
      if (originalAgent) {
        pushTaskToAgent(originalAgent, revisionId, `Revision: ${existing.title}`, feedback)
      }
    }

    // Handle approval → notify parent/orchestrator
    if (status === 'approved') {
      logTaskAction(id, completedBy ?? null, 'approved', undefined)

      // Mark as completed as well (only if not already completed, prevents double processing)
      const currentStatus = db.prepare('SELECT status FROM conductor_tasks WHERE id = ?').get(id) as { status: string } | undefined
      if (currentStatus && currentStatus.status !== 'completed') {
        db.prepare(`
          UPDATE conductor_tasks
          SET status = 'completed', completed_at = datetime('now'), completed_by = COALESCE(completed_by, ?)
          WHERE id = ? AND status != 'completed'
        `).run(completedBy ?? existing.assigned_to_agent, id)

        const finalTask = db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(id) as TaskRow

        // Notify orchestrator/parent creator
        if (existing.parent_task_id) {
          const parent = db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(existing.parent_task_id) as TaskRow | undefined
          if (parent?.created_by_agent) {
            notifyAgents([parent.created_by_agent], {
              type: 'task.approved',
              taskId: id,
              title: existing.title,
              parentTaskId: parent.id,
              timestamp: new Date().toISOString(),
            })
          }
        }

        // Resolve completion chain since approved = completed
        resolveCompletionChain(finalTask)

        return c.json({ task: finalTask })
      }

      // Already completed — just return current state
      return c.json({ task: db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(id) as TaskRow })
    }

    return c.json({ task: updatedTask })
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

    const existing = db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(id) as TaskRow | undefined
    if (!existing) return c.json({ error: 'Task not found' }, 404)

    // Save strategy into context and set status to strategy_review
    const existingCtx = safeJsonParse<Record<string, unknown>>(existing.context, {})
    const updatedCtx = { ...existingCtx, strategy, phase: 'strategy_review' }

    db.prepare(`
      UPDATE conductor_tasks
      SET status = 'strategy_review', context = ?
      WHERE id = ?
    `).run(JSON.stringify(updatedCtx), id)

    logTaskAction(id, existing.assigned_to_agent, 'strategy_submitted',
      `Strategy: ${strategy.roles.length} roles, ${strategy.subtasks.length} subtasks`)

    // Broadcast to dashboard via WS
    const { broadcastStrategyReady } = await import('../ws/conductor.js')
    broadcastStrategyReady(id, existing.title, strategy)

    const task = db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(id) as TaskRow
    return c.json({ task })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Approve strategy (user approves from dashboard) ──
conductorRouter.post('/:id/strategy/approve', async (c) => {
  try {
    const id = c.req.param('id')
    const existing = db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(id) as TaskRow | undefined
    if (!existing) return c.json({ error: 'Task not found' }, 404)

    if (existing.status !== 'strategy_review') {
      return c.json({ error: `Cannot approve strategy: task status is '${existing.status}', expected 'strategy_review'` }, 400)
    }

    const existingCtx = safeJsonParse<Record<string, unknown>>(existing.context, {})
    const updatedCtx = { ...existingCtx, phase: 'execution', strategyApprovedAt: new Date().toISOString() }

    db.prepare(`
      UPDATE conductor_tasks
      SET status = 'in_progress', context = ?
      WHERE id = ?
    `).run(JSON.stringify(updatedCtx), id)

    logTaskAction(id, null, 'strategy_approved', 'Strategy approved by user')

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
      SET status = 'cancelled', completed_at = datetime('now')
      WHERE id = ?
    `).run(id)

    logTaskAction(id, null, 'cancelled', undefined)

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

    const existing = db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(taskId) as TaskRow | undefined
    if (!existing) return c.json({ error: 'Task not found' }, 404)

    const body = await c.req.json()
    const { status, reason } = body as { status: 'approved' | 'rejected'; reason?: string }

    if (status !== 'approved' && status !== 'rejected') {
      return c.json({ error: 'status must be "approved" or "rejected"' }, 400)
    }

    // Update context.decisions
    const ctx = safeJsonParse<Record<string, unknown>>(existing.context, {})
    const decisions = (ctx['decisions'] ?? {}) as Record<string, { status: string; reason?: string; decidedAt: string }>
    decisions[findingId] = { status, reason, decidedAt: new Date().toISOString() }
    ctx['decisions'] = decisions

    db.prepare('UPDATE conductor_tasks SET context = ? WHERE id = ?').run(JSON.stringify(ctx), taskId)

    logTaskAction(taskId, null, `finding_${status}`, `Finding ${findingId} ${status}${reason ? ': ' + reason : ''}`)

    return c.json({ success: true, findingId, status, decisions })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Decision Matrix: finalize task with approved findings only ──
conductorRouter.post('/:id/finalize', async (c) => {
  try {
    const taskId = c.req.param('id')

    const existing = db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(taskId) as TaskRow | undefined
    if (!existing) return c.json({ error: 'Task not found' }, 404)

    const ctx = safeJsonParse<Record<string, unknown>>(existing.context, {})
    const decisions = (ctx['decisions'] ?? {}) as Record<string, { status: string; reason?: string; decidedAt: string }>

    // Parse result to get findings
    const resultObj = safeJsonParse<{ summary?: string; findings?: Array<{ id: string; [k: string]: unknown }> }>(existing.result, {})
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
      SET result = ?, status = 'completed', completed_at = datetime('now')
      WHERE id = ?
    `).run(JSON.stringify(finalResult), taskId)

    logTaskAction(taskId, null, 'finalized',
      `Finalized with ${approvedFindings.length}/${allFindings.length} findings approved`)

    const updatedTask = db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(taskId) as TaskRow
    resolveCompletionChain(updatedTask)

    return c.json({ task: updatedTask })
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
