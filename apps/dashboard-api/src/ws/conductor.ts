import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'http'
import type { Server } from 'http'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { db } from '../db/client.js'
import { resolveCompletionChain } from '../routes/conductor.js'

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

interface ConnectedAgent {
  ws: WebSocket
  agentId: string
  apiKeyOwner: string
  hostname?: string
  ide?: string
  platform?: string
  capabilities: string[]
  /** 'idle' when no in_progress tasks, 'busy' otherwise */
  status: 'idle' | 'busy'
  connectedAt: Date
  lastPing: Date
}

/** Store connected agents by agentId */
const agents = new Map<string, ConnectedAgent>()

export function setupConductorWebSocket(server: Server) {
  const wss = new WebSocketServer({ server, path: '/ws/conductor' })

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // Extract params from query string: /ws/conductor?apiKey=sk_xxx&agentId=xxx
    const url = new URL(req.url || '', `http://${req.headers.host}`)
    const apiKey = url.searchParams.get('apiKey')
    const agentId = url.searchParams.get('agentId') || 'unknown'
    const hostname = url.searchParams.get('hostname') || undefined
    const ide = url.searchParams.get('ide') || undefined
    const platform = url.searchParams.get('platform') || undefined
    const capabilitiesRaw = url.searchParams.get('capabilities') || '[]'

    if (!apiKey) {
      ws.close(4001, 'Missing apiKey')
      return
    }

    // Validate API key against stored keys (hash the raw key first)
    const keyHash = createHash('sha256').update(apiKey).digest('hex')
    const keyRow = db
      .prepare('SELECT name FROM api_keys WHERE key_hash = ?')
      .get(keyHash) as { name: string } | undefined

    if (!keyRow) {
      ws.close(4003, 'Invalid apiKey')
      return
    }
    const apiKeyOwner = keyRow.name

    let parsedCaps: unknown = []
    try {
      parsedCaps = JSON.parse(decodeURIComponent(capabilitiesRaw))
    } catch {
      try { parsedCaps = JSON.parse(capabilitiesRaw) } catch { parsedCaps = [] }
    }
    const capabilities = validateCapabilities(parsedCaps)

    // Register agent connection
    const agent: ConnectedAgent = {
      ws,
      agentId,
      apiKeyOwner,
      hostname,
      ide,
      platform,
      capabilities,
      status: 'idle',
      connectedAt: new Date(),
      lastPing: new Date(),
    }
    agents.set(agentId, agent)

    // Broadcast agent online to same-owner agents (exclude self)
    broadcastToOwner(
      apiKeyOwner,
      {
        type: 'agent.online',
        agentId,
        hostname,
        ide,
        capabilities,
        platform,
        timestamp: new Date().toISOString(),
      },
      agentId,
    )

    // Send welcome with current agent list
    ws.send(
      JSON.stringify({
        type: 'welcome',
        agentId,
        onlineAgents: getOnlineAgents(apiKeyOwner),
        timestamp: new Date().toISOString(),
      }),
    )

    console.log(`[ws] Agent connected: ${agentId} (${apiKeyOwner})`)

    // Re-push pending tasks: send the FIRST incomplete task assigned to this agent
    // Agent processes sequentially — only push one at a time, the rest stay queued on server
    const pendingTask = db.prepare(
      "SELECT id, title, description FROM conductor_tasks WHERE assigned_to_agent = ? AND status IN ('accepted', 'in_progress', 'pending', 'assigned') ORDER BY priority ASC, created_at ASC LIMIT 1"
    ).get(agentId) as { id: string; title: string; description: string } | undefined
    if (pendingTask) {
      ws.send(
        JSON.stringify({
          type: 'task.assigned',
          taskId: pendingTask.id,
          title: pendingTask.title,
          description: pendingTask.description,
          resumed: true,
          timestamp: new Date().toISOString(),
        }),
      )
      console.log(`[ws] Re-pushed task ${pendingTask.id} to reconnected agent ${agentId}`)
    }

    // Handle incoming messages
    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString())
        handleMessage(agent, msg)
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }))
      }
    })

    // Handle disconnect
    ws.on('close', () => {
      agents.delete(agentId)
      broadcastToOwner(apiKeyOwner, {
        type: 'agent.offline',
        agentId,
        timestamp: new Date().toISOString(),
      })
      console.log(`[ws] Agent disconnected: ${agentId}`)
    })

    // Ping/pong keepalive
    ws.on('pong', () => {
      agent.lastPing = new Date()
    })
  })

  // Keepalive interval: terminate stale connections, ping active ones
  setInterval(() => {
    for (const [id, agent] of agents) {
      if (Date.now() - agent.lastPing.getTime() > 60000) {
        agent.ws.terminate()
        agents.delete(id)
      } else {
        agent.ws.ping()
      }
    }
  }, 30000)

  return wss
}

