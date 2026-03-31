import WebSocket from 'ws'
import { EventEmitter } from 'node:events'
import type { CortexConfig } from './config.js'

export type ConnectionState = 'disconnected' | 'connecting' | 'connected'

export interface ConductorMessage {
  type: string
  [key: string]: unknown
}

/**
 * WebSocket client for Cortex Hub conductor.
 * Auto-reconnects on disconnect. Emits typed events for conductor messages.
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
      this.emit('error', new Error('No API key configured. Set cortex.apiKey or CORTEX_API_KEY env.'))
      return
    }

    this.intentionalClose = false
    this.setState('connecting')

    const capsEncoded = encodeURIComponent(JSON.stringify(this.config.capabilities))
    const url = `${this.config.hubUrl}/ws/conductor?apiKey=${this.config.apiKey}&agentId=${encodeURIComponent(this.config.agentId)}&capabilities=${capsEncoded}&ide=${this.config.ide}&platform=${encodeURIComponent(this.config.platform)}&hostname=${encodeURIComponent(require('os').hostname())}`

    this.ws = new WebSocket(url)

    this.ws.on('open', () => {
      this.reconnectDelay = 1000
      this.setState('connected')
      this.emit('connected')
    })

    this.ws.on('message', (data: Buffer) => {
      try {
        const msg: ConductorMessage = JSON.parse(data.toString())
        this.handleMessage(msg)
      } catch {
        // Ignore malformed messages
      }
    })

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.ws = null
      this.setState('disconnected')
      this.emit('disconnected', code, reason.toString())

      if (!this.intentionalClose) {
        this.scheduleReconnect()
      }
    })

    this.ws.on('error', (err: Error) => {
      this.emit('error', err)
      // close event will follow, which triggers reconnect
    })

    this.ws.on('ping', () => {
      this.ws?.pong()
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
