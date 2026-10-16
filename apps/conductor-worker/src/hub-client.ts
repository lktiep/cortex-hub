// The worker's WebSocket to the hub (spec §6.5, §6.12): connect with the key in
// the query and the Authorization header, send `worker.register` on open, and
// reconnect with jittered backoff until a close code says to stop. Outcomes
// (accept, complete, quota, decline) wait in memory for the next `registered`;
// progress is best effort and dropped while not registered.
import type { ClientRequest, IncomingMessage } from 'node:http'
import {
  CLOSE_CODES,
  CONDUCTOR_PROTOCOL_VERSION,
  type HubToWorkerMsg,
  type RegisteredMsg,
  type TaskAcceptMsg,
  type TaskCompleteMsg,
  type TaskDeclineMsg,
  type TaskQuotaExhaustedMsg,
  type WorkerRegisterMsg,
  type WorkerToHubMsg,
} from '@cortex/shared-types'
import { WebSocket, type RawData } from 'ws'
import type { Logger } from './logger.js'

export type FatalReason = 'missing-key' | 'bad-key' | 'replaced' | 'agent-in-use'
export type ReliableMsg = TaskAcceptMsg | TaskCompleteMsg | TaskQuotaExhaustedMsg | TaskDeclineMsg
type TaskMsg = Exclude<HubToWorkerMsg, RegisteredMsg>

const HANDSHAKE_TIMEOUT_MS = 15_000
const REGISTER_TIMEOUT_MS = 15_000
const STOP_TIMEOUT_MS = 2_000
const DEFAULT_PING_MS = 30_000
const DEFAULT_BACKOFF = { baseMs: 1_000, maxMs: 60_000 }
/** Pings in a row without a pong before the socket is given up. */
const MISSED_PONGS_LIMIT = 2

/** The close codes after which reconnecting cannot help; null for every other code. */
export function classifyClose(code: number): FatalReason | null {
  switch (code) {
    case CLOSE_CODES.missingKey:
      return 'missing-key'
    case CLOSE_CODES.badKey:
      return 'bad-key'
    case CLOSE_CODES.replaced:
      return 'replaced'
    case CLOSE_CODES.agentIdInUse:
      return 'agent-in-use'
    default:
      return null
  }
}

/** `baseMs · 2^attempt`, capped at `maxMs`, then ±20 % jitter so workers do not reconnect in step. */
export function backoffDelay(
  attempt: number,
  baseMs = DEFAULT_BACKOFF.baseMs,
  maxMs = DEFAULT_BACKOFF.maxMs,
  rand: () => number = Math.random,
): number {
  const nominal = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 30))
  return Math.round(nominal * (0.8 + 0.4 * rand()))
}

/** The hub URL with the key, agent id, hostname and protocol version in the query. */
export function buildWsUrl(
  wsUrl: string,
  q: { apiKey: string; agentId: string; hostname: string },
): string {
  const url = new URL(wsUrl)
  url.searchParams.set('apiKey', q.apiKey)
  url.searchParams.set('agentId', q.agentId)
  url.searchParams.set('hostname', q.hostname)
  url.searchParams.set('protocol', String(CONDUCTOR_PROTOCOL_VERSION))
  return url.toString()
}

export interface HubClientOptions {
  wsUrl: string
  apiKey: string
  agentId: string
  hostname: string
  /** Rebuilt on every connect, so `activeTaskId` is current. */
  register: () => WorkerRegisterMsg
  onRegistered: (m: RegisteredMsg) => void
  onMessage: (m: TaskMsg) => void
  onFatal: (reason: FatalReason, detail: string) => void
  logger: Logger
  pingMs?: number
  backoff?: { baseMs: number; maxMs: number }
}