function handleMessage(agent: ConnectedAgent, msg: Record<string, unknown>) {
  const type = msg['type'] as string | undefined

  switch (type) {
    case 'task.accept':
      db.prepare(
        'UPDATE conductor_tasks SET status = ?, accepted_at = datetime(?) WHERE id = ?',
      ).run('accepted', new Date().toISOString(), msg['taskId'] as string)
      broadcastToOwner(agent.apiKeyOwner, {
        type: 'task.accepted',
        taskId: msg['taskId'],
        agentId: agent.agentId,
        timestamp: new Date().toISOString(),
      })
      break

    case 'task.progress': {
      const taskId = msg['taskId'] as string
      const message = (msg['message'] as string || '').slice(0, 4000)
      // Persist to task logs (keep last 50 per task)
      if (taskId && message) {
        db.prepare(
          'INSERT INTO conductor_task_logs (task_id, agent_id, action, message) VALUES (?, ?, ?, ?)'
        ).run(taskId, agent.agentId, 'progress', message)
        // Prune old progress logs (keep last 50)
        db.prepare(
          "DELETE FROM conductor_task_logs WHERE task_id = ? AND action = 'progress' AND id NOT IN (SELECT id FROM conductor_task_logs WHERE task_id = ? AND action = 'progress' ORDER BY id DESC LIMIT 50)"
        ).run(taskId, taskId)
        // Update task status to in_progress if still accepted
        db.prepare(
          "UPDATE conductor_tasks SET status = 'in_progress' WHERE id = ? AND status = 'accepted'"
        ).run(taskId)
      }
      broadcastToOwner(agent.apiKeyOwner, {
        type: 'task.progress',
        taskId,
        agentId: agent.agentId,
        message,
        percent: msg['percent'],
        timestamp: new Date().toISOString(),
      })
      break
    }

    case 'task.complete': {
      const completedTaskId = msg['taskId'] as string
      if (!completedTaskId) break

      // Guard: skip if task is already in a terminal state (prevents double completion)
      const preCheck = db.prepare('SELECT status FROM conductor_tasks WHERE id = ?').get(completedTaskId) as { status: string } | undefined
      if (!preCheck || preCheck.status === 'completed' || preCheck.status === 'cancelled' || preCheck.status === 'approved') {
        console.warn(`[ws] task.complete: skipping ${completedTaskId} (already ${preCheck?.status ?? 'not found'})`)
        break
      }

      // Guard: block completion if task is awaiting user approval (strategy_review)
      if (preCheck.status === 'strategy_review') {
        console.warn(`[ws] task.complete: BLOCKED ${completedTaskId} — task is awaiting strategy approval, agent cannot complete`)
        agent.ws.send(JSON.stringify({
          type: 'error',
          message: `Cannot complete task ${completedTaskId}: strategy awaiting user approval`,
          taskId: completedTaskId,
          timestamp: new Date().toISOString(),
        }))
        break
      }

      db.prepare(
        'UPDATE conductor_tasks SET status = ?, result = ?, completed_at = datetime(?), completed_by = ? WHERE id = ? AND status NOT IN (?, ?, ?)',
      ).run(
        'completed',
        JSON.stringify(msg['result'] ?? {}),
        new Date().toISOString(),
        agent.agentId,
        completedTaskId,
        'completed', 'cancelled', 'approved',
      )
      broadcastToOwner(agent.apiKeyOwner, {
        type: 'task.completed',
        taskId: completedTaskId,
        agentId: agent.agentId,
        result: msg['result'],
        timestamp: new Date().toISOString(),
      })
      // Resolve dependency chain: unblock waiting tasks, notify, auto-complete parent
      const completedTask = db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(completedTaskId)
      if (completedTask) {
        try { resolveCompletionChain(completedTask as Parameters<typeof resolveCompletionChain>[0]) } catch (e) {
          console.error('[ws] resolveCompletionChain error:', e)
        }
      }

      // Auto-push next task: find the next incomplete NON-REVIEW task for this agent
      const nextTask = db.prepare(
        "SELECT id, title, description FROM conductor_tasks WHERE assigned_to_agent = ? AND status IN ('accepted', 'in_progress', 'pending', 'assigned') AND id != ? AND title NOT LIKE '[Review]%' AND title NOT LIKE 'Review:%' ORDER BY priority ASC, created_at ASC LIMIT 1"
      ).get(agent.agentId, completedTaskId) as { id: string; title: string; description: string } | undefined
      if (nextTask) {
        agent.ws.send(
          JSON.stringify({
            type: 'task.assigned',
            taskId: nextTask.id,
            title: nextTask.title,
            description: nextTask.description,
            autoNext: true,
            timestamp: new Date().toISOString(),
          }),
        )
        console.log(`[ws] Auto-pushed next task ${nextTask.id} to ${agent.agentId} after completing ${completedTaskId}`)
      }
      break
    }

    case 'agent.register': {
      // Handle registration message from cortex-agent.sh (capabilities + metadata)
      const regCaps = validateCapabilities(msg['capabilities'])
      if (regCaps.length > 0) agent.capabilities = regCaps
      if (msg['hostname']) agent.hostname = msg['hostname'] as string
      if (msg['ide']) agent.ide = msg['ide'] as string
      if (msg['platform'] || msg['os']) agent.platform = (msg['platform'] || msg['os']) as string
      broadcastToOwner(agent.apiKeyOwner, {
        type: 'agent.capabilities_updated',
        agentId: agent.agentId,
        capabilities: agent.capabilities,
        timestamp: new Date().toISOString(),
      }, agent.agentId)
      console.log(`[ws] Agent registered: ${agent.agentId} capabilities=[${agent.capabilities.join(',')}]`)
      break
    }

    case 'capabilities.update': {
      // Allow agents to update their capabilities at runtime (validated)
      const validated = validateCapabilities(msg['capabilities'])
      agent.capabilities = validated
      broadcastToOwner(agent.apiKeyOwner, {
        type: 'agent.capabilities_updated',
        agentId: agent.agentId,
        capabilities: validated,
        timestamp: new Date().toISOString(),
      }, agent.agentId)
      break
    }

    case 'status.update': {
      const newStatus = msg['status'] as string | undefined
      if (newStatus === 'idle' || newStatus === 'busy') {
        agent.status = newStatus
      }
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
        "SELECT COUNT(*) as total, AVG(score_total) as avgScore FROM quality_reports WHERE created_at > datetime('now', '-7 days')"
      ).get() as { total: number; avgScore: number | null } | undefined

      const taskStats = {
        total: tasks.length,
        completed: tasks.filter(t => t['status'] === 'completed').length,
        inProgress: tasks.filter(t => t['status'] === 'in_progress' || t['status'] === 'accepted').length,
        pending: tasks.filter(t => t['status'] === 'pending').length,
        failed: tasks.filter(t => t['status'] === 'failed').length,
      }

      const onlineAgents = getOnlineAgents(agent.apiKeyOwner)

      agent.ws.send(JSON.stringify({
        type: 'data.response',
        tasks,
        sessions,
        agents: onlineAgents,
        taskStats,
        quality: qualitySummary ?? { total: 0, avgScore: null },
        timestamp: new Date().toISOString(),
      }))
      break
    }

    case 'task.create': {
      // Create task via WebSocket (used by extension for review sub-tasks)
      const title = msg['title'] as string
      if (!title) break

      // Global rate limiter: max 5 tasks per agent per 60 seconds
      const recentCount = db.prepare(
        "SELECT COUNT(*) as c FROM conductor_tasks WHERE created_by_agent = ? AND created_at > datetime('now', '-60 seconds')"
      ).get(agent.agentId) as { c: number }
      if (recentCount.c >= 5) {
        console.warn(`[ws] task.create: RATE LIMITED ${agent.agentId} (${recentCount.c} tasks in last 60s)`)
        agent.ws.send(JSON.stringify({
          type: 'error',
          message: `Rate limited: too many tasks created (${recentCount.c}/5 per minute)`,
          timestamp: new Date().toISOString(),
        }))
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
          "SELECT id FROM conductor_tasks WHERE title LIKE '[Review]%' AND parent_task_id IS ? AND created_by_agent = ? AND created_at > datetime('now', '-300 seconds')"
        ).get(parentTaskId ?? null, agent.agentId) as { id: string } | undefined

        if (recentReview) {
          console.warn(`[ws] task.create: BLOCKED review spam "${title}" by ${agent.agentId} (existing: ${recentReview.id})`)
          agent.ws.send(JSON.stringify({
            type: 'task.created',
            taskId: recentReview.id,
            title,
            assignedTo: assignTo,
            parentTaskId,
            deduplicated: true,
            blocked: true,
            timestamp: new Date().toISOString(),
          }))
          break
        }
      }

      // Dedup: prevent creating duplicate tasks with same title+parent+agent within 30 seconds
      const recentDupe = db.prepare(
        "SELECT id FROM conductor_tasks WHERE title = ? AND parent_task_id IS ? AND created_by_agent = ? AND created_at > datetime('now', '-30 seconds')"
      ).get(title, parentTaskId ?? null, agent.agentId) as { id: string } | undefined

      if (recentDupe) {
        console.warn(`[ws] task.create: dedup hit for "${title}" by ${agent.agentId} (existing: ${recentDupe.id})`)
        agent.ws.send(JSON.stringify({
          type: 'task.created',
          taskId: recentDupe.id,
          title,
          assignedTo: assignTo,
          parentTaskId,
          deduplicated: true,
          timestamp: new Date().toISOString(),
        }))
        break
      }

      const newId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`

      db.prepare(`
        INSERT INTO conductor_tasks
          (id, title, description, priority, assigned_to_agent, created_by_agent,
           parent_task_id, context, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(newId, title, description, priority, assignTo ?? null, agent.agentId,
        parentTaskId ?? null, context, assignTo ? 'assigned' : 'pending')

      console.log(`[ws] task.create: ${newId} "${title}" by ${agent.agentId} → ${assignTo ?? 'unassigned'}`)

      // Push to assigned agent
      if (assignTo) {
        pushTaskToAgent(assignTo, newId, title, description)
      }

      // Confirm back to creator
      agent.ws.send(JSON.stringify({
        type: 'task.created',
        taskId: newId,
        title,
        assignedTo: assignTo,
        parentTaskId,
        timestamp: new Date().toISOString(),
      }))

      // Broadcast update
      broadcastToOwner(agent.apiKeyOwner, {
        type: 'task.assigned',
        taskId: newId,
        title,
        description,
        timestamp: new Date().toISOString(),
      }, assignTo ? undefined : agent.agentId)
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
        SET status = 'completed', completed_at = datetime('now'),
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
      const completedTask = db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(taskId)
      if (completedTask) {
        resolveCompletionChain(completedTask as Parameters<typeof resolveCompletionChain>[0])
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
      const target = agents.get(targetId)
      if (target && target.apiKeyOwner === agent.apiKeyOwner) {
        target.ws.send(
          JSON.stringify({
            type: 'message',
            from: agent.agentId,
            content: msg['content'],
            timestamp: new Date().toISOString(),
          }),
        )
      }
      break
    }
  }
}

