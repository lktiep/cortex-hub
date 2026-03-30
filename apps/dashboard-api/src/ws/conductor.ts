import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'http'
import type { Server } from 'http'
import { createHash } from 'node:crypto'
import { db } from '../db/client.js'

interface ConnectedAgent {
  ws: WebSocket
  agentId: string
  apiKeyOwner: string
  hostname?: string
  ide?: string
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

    // Register agent connection
    const agent: ConnectedAgent = {
      ws,
      agentId,
      apiKeyOwner,
      hostname,
      ide,
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

    case 'task.progress':
      broadcastToOwner(agent.apiKeyOwner, {
        type: 'task.progress',
        taskId: msg['taskId'],
        agentId: agent.agentId,
        message: msg['message'],
        percent: msg['percent'],
        timestamp: new Date().toISOString(),
      })
      break

    case 'task.complete':
      db.prepare(
        'UPDATE conductor_tasks SET status = ?, result = ?, completed_at = datetime(?), completed_by = ? WHERE id = ?',
      ).run(
        'completed',
        JSON.stringify(msg['result'] ?? {}),
        new Date().toISOString(),
        agent.agentId,
        msg['taskId'] as string,
      )
      broadcastToOwner(agent.apiKeyOwner, {
        type: 'task.completed',
        taskId: msg['taskId'],
        agentId: agent.agentId,
        result: msg['result'],
        timestamp: new Date().toISOString(),
      })
      break

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
  const result: Array<{ agentId: string; hostname?: string; ide?: string }> = []
  for (const [, agent] of agents) {
    if (agent.apiKeyOwner === owner) {
      result.push({ agentId: agent.agentId, hostname: agent.hostname, ide: agent.ide })
    }
  }
  return result
}

/** Get ALL connected agents (for dashboard API) */
export function getAllConnectedAgents() {
  const result: Array<{
    agentId: string
    apiKeyOwner: string
    hostname?: string
    ide?: string
    connectedAt: string
    lastPing: string
  }> = []
  for (const [, agent] of agents) {
    result.push({
      agentId: agent.agentId,
      apiKeyOwner: agent.apiKeyOwner,
      hostname: agent.hostname,
      ide: agent.ide,
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