type Timer = ReturnType<typeof setTimeout>

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class HubClient {
  private readonly opts: HubClientOptions
  private readonly url: string
  private readonly pingMs: number
  private readonly backoff: { baseMs: number; maxMs: number }
  /** The current socket; events from any other socket are ignored. */
  private ws: WebSocket | null = null
  private isRegistered = false
  /** Set by `stop()` and by a fatal close: nothing reconnects after it. */
  private stopped = false
  /** Reconnects since the last `registered`. */
  private attempt = 0
  private missedPongs = 0
  private lastError: string | null = null
  private reconnectTimer: Timer | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private registerTimer: Timer | null = null
  private readonly queue: ReliableMsg[] = []

  constructor(opts: HubClientOptions) {
    this.opts = opts
    opts.logger.addSecret(opts.apiKey)
    this.url = buildWsUrl(opts.wsUrl, opts)
    this.pingMs = opts.pingMs ?? DEFAULT_PING_MS
    this.backoff = opts.backoff ?? DEFAULT_BACKOFF
  }

  get registered(): boolean {
    return this.isRegistered
  }

  start(): void {
    if (this.stopped || this.ws !== null || this.reconnectTimer !== null) return
    this.connect()
  }

  /** Sends when registered and open; otherwise drops the message and returns false. */
  send(msg: WorkerToHubMsg): boolean {
    const ws = this.ws
    if (this.stopped || !this.isRegistered || ws === null || ws.readyState !== WebSocket.OPEN) {
      return false
    }
    ws.send(JSON.stringify(msg))
    return true
  }

  /** Sends now when registered and open; otherwise queues until the next `registered`. */
  sendReliable(msg: ReliableMsg): void {
    if (this.stopped) return
    if (!this.send(msg)) this.queue.push(msg)
  }

  /** Closes with 1000; resolves on close, or terminates the socket after 2 s. */
  async stop(): Promise<void> {
    this.stopped = true
    this.queue.length = 0
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    const ws = this.ws
    this.detach()
    if (ws === null || ws.readyState === WebSocket.CLOSED) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        ws.terminate()
        resolve()
      }, STOP_TIMEOUT_MS)
      ws.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      ws.close(1000, 'worker stopping')
    })
  }

  private connect(): void {
    this.reconnectTimer = null
    if (this.stopped) return
    this.lastError = null
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url, {
        headers: { Authorization: `Bearer ${this.opts.apiKey}` },
        handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      })
    } catch (err) {
      this.opts.logger.error(`cannot open the hub connection: ${errorText(err)}`)
      this.scheduleReconnect('could not connect')
      return
    }
    this.ws = ws
    // always listened to: an unhandled 'error' would crash the process
    ws.on('error', (err) => {
      if (this.ws === ws) this.lastError = err.message
    })
    ws.on('unexpected-response', (_req: ClientRequest, res: IncomingMessage) => {
      if (this.ws === ws) this.onHttpRefusal(ws, res.statusCode ?? 0)
    })
    ws.on('open', () => {
      if (this.ws === ws) this.onOpen(ws)
    })
    ws.on('message', (data: RawData) => {
      if (this.ws === ws) this.onFrame(ws, data)
    })
    ws.on('pong', () => {
      if (this.ws === ws) this.missedPongs = 0
    })
    ws.on('close', (code: number, reason: Buffer) => {
      if (this.ws === ws) this.onClose(code, reason.toString())
    })
  }

  private onOpen(ws: WebSocket): void {
    this.missedPongs = 0
    this.pingTimer = setInterval(() => this.ping(ws), this.pingMs)
    this.registerTimer = setTimeout(() => {
      this.registerTimer = null
      this.opts.logger.warn(
        `the hub did not answer worker.register within ${REGISTER_TIMEOUT_MS / 1000} s; ` +
          `it may predate protocol ${CONDUCTOR_PROTOCOL_VERSION}. Run \`cortex-worker doctor\` to check it.`,
      )
    }, REGISTER_TIMEOUT_MS)
    let msg: WorkerRegisterMsg
    try {
      msg = this.opts.register()
    } catch (err) {
      this.opts.logger.error(`could not build worker.register: ${errorText(err)}`)
      ws.terminate()
      return
    }
    ws.send(JSON.stringify(msg))
  }

  private ping(ws: WebSocket): void {
    if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return
    if (this.missedPongs >= MISSED_PONGS_LIMIT) {
      this.opts.logger.warn(
        `the hub did not answer pings for ${(MISSED_PONGS_LIMIT * this.pingMs) / 1000} s; dropping the connection`,
      )
      // the close handler reconnects
      ws.terminate()
      return
    }
    this.missedPongs++
    ws.ping()
  }

  private onFrame(ws: WebSocket, data: RawData): void {
    let msg: unknown
    try {
      msg = JSON.parse(data.toString())
    } catch {
      this.opts.logger.warn('ignored a hub frame that is not JSON')
      return
    }
    if (!isRecord(msg) || typeof msg['type'] !== 'string') {
      this.opts.logger.warn('ignored a hub frame that is not an object with a string type')
      return
    }
    switch (msg['type']) {
      case 'registered':
        this.onRegistered(ws, msg as unknown as RegisteredMsg)
        return
      case 'task.assigned':
      case 'task.resumed':
      case 'task.revoked':
        this.callback('onMessage', () => this.opts.onMessage(msg as unknown as TaskMsg))
        return
      case 'error':
        this.opts.logger.warn(`hub error: ${String(msg['message'])}`)
        return
      default:
        // welcome, agent.online/offline, task.created, message, … are for other clients
        return
    }
  }

  private onRegistered(ws: WebSocket, msg: RegisteredMsg): void {
    this.isRegistered = true
    this.attempt = 0
    if (this.registerTimer !== null) clearTimeout(this.registerTimer)
    this.registerTimer = null
    for (const queued of this.queue.splice(0)) ws.send(JSON.stringify(queued))
    this.callback('onRegistered', () => this.opts.onRegistered(msg))
  }

  /** A handshake refused with an HTTP status: 401/403 is a bad key, anything else is retried. */
  private onHttpRefusal(ws: WebSocket, status: number): void {
    this.detach()
    if (status === 401 || status === 403) {
      this.fatal('bad-key', `HTTP ${status}`, `the hub refused the key (HTTP ${status})`)
    } else {
      this.scheduleReconnect(`the hub refused the WebSocket handshake (HTTP ${status})`)
    }
    // the listener leaves the request to us; the socket's own error and close events are ignored now
    ws.terminate()
  }

  private onClose(code: number, reason: string): void {
    const error = this.lastError
    this.detach()
    const fatal = classifyClose(code)
    if (fatal !== null) {
      const line = `the hub closed the connection (code ${code}${reason ? `: ${reason}` : ''})`
      this.fatal(fatal, reason || `close code ${code}`, line)
      return
    }
    const detail = [reason, error].filter((s) => s !== null && s !== '').join(', ')
    this.scheduleReconnect(`hub connection closed (code ${code}${detail ? `: ${detail}` : ''})`)
  }

  private fatal(reason: FatalReason, detail: string, line: string): void {
    this.stopped = true
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.opts.logger.error(`${line}; not reconnecting (${reason})`)
    this.callback('onFatal', () => this.opts.onFatal(reason, detail))
  }

  /** Forgets the current socket and its timers. */
  private detach(): void {
    this.ws = null
    this.isRegistered = false
    if (this.pingTimer !== null) clearInterval(this.pingTimer)
    this.pingTimer = null
    if (this.registerTimer !== null) clearTimeout(this.registerTimer)
    this.registerTimer = null
  }

  /** At most one reconnect timer at a time. */
  private scheduleReconnect(why: string): void {
    if (this.stopped || this.reconnectTimer !== null) return
    const delay = backoffDelay(this.attempt, this.backoff.baseMs, this.backoff.maxMs)
    this.attempt++
    this.opts.logger.warn(`${why}; reconnecting in ${delay} ms`)
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
  }

  /** A throwing handler is logged, never allowed to take the socket's event loop down. */
  private callback(name: string, fn: () => void): void {
    try {
      fn()
    } catch (err) {
      this.opts.logger.error(`${name} threw: ${errorText(err)}`)
    }
  }
}