/** Broadcast to all agents of same owner, optionally excluding one */
function broadcastToOwner(owner: string, msg: object, excludeId?: string) {
  const data = JSON.stringify(msg)
  for (const [id, agent] of agents) {
    if (
      agent.apiKeyOwner === owner &&
      id !== excludeId &&
      agent.ws.readyState === WebSocket.OPEN
    ) {
      agent.ws.send(data)
    }
  }
}

function getOnlineAgents(owner: string) {
  const result: Array<{ agentId: string; hostname?: string; ide?: string; capabilities: string[]; platform?: string }> = []
  for (const [, agent] of agents) {
    if (agent.apiKeyOwner === owner) {
      result.push({
        agentId: agent.agentId,
        hostname: agent.hostname,
        ide: agent.ide,
        capabilities: agent.capabilities,
        platform: agent.platform,
      })
    }
  }
  return result
}

/** Get ALL connected agents with capabilities (for dashboard API and orchestrator) */
export function getAllConnectedAgents() {
  const result: Array<{
    agentId: string
    apiKeyOwner: string
    hostname?: string
    ide?: string
    platform?: string
    capabilities: string[]
    status: 'idle' | 'busy'
    connectedAt: string
    lastPing: string
  }> = []
  for (const [, agent] of agents) {
    result.push({
      agentId: agent.agentId,
      apiKeyOwner: agent.apiKeyOwner,
      hostname: agent.hostname,
      ide: agent.ide,
      platform: agent.platform,
      capabilities: agent.capabilities,
      status: agent.status,
      connectedAt: agent.connectedAt.toISOString(),
      lastPing: agent.lastPing.toISOString(),
    })
  }
  return result
}

