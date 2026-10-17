import WebSocket from 'ws'
import { EventEmitter } from 'node:events'
import { hostname } from 'node:os'
import type { CortexConfig } from './config.js'
import { conductorConnectUrl } from './mcp-config.js'

export type ConnectionState = 'disconnected' | 'connecting' | 'connected'

/** Close codes the hub sends on purpose; mirrors CLOSE_CODES in @cortex/shared-types. */
const CLOSE_CODES = { replaced: 4000, missingKey: 4001, badKey: 4003, agentIdInUse: 4009 } as const

export type StopReason = 'replaced' | 'missing-key' | 'bad-key' | 'agent-in-use'

/**
 * Codes after which reconnecting cannot help, as in the worker's hub-client: a newer connection
 * took this agent id (another window on this machine), the id is live on another machine, or the
 * key is missing or refused. Reconnecting after 4000 would take the id back from the other
 * window, which then does the same, so the two would flap forever.
 */
export function classifyClose(code: number): StopReason | null {
  switch (code) {
    case CLOSE_CODES.replaced:
      return 'replaced'
    case CLOSE_CODES.missingKey:
      return 'missing-key'
    case CLOSE_CODES.badKey:
      return 'bad-key'
    case CLOSE_CODES.agentIdInUse:
      return 'agent-in-use'
    default:
      return null
  }
}

export interface ConductorMessage {
  type: string
  [key: string]: unknown
}

/**
 * WebSocket client for Cortex Hub conductor.
 * Reconnects after a dropped connection, but not after a close in classifyClose: then it emits
 * 'stopped' (reason, code, text) and waits for connect(). Emits typed events for conductor messages.
 */
export class ConductorClient extends EventEmitter {
  private ws: WebSocket | null = null
  private config: CortexConfig
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 1000
  private maxReconnectDelay = 30000
  private intentionalClose = false

  state: ConnectionState = 'disconnected'

  constructor(config: CortexConfig) {
    super()
    this.config = config
  }

  /** Update config (e.g. after settings change) */
  updateConfig(config: CortexConfig): void {
    this.config = config
  }

  /** Connect to the conductor WebSocket */
  connect(): void {
    if (this.state === 'connecting' || this.state === 'connected') return
    if (!this.config.apiKey) {
      this.emit('error', new Error('No API key configured. Set one in the Agent Panel, cortexHub.apiKey or CORTEX_API_KEY.'))
      return
    }

    this.intentionalClose = false
    this.setState('connecting')

    const url = conductorConnectUrl(this.config.hubUrl, {
      apiKey: this.config.apiKey,
      agentId: this.config.agentId,
      capabilities: this.config.capabilities,
      ide: this.config.ide,
      platform: this.config.platform,
      hostname: hostname(),
    })

    // reconnect() and disconnect() drop the socket before its close event arrives. Events from a
    // socket that is no longer this.ws are ignored: a late close would otherwise clear the new
    // socket and open a third, which the hub then closes with 4000 as a duplicate.
    const socket = new WebSocket(url)
    this.ws = socket

    socket.on('open', () => {
      if (this.ws !== socket) return
      this.reconnectDelay = 1000
      this.setState('connected')
      this.emit('connected')
    })

    socket.on('message', (data: Buffer) => {
      if (this.ws !== socket) return
      try {
        const raw = data.toString()
        const msg: ConductorMessage = JSON.parse(raw)
        console.log(`[WS] recv: type=${msg.type}`)
        this.handleMessage(msg)
      } catch (e) {
        console.log(`[WS] message parse error: ${e}`)
      }
    })

    socket.on('close', (code: number, reason: Buffer) => {
      if (this.ws !== socket) return
      this.ws = null
      this.setState('disconnected')
      const text = reason.toString()
      this.emit('disconnected', code, text)

      if (this.intentionalClose) return
      const stop = classifyClose(code)
      if (stop) {
        this.clearReconnect()
        this.emit('stopped', stop, code, text)
        return
      }
      this.scheduleReconnect()
    })

    socket.on('error', (err: Error) => {
      if (this.ws !== socket) return
      this.emit('error', err)
      // close event will follow, which triggers reconnect
    })

    socket.on('ping', () => {
      if (this.ws === socket) socket.pong()
    })
  }

  /** Disconnect from conductor */
  disconnect(): void {
    this.intentionalClose = true
    this.clearReconnect()
    if (this.ws) {
      this.ws.close(1000, 'Extension disconnecting')
      this.ws = null
    }
    this.setState('disconnected')
  }

  /** Send a message to the conductor */
  send(msg: ConductorMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  /** Send task acceptance */
  acceptTask(taskId: string): void {
    this.send({ type: 'task.accept', taskId })
  }

  /** Send task progress update */
  reportProgress(taskId: string, message: string, percent?: number): void {
    this.send({ type: 'task.progress', taskId, message, percent })
  }

  /** Send task completion */
  completeTask(taskId: string, result?: unknown): void {
    this.send({ type: 'task.complete', taskId, result })
  }

  /** Send status update (idle/busy) */
  updateStatus(status: 'idle' | 'busy'): void {
    this.send({ type: 'status.update', status })
  }

  /** Send capabilities update */
  sendCapabilitiesUpdate(capabilities: string[]): void {
    this.send({ type: 'capabilities.update', capabilities })
  }

  /** Force reconnect (e.g. after agent rename) */
  reconnect(): void {
    this.intentionalClose = true
    this.clearReconnect()
    if (this.ws) {
      this.ws.close(1000, 'Reconnecting with new identity')
      this.ws = null
    }
    this.setState('disconnected')
    this.intentionalClose = false
    this.connect()
  }

  private handleMessage(msg: ConductorMessage): void {
    // Emit typed events matching conductor protocol
    switch (msg.type) {
      case 'welcome':
        this.emit('welcome', msg)
        break
      case 'task.assigned':
        this.emit('task.assigned', msg)
        break
      case 'task.accepted':
        this.emit('task.accepted', msg)
        break
      case 'task.progress':
        this.emit('task.progress', msg)
        break
      case 'task.completed':
        this.emit('task.completed', msg)
        break
      case 'agent.online':
        this.emit('agent.online', msg)
        break
      case 'agent.offline':
        this.emit('agent.offline', msg)
        break
      case 'agent.capabilities_updated':
        this.emit('agent.capabilities_updated', msg)
        break
      case 'data.response':
        this.emit('data.response', msg)
        break
      case 'message':
        this.emit('agent.message', msg)
        break
      default:
        this.emit('unknown', msg)
    }
  }

  private setState(state: ConnectionState): void {
    this.state = state
    this.emit('stateChange', state)
  }

  private scheduleReconnect(): void {
    this.clearReconnect()
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, this.reconnectDelay)
    // Exponential backoff with jitter
    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2 + Math.random() * 500,
      this.maxReconnectDelay,
    )
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  dispose(): void {
    this.disconnect()
    this.removeAllListeners()
  }
}
