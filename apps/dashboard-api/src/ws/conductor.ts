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
      db.prepare(
        'UPDATE conductor_tasks SET status = ?, result = ?, completed_at = datetime(?), completed_by = ? WHERE id = ?',
      ).run(
        'completed',
        JSON.stringify(msg['result'] ?? {}),
        new Date().toISOString(),
        agent.agentId,
        completedTaskId,
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
      return true
    }
  }
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
export function setAgentStatus(agentId: string, status: 'idle' | 'busy'): void {
  const agent = agents.get(agentId)
  if (agent) {
    agent.status = status
  }
}