/** Push a task assignment notification to a connected agent. Returns true if delivered. */
export function notifyTaskAssigned(
  apiKeyOwner: string,
  taskId: string,
  title: string,
  assignedTo: string,
): boolean {
  const target = agents.get(assignedTo)
  if (target && target.apiKeyOwner === apiKeyOwner) {
    target.ws.send(
      JSON.stringify({
        type: 'task.assigned',
        taskId,
        title,
        timestamp: new Date().toISOString(),
      }),
    )
    return true // delivered instantly
  }
  return false // agent not connected
}

/** Push a task assignment notification to an agent by agentId, regardless of API key owner. */
export function pushTaskToAgent(
  assignedTo: string,
  taskId: string,
  title: string,
  description: string,
): boolean {
  console.log(`[ws] pushTaskToAgent: looking for "${assignedTo}" in ${agents.size} agents: [${[...agents.keys()].join(', ')}]`)
  for (const [id, agent] of agents) {
    if (id === assignedTo && agent.ws.readyState === WebSocket.OPEN) {
      agent.ws.send(
        JSON.stringify({
          type: 'task.assigned',
          taskId,
          title,
          description,
          timestamp: new Date().toISOString(),
        }),
      )
      console.log(`[ws] pushTaskToAgent: sent task.assigned to ${assignedTo}`)
      return true
    }
  }
  console.log(`[ws] pushTaskToAgent: agent "${assignedTo}" not found or WS not open`)
  return false
}

/** Notify specific agents about a task event via WebSocket */
export function notifyAgents(
  agentIds: string[],
  message: Record<string, unknown>,
): string[] {
  const notified: string[] = []
  for (const targetId of agentIds) {
    const agent = agents.get(targetId)
    if (agent && agent.ws.readyState === WebSocket.OPEN) {
      agent.ws.send(JSON.stringify(message))
      notified.push(targetId)
    }
  }
  return notified
}

/** Mark an agent as busy/idle */
/** Broadcast strategy ready event to all agents of the task's owner */
export function broadcastStrategyReady(taskId: string, title: string, strategy: unknown): void {
  // Broadcast to all owners (dashboard will pick it up)
  const data = JSON.stringify({
    type: 'task.strategy_ready',
    taskId,
    title,
    strategy,
    timestamp: new Date().toISOString(),
  })
  for (const [, agent] of agents) {
    if (agent.ws.readyState === WebSocket.OPEN) {
      agent.ws.send(data)
    }
  }
}

/** Broadcast a new comment to all connected agents (for real-time updates) */
export function broadcastComment(taskId: string, comment: {
  id: number; task_id: string; finding_id: string | null; agent_id: string | null
  comment: string; comment_type: string; created_at: string
}): void {
  const data = JSON.stringify({
    type: 'task.comment',
    taskId,
    comment,
    timestamp: new Date().toISOString(),
  })
  for (const [, agent] of agents) {
    if (agent.ws.readyState === WebSocket.OPEN) {
      agent.ws.send(data)
    }
  }
}

export function setAgentStatus(agentId: string, status: 'idle' | 'busy'): void {
  const agent = agents.get(agentId)
  if (agent) {
    agent.status = status
  }
}
