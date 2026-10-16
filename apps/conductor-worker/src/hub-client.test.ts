import type { IncomingMessage } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import {
  CLOSE_CODES,
  CONDUCTOR_PROTOCOL_VERSION,
  type AssignedTask,
  type HubToWorkerMsg,
  type RegisteredMsg,
  type TaskAcceptMsg,
  type TaskAssignedMsg,
  type TaskCompleteMsg,
  type TaskDeclineMsg,
  type TaskProgressMsg,
  type TaskQuotaExhaustedMsg,
  type TaskRevokedMsg,
  type WorkerRegisterMsg,
} from '@cortex/shared-types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import {
  HubClient,
  backoffDelay,
  buildWsUrl,
  classifyClose,
  type FatalReason,
  type HubClientOptions,
} from './hub-client.js'
import type { Logger } from './logger.js'

const KEY = 'k-test-0123'
// captured before any test fakes the timers
const realSetTimeout = globalThis.setTimeout

function realDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    realSetTimeout(resolve, ms)
  })
}

/** Polls on real timers (vi.waitFor would advance fake ones). */
async function until(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!cond()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await realDelay(5)
  }
}

/** Only the timer functions: the sockets keep running on real time. */
function fakeTimers(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
}

// ── fixtures ──

const task: AssignedTask = {
  id: 't-1',
  key: 'K-1',
  title: 'Title',
  description: 'Description',
  context: {},
  files: [],
  branch: 'task/k-1',
  baseBranch: 'main',
  route: { executor: null, model: null, effort: null },
  attempt: 1,
  leaseExpiresAt: '2026-10-16T00:00:00Z',
  reviews: [],
  handoff: null,
  testCommand: null,
}

function assigned(type: TaskAssignedMsg['type']): TaskAssignedMsg {
  return { type, task, taskId: task.id, title: task.title, description: task.description }
}

function revoked(taskId: string): TaskRevokedMsg {
  return { type: 'task.revoked', taskId, reason: 'reclaimed' }
}

function registered(conn: number): RegisteredMsg {
  return {
    type: 'registered',
    connectionId: `c-${conn}`,
    projectId: null,
    hubVersion: '0.0.0-test',
  }
}

function registerMsg(n: number): WorkerRegisterMsg {
  return {
    type: 'worker.register',
    protocol: CONDUCTOR_PROTOCOL_VERSION,
    version: '0.0.0-test',
    hostname: 'host-1',
    os: 'linux',
    repo: 'https://example.invalid/repo.git',
    capabilities: [],
    engines: [],
    defaultExecutor: null,
    activeTaskId: `t-${n}`,
  }
}

const progress = (message: string): TaskProgressMsg => ({
  type: 'task.progress',
  taskId: 't-1',
  message,
})
const accept = (taskId: string): TaskAcceptMsg => ({ type: 'task.accept', taskId })
const complete = (taskId: string): TaskCompleteMsg => ({
  type: 'task.complete',
  taskId,
  status: 'completed',
  result: { summary: 'done' },
  attempt: 1,
})
const decline = (taskId: string): TaskDeclineMsg => ({
  type: 'task.decline',
  taskId,
  reason: 'busy',
})
const quota = (taskId: string): TaskQuotaExhaustedMsg => ({
  type: 'task.quota_exhausted',
  taskId,
  executor: 'agy',
  model: 'm',
  raw: 'quota',
  handoff: { branch: 'task/k-1', commit: null, note: 'wip' },
})

// ── a hub on port 0 ──

type Frame = Record<string, unknown>

interface HubBehavior {
  autoPong?: boolean
  /** Compress every frame the hub sends, so the client inflates them asynchronously. */
  perMessageDeflate?: boolean
  /** An HTTP status to refuse the n-th handshake (1-based) with, or null to accept it. */
  reject?: (handshake: number) => number | null
  onConnection?: (ws: WebSocket, conn: number) => void
  /** Every frame from a worker; by default `worker.register` is answered with `registered`. */
  onFrame?: (ws: WebSocket, msg: Frame, conn: number) => void
  onPing?: (ws: WebSocket, conn: number, count: number) => void
}

interface TestHub {
  url: string
  handshakes: number
  connections: WebSocket[]
  requests: IncomingMessage[]
  /** Frames received, per connection. */
  frames: Frame[][]
  pings: number[]
  closes: Array<{ code: number; reason: string } | undefined>
  close(): Promise<void>
}

const hubs: TestHub[] = []

function answerRegister(ws: WebSocket, msg: Frame, conn: number): void {
  if (msg['type'] === 'worker.register') ws.send(JSON.stringify(registered(conn)))
}

async function startHub(behavior: HubBehavior = {}): Promise<TestHub> {
  const onFrame = behavior.onFrame ?? answerRegister
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    autoPong: behavior.autoPong ?? true,
    perMessageDeflate: behavior.perMessageDeflate === true ? { threshold: 0 } : false,
    verifyClient: (_info, cb) => {
      hub.handshakes++
      const status = behavior.reject?.(hub.handshakes) ?? null
      if (status === null) cb(true)
      else cb(false, status, 'Rejected')
    },
  })
  const hub: TestHub = {
    url: '',
    handshakes: 0,
    connections: [],
    requests: [],
    frames: [],
    pings: [],
    closes: [],
    close: async () => {
      for (const ws of wss.clients) ws.terminate()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
  hub.url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/ws/conductor`
  wss.on('connection', (ws, req) => {
    const conn = hub.connections.length
    hub.connections.push(ws)
    hub.requests.push(req)
    hub.frames.push([])
    hub.pings.push(0)
    hub.closes.push(undefined)
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as Frame
      hub.frames[conn]?.push(msg)
      onFrame(ws, msg, conn)
    })
    ws.on('ping', () => {
      const count = (hub.pings[conn] ?? 0) + 1
      hub.pings[conn] = count
      behavior.onPing?.(ws, conn, count)
    })
    ws.on('close', (code, reason) => {
      hub.closes[conn] = { code, reason: reason.toString() }
    })
    behavior.onConnection?.(ws, conn)
  })
  hubs.push(hub)
  return hub
}

function socketOf(hub: TestHub, conn: number): WebSocket {
  const ws = hub.connections[conn]
  if (ws === undefined) throw new Error(`no connection ${conn}`)
  return ws
}

function framesOf(hub: TestHub, conn: number): Frame[] {
  return hub.frames[conn] ?? []
}

// ── a client with recording callbacks ──

interface LogLine {
  level: 'info' | 'warn' | 'error'
  m: string
}

const allLines: LogLine[] = []
const clients: HubClient[] = []

function recordingLogger() {
  const lines: LogLine[] = []
  const push = (level: LogLine['level'], m: string): void => {
    lines.push({ level, m })
    allLines.push({ level, m })
  }
  const logger: Logger & { addSecret: ReturnType<typeof vi.fn> } = {
    info: (m) => push('info', m),
    warn: (m) => push('warn', m),
    error: (m) => push('error', m),
    addSecret: vi.fn(),
  }
  return { logger, lines, warns: () => lines.filter((l) => l.level === 'warn').map((l) => l.m) }
}

type Log = ReturnType<typeof recordingLogger>

function reconnectDelays(log: Log): number[] {
  return log.lines.flatMap((l) => {
    const m = /reconnecting in (\d+) ms/.exec(l.m)
    return m ? [Number(m[1])] : []
  })
}

function makeClient(hub: TestHub, over: Partial<HubClientOptions> = {}) {
  const log = recordingLogger()
  const events = {
    registers: 0,
    registered: [] as RegisteredMsg[],
    messages: [] as Exclude<HubToWorkerMsg, RegisteredMsg>[],
    fatal: [] as Array<[FatalReason, string]>,
  }
  const client = new HubClient({
    wsUrl: hub.url,
    apiKey: KEY,
    agentId: 'agent-1',
    hostname: 'host-1',
    register: () => {
      events.registers++
      return registerMsg(events.registers)
    },
    onRegistered: (m) => events.registered.push(m),
    onMessage: (m) => events.messages.push(m),
    onFatal: (reason, detail) => events.fatal.push([reason, detail]),
    logger: log.logger,
    backoff: { baseMs: 10, maxMs: 40 },
    ...over,
  })
  clients.push(client)
  return { client, log, events }
}

afterEach(async () => {
  // real timers first: if a fake-timer test failed half way, stop()'s 2 s terminate
  // timer must still fire, or the hang would hide the real failure
  vi.useRealTimers()
  await Promise.all(clients.splice(0).map((c) => c.stop()))
  await Promise.all(hubs.splice(0).map((h) => h.close()))
  vi.restoreAllMocks()
  // no log line carries the key or the raw URL
  const leaked = allLines.splice(0).filter((l) => l.m.includes(KEY) || /apikey=/i.test(l.m))
  expect(leaked).toEqual([])
})

// ── pure helpers ──

describe('classifyClose', () => {
  it('maps the hub close codes to fatal reasons', () => {
    expect(classifyClose(CLOSE_CODES.missingKey)).toBe('missing-key')
    expect(classifyClose(CLOSE_CODES.badKey)).toBe('bad-key')
    expect(classifyClose(CLOSE_CODES.replaced)).toBe('replaced')
    expect(classifyClose(CLOSE_CODES.agentIdInUse)).toBe('agent-in-use')
  })

  it('returns null for every other code', () => {
    for (const code of [1000, 1001, 1005, 1006, 1011, 4002, 4004, 4999]) {
      expect(classifyClose(code)).toBeNull()
    }
  })
})

describe('backoffDelay', () => {
  it('backoffDelay doubles, caps at 60 s and stays within ±20 %', () => {
    const mid = (): number => 0.5
    expect([0, 1, 2, 3, 4, 5].map((n) => backoffDelay(n, undefined, undefined, mid))).toEqual([
      1000, 2000, 4000, 8000, 16_000, 32_000,
    ])
    expect(backoffDelay(6, undefined, undefined, mid)).toBe(60_000)
    expect(backoffDelay(50, undefined, undefined, mid)).toBe(60_000)
    expect(backoffDelay(5000, undefined, undefined, mid)).toBe(60_000)

    expect(backoffDelay(0, undefined, undefined, () => 0)).toBe(800)
    expect(backoffDelay(0, undefined, undefined, () => 0.999_999)).toBeLessThanOrEqual(1200)
    expect(backoffDelay(0, undefined, undefined, () => 0.999_999)).toBeGreaterThan(1190)
    expect(backoffDelay(20, undefined, undefined, () => 0)).toBe(48_000)
    expect(backoffDelay(20, undefined, undefined, () => 0.999_999)).toBeLessThanOrEqual(72_000)

    for (let i = 0; i < 200; i++) {
      const d = backoffDelay(3)
      expect(d).toBeGreaterThanOrEqual(6400)
      expect(d).toBeLessThanOrEqual(9600)
    }
  })

  it('takes a custom base and cap', () => {
    const mid = (): number => 0.5
    expect(backoffDelay(0, 10, 40, mid)).toBe(10)
    expect(backoffDelay(1, 10, 40, mid)).toBe(20)
    expect(backoffDelay(3, 10, 40, mid)).toBe(40)
  })
})

describe('buildWsUrl', () => {
  it('appends apiKey, agentId, hostname and the protocol version, keeping the path', () => {
    const url = new URL(
      buildWsUrl('wss://hub.example.invalid/ws/conductor', {
        apiKey: KEY,
        agentId: 'agent 1',
        hostname: 'host&1',
      }),
    )
    expect(url.protocol).toBe('wss:')
    expect(url.pathname).toBe('/ws/conductor')
    expect(url.searchParams.get('apiKey')).toBe(KEY)
    expect(url.searchParams.get('agentId')).toBe('agent 1')
    expect(url.searchParams.get('hostname')).toBe('host&1')
    expect(url.searchParams.get('protocol')).toBe(String(CONDUCTOR_PROTOCOL_VERSION))
  })

  const q = { apiKey: KEY, agentId: 'agent-1', hostname: 'host-1' }

  it('accepts ws:// and wss:// in any case', () => {
    expect(new URL(buildWsUrl('ws://127.0.0.1:8318/ws/conductor', q)).protocol).toBe('ws:')
    expect(new URL(buildWsUrl('WSS://hub.example.invalid/ws/conductor', q)).protocol).toBe('wss:')
  })

  it.each([
    ['http://hub.example.invalid/ws/conductor', 'http:'],
    ['https://hub.example.invalid/ws/conductor', 'https:'],
    ['ftp://hub.example.invalid/ws/conductor', 'ftp:'],
    ['file:///tmp/ws/conductor', 'file:'],
  ])('rejects %s', (wsUrl, scheme) => {
    expect(() => buildWsUrl(wsUrl, q)).toThrow(`hub URL must be ws:// or wss:// (got ${scheme})`)
  })

  it.each(['wss://hub.example.invalid/ws/conductor#x', 'wss://hub.example.invalid/ws/conductor#'])(
    'rejects a #fragment: %s',
    (wsUrl) => {
      expect(() => buildWsUrl(wsUrl, q)).toThrow('hub URL must not contain a #fragment')
    },
  )

  it('rejects a string that is not a URL', () => {
    expect(() => buildWsUrl('hub.example.invalid/ws/conductor', q)).toThrow(
      'hub URL is not a valid URL',
    )
  })
})

// ── the client against a live server ──

describe('HubClient', () => {
  it('sends worker.register with protocol 2 on open', async () => {
    const hub = await startHub()
    const { client, events } = makeClient(hub)
    expect(client.registered).toBe(false)
    client.start()
    await until(() => client.registered, 'registered')
    expect(events.registers).toBe(1)
    expect(framesOf(hub, 0)).toEqual([registerMsg(1)])
    expect(framesOf(hub, 0)[0]?.['protocol']).toBe(2)
    expect(events.registered).toEqual([registered(0)])
    // `registered` is handled by the client, never passed on
    expect(events.messages).toEqual([])
  })

  it('the url carries apiKey, agentId and hostname, and the Authorization header is set', async () => {
    const hub = await startHub()
    const { client, log } = makeClient(hub, { agentId: 'agent 1', hostname: 'host-1.local' })
    expect(log.logger.addSecret).toHaveBeenCalledWith(KEY)
    client.start()
    await until(() => client.registered, 'registered')
    const req = hub.requests[0]
    const url = new URL(req?.url ?? '', 'http://localhost')
    expect(url.pathname).toBe('/ws/conductor')
    expect(url.searchParams.get('apiKey')).toBe(KEY)
    expect(url.searchParams.get('agentId')).toBe('agent 1')
    expect(url.searchParams.get('hostname')).toBe('host-1.local')
    expect(url.searchParams.get('protocol')).toBe('2')
    expect(req?.headers.authorization).toBe(`Bearer ${KEY}`)
  })

  it('refuses an unusable hub URL once, when it is constructed', async () => {
    const hub = await startHub()
    const httpUrl = hub.url.replace(/^ws:/, 'http:')
    expect(() => makeClient(hub, { wsUrl: httpUrl })).toThrow(
      'hub URL must be ws:// or wss:// (got http:)',
    )
    expect(() => makeClient(hub, { wsUrl: `${hub.url}#x` })).toThrow(
      'hub URL must not contain a #fragment',
    )
    await realDelay(100)
    expect(hub.handshakes).toBe(0)
  })

  it('reconnects with backoff after a 1006 close and re-sends a fresh register', async () => {
    const hub = await startHub()
    const { client, log, events } = makeClient(hub)
    client.start()
    await until(() => client.registered, 'registered')
    socketOf(hub, 0).terminate()
    await until(() => events.registered.length === 2, 'registered again')
    expect(client.registered).toBe(true)
    expect(hub.connections).toHaveLength(2)
    expect(events.registers).toBe(2)
    expect(framesOf(hub, 1)).toEqual([registerMsg(2)])
    expect(framesOf(hub, 1)[0]?.['activeTaskId']).toBe('t-2')
    const delays = reconnectDelays(log)
    expect(delays).toHaveLength(1)
    expect(delays[0]).toBeGreaterThanOrEqual(8)
    expect(delays[0]).toBeLessThanOrEqual(12)
    expect(log.warns().some((m) => m.includes('1006'))).toBe(true)
    expect(events.fatal).toEqual([])
  })

  it('keeps backing off while the hub drops the socket before registered, and resets on registered', async () => {
    fakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const hub = await startHub({
      onFrame: (ws, msg, conn) => {
        if (msg['type'] !== 'worker.register') return
        if (conn === 3) ws.send(JSON.stringify(registered(conn)))
        ws.close(1011, 'going away')
      },
    })
    const { client, log, events } = makeClient(hub, { backoff: { baseMs: 1000, maxMs: 60_000 } })
    client.start()
    await until(() => reconnectDelays(log).length === 1, 'first drop')
    vi.advanceTimersByTime(1000)
    await until(() => reconnectDelays(log).length === 2, 'second drop')
    vi.advanceTimersByTime(2000)
    await until(() => reconnectDelays(log).length === 3, 'third drop')
    vi.advanceTimersByTime(4000)
    await until(() => reconnectDelays(log).length === 4, 'drop after registered')
    // opened three times without `registered`: still backing off; `registered` resets it
    expect(reconnectDelays(log)).toEqual([1000, 2000, 4000, 1000])
    expect(hub.connections).toHaveLength(4)
    expect(events.registered).toHaveLength(1)
  })

  it.each([
    ['agent-in-use', CLOSE_CODES.agentIdInUse, 'agent id in use on other-host'],
    ['replaced', CLOSE_CODES.replaced, 'replaced by a newer connection'],
    ['bad-key', CLOSE_CODES.badKey, 'key is scoped to another project'],
    ['missing-key', CLOSE_CODES.missingKey, 'Missing apiKey'],
  ] as const)('stops and reports %s on %i', async (reason, code, text) => {
    const hub = await startHub({
      onFrame: (ws, msg) => {
        if (msg['type'] === 'worker.register') ws.close(code, text)
      },
    })
    const { client, log, events } = makeClient(hub)
    client.start()
    await until(() => events.fatal.length === 1, 'fatal')
    expect(events.fatal).toEqual([[reason, text]])
    await realDelay(150)
    expect(hub.handshakes).toBe(1)
    expect(events.fatal).toHaveLength(1)
    expect(reconnectDelays(log)).toEqual([])
    expect(client.registered).toBe(false)
    expect(client.send(progress('after fatal'))).toBe(false)
  })

  it('a fatal close after registered stops the pings and never reconnects', async () => {
    fakeTimers()
    const pings = vi.spyOn(WebSocket.prototype, 'ping')
    const hub = await startHub()
    const { client, log, events } = makeClient(hub, { pingMs: 1000 })
    client.start()
    await until(() => client.registered, 'registered')
    vi.advanceTimersByTime(1000)
    await until(() => hub.pings[0] === 1, 'a ping while registered')
    expect(pings).toHaveBeenCalledTimes(1)

    socketOf(hub, 0).close(CLOSE_CODES.replaced, 'replaced')
    await until(() => events.fatal.length === 1, 'fatal')
    expect(client.registered).toBe(false)
    vi.advanceTimersByTime(3 * 1000)
    await realDelay(100)
    expect(pings).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(events.fatal).toEqual([['replaced', 'replaced']])
    expect(hub.handshakes).toBe(1)
    expect(reconnectDelays(log)).toEqual([])
  })

  it.each([401, 403])(
    'treats an HTTP %i handshake as bad-key and stops reconnecting',
    async (status) => {
      const hub = await startHub({ reject: () => status })
      const { client, log, events } = makeClient(hub)
      client.start()
      await until(() => events.fatal.length === 1, 'fatal')
      expect(events.fatal).toEqual([['bad-key', `HTTP ${status}`]])
      await realDelay(150)
      expect(hub.handshakes).toBe(1)
      expect(hub.connections).toEqual([])
      expect(reconnectDelays(log)).toEqual([])
    },
  )

  it('reconnects after another HTTP status, with a single reconnect timer', async () => {
    const hub = await startHub({ reject: (n) => (n === 1 ? 502 : null) })
    const { client, log, events } = makeClient(hub)
    client.start()
    await until(() => client.registered, 'registered')
    await realDelay(150)
    expect(hub.handshakes).toBe(2)
    expect(hub.connections).toHaveLength(1)
    expect(reconnectDelays(log)).toHaveLength(1)
    expect(log.warns().some((m) => m.includes('HTTP 502'))).toBe(true)
    expect(events.fatal).toEqual([])
  })

  it('queues reliable messages while disconnected and flushes them after registered, in order', async () => {
    fakeTimers()
    const hub = await startHub()
    let client: HubClient | null = null
    let registrations = 0
    const made = makeClient(hub, {
      backoff: { baseMs: 100, maxMs: 100 },
      // a send from onRegistered lands after the flushed queue
      onRegistered: () => {
        client?.send(progress(`registered-${registrations}`))
        registrations++
      },
    })
    client = made.client
    const { log } = made

    client.sendReliable(accept('t-1'))
    client.sendReliable(complete('t-1'))
    client.start()
    await until(() => framesOf(hub, 0).length === 4, 'flush on the first connection')
    expect(framesOf(hub, 0).map((f) => [f['type'], f['taskId'] ?? null])).toEqual([
      ['worker.register', null],
      ['task.accept', 't-1'],
      ['task.complete', 't-1'],
      ['task.progress', 't-1'],
    ])
    expect(framesOf(hub, 0)[3]?.['message']).toBe('registered-0')

    // registered and open: sent at once
    client.sendReliable(decline('t-2'))
    await until(() => framesOf(hub, 0).length === 5, 'immediate reliable send')
    expect(framesOf(hub, 0)[4]).toEqual(decline('t-2'))

    socketOf(hub, 0).terminate()
    await until(() => reconnectDelays(log).length === 1, 'drop noticed')
    expect(client.registered).toBe(false)
    client.sendReliable(quota('t-3'))
    client.sendReliable(complete('t-4'))
    vi.advanceTimersByTime(120)
    await until(() => framesOf(hub, 1).length === 4, 'flush on the second connection')
    expect(framesOf(hub, 1).map((f) => [f['type'], f['taskId'] ?? null])).toEqual([
      ['worker.register', null],
      ['task.quota_exhausted', 't-3'],
      ['task.complete', 't-4'],
      ['task.progress', 't-1'],
    ])
    expect(framesOf(hub, 1)[1]).toEqual(quota('t-3'))
    expect(framesOf(hub, 1)[3]?.['message']).toBe('registered-1')
    // nothing was sent twice
    expect(framesOf(hub, 0)).toHaveLength(5)
  })

  it('keeps the queue for the next registered when registered is read on a closing socket', async () => {
    // The hub compresses `registered` and drops the TCP connection once it is written.
    // The client inflates the frame asynchronously, so ws hands it over after the
    // connection's end has set CLOSING; a send then would drop the queue silently.
    const hub = await startHub({
      perMessageDeflate: true,
      onFrame: (ws, msg, conn) => {
        if (msg['type'] !== 'worker.register') return
        if (conn === 0) ws.send(JSON.stringify(registered(conn)), () => ws.terminate())
        else answerRegister(ws, msg, conn)
      },
    })
    const { client, log, events } = makeClient(hub)
    client.sendReliable(accept('t-1'))
    client.sendReliable(complete('t-1'))
    client.start()
    await until(() => events.registered.some((m) => m.connectionId === 'c-1'), 'registered on c-1')
    // a sentinel behind the flush: once it arrives, everything flushed before it has too
    expect(client.send(progress('sentinel'))).toBe(true)
    await until(() => framesOf(hub, 1).some((f) => f['type'] === 'task.progress'), 'sentinel')
    expect(framesOf(hub, 1).map((f) => f['type'])).toEqual([
      'worker.register',
      'task.accept',
      'task.complete',
      'task.progress',
    ])
    expect(framesOf(hub, 0)).toEqual([registerMsg(1)])
    // the frame read on the closing socket is not a registration
    expect(events.registered).toEqual([registered(1)])
    expect(log.lines.some((l) => l.m.includes('as the connection closed'))).toBe(true)
  })

  it('drops progress while disconnected', async () => {
    fakeTimers()
    const answers: Array<() => void> = []
    const hub = await startHub({
      onFrame: (ws, msg, conn) => {
        if (msg['type'] === 'worker.register') answers.push(() => answerRegister(ws, msg, conn))
      },
    })
    const { client, log } = makeClient(hub, { backoff: { baseMs: 100, maxMs: 100 } })
    expect(client.send(progress('before start'))).toBe(false)
    client.start()
    await until(() => framesOf(hub, 0).length === 1, 'register on the first connection')
    // open but not registered yet
    expect(client.send(progress('before registered'))).toBe(false)
    answers.shift()?.()
    await until(() => client.registered, 'registered')
    expect(client.send(progress('live'))).toBe(true)
    await until(() => framesOf(hub, 0).length === 2, 'live progress')

    socketOf(hub, 0).terminate()
    await until(() => reconnectDelays(log).length === 1, 'drop noticed')
    expect(client.send(progress('while down'))).toBe(false)
    vi.advanceTimersByTime(120)
    await until(() => framesOf(hub, 1).length === 1, 'register on the second connection')
    answers.shift()?.()
    await until(() => client.registered, 'registered again')
    expect(client.send(progress('back'))).toBe(true)
    await until(() => framesOf(hub, 1).length === 2, 'progress after the reconnect')

    const sent = hub.frames.flat().filter((f) => f['type'] === 'task.progress')
    expect(sent.map((f) => f['message'])).toEqual(['live', 'back'])
  })

  it('ignores malformed JSON and unknown types', async () => {
    const malformed = ['{not json', '42', '"text"', 'null', '[]', '{"type":5}', '{"taskId":"x"}']
    const ignored = [
      'agent.offline',
      'task.created',
      'task.comment',
      'task.accepted',
      'task.progress',
      'message',
      'data.response',
      'something.new',
    ]
    const hub = await startHub({
      onFrame: (ws, msg, conn) => {
        if (msg['type'] !== 'worker.register') return
        ws.send(JSON.stringify({ type: 'welcome', agentId: 'agent-1', onlineAgents: [] }))
        ws.send(JSON.stringify({ type: 'agent.online', agentId: 'agent-2' }))
        ws.send(JSON.stringify(registered(conn)))
        for (const raw of malformed) ws.send(raw)
        for (const type of ignored) ws.send(JSON.stringify({ type }))
        ws.send(JSON.stringify(assigned('task.assigned')))
        ws.send(JSON.stringify(assigned('task.resumed')))
        ws.send(JSON.stringify(revoked('t-9')))
      },
    })
    const { client, log, events } = makeClient(hub)
    client.start()
    await until(() => events.messages.length === 3, 'task frames')
    expect(events.messages).toEqual([
      assigned('task.assigned'),
      assigned('task.resumed'),
      revoked('t-9'),
    ])
    expect(events.registered).toEqual([registered(0)])
    expect(client.registered).toBe(true)
    // one warn per malformed frame; welcome, agent.online and the other frames are silent
    expect(log.warns()).toHaveLength(malformed.length)
    expect(log.warns().join('\n')).not.toMatch(
      /welcome|agent\.online|agent\.offline|something\.new/,
    )
    expect(log.lines.filter((l) => l.level === 'error')).toEqual([])
  })

  it('logs a hub error frame at warn', async () => {
    const hub = await startHub({
      onFrame: (ws, msg, conn) => {
        if (msg['type'] !== 'worker.register') return
        ws.send(JSON.stringify(registered(conn)))
        ws.send(JSON.stringify({ type: 'error', message: 'Rate limited: too many tasks created' }))
        ws.send(JSON.stringify(revoked('t-9')))
      },
    })
    const { client, log, events } = makeClient(hub)
    client.start()
    await until(() => events.messages.length === 1, 'sentinel')
    expect(events.messages).toEqual([revoked('t-9')])
    expect(log.warns()).toEqual([expect.stringContaining('Rate limited: too many tasks created')])
  })

  it('terminates and reconnects when pongs stop', async () => {
    fakeTimers()
    const hub = await startHub({ autoPong: false })
    const { client, log, events } = makeClient(hub, {
      pingMs: 1000,
      backoff: { baseMs: 100, maxMs: 100 },
    })
    client.start()
    await until(() => client.registered, 'registered')
    vi.advanceTimersByTime(1000)
    await until(() => hub.pings[0] === 1, 'first ping')
    vi.advanceTimersByTime(1000)
    await until(() => hub.pings[0] === 2, 'second ping')
    expect(hub.closes[0]).toBeUndefined()
    // no pong within 2 × pingMs of the first ping
    vi.advanceTimersByTime(1000)
    await until(() => hub.closes[0] !== undefined, 'the hub sees the drop')
    expect(hub.closes[0]?.code).toBe(1006)
    expect(hub.pings[0]).toBe(2)
    await until(() => reconnectDelays(log).length === 1, 'reconnect scheduled')
    vi.advanceTimersByTime(120)
    await until(() => events.registered.length === 2, 'registered again')
    expect(hub.connections).toHaveLength(2)
    expect(log.warns().some((m) => /ping/i.test(m))).toBe(true)
  })

  it('keeps a connection whose pongs arrive', async () => {
    fakeTimers()
    // the pong goes out before the frame, so a seen frame means a seen pong
    const hub = await startHub({
      onPing: (ws, _conn, count) => ws.send(JSON.stringify(revoked(`tick-${count}`))),
    })
    const { client, events } = makeClient(hub, { pingMs: 1000 })
    client.start()
    await until(() => client.registered, 'registered')
    for (let n = 1; n <= 5; n++) {
      vi.advanceTimersByTime(1000)
      await until(() => events.messages.length === n, `pong ${n}`)
    }
    expect(hub.connections).toHaveLength(1)
    expect(hub.closes[0]).toBeUndefined()
    expect(client.registered).toBe(true)
  })

  it('warns once when the hub never answers worker.register, and keeps the socket', async () => {
    fakeTimers()
    const hub = await startHub({ onFrame: () => undefined })
    const { client, log } = makeClient(hub, { pingMs: 10 * 60_000 })
    const registerWarns = (): string[] => log.warns().filter((m) => m.includes('worker.register'))
    client.start()
    await until(() => framesOf(hub, 0).length === 1, 'register sent')
    vi.advanceTimersByTime(14_999)
    expect(registerWarns()).toEqual([])
    vi.advanceTimersByTime(1)
    expect(registerWarns()).toEqual([expect.stringContaining('cortex-worker doctor')])
    vi.advanceTimersByTime(5 * 60_000)
    await realDelay(50)
    expect(registerWarns()).toHaveLength(1)
    expect(log.warns()).toHaveLength(1)
    expect(hub.connections).toHaveLength(1)
    expect(hub.closes[0]).toBeUndefined()
    expect(socketOf(hub, 0).readyState).toBe(WebSocket.OPEN)
    expect(reconnectDelays(log)).toEqual([])
    expect(client.registered).toBe(false)
  })

  it('does not warn about worker.register when registered arrives in time', async () => {
    fakeTimers()
    const hub = await startHub()
    const { client, log } = makeClient(hub, { pingMs: 10 * 60_000 })
    client.start()
    await until(() => client.registered, 'registered')
    vi.advanceTimersByTime(60_000)
    expect(log.warns()).toEqual([])
  })

  it('stop closes with 1000, cancels every timer and never reconnects', async () => {
    fakeTimers()
    const hub = await startHub()
    const { client, events } = makeClient(hub, { pingMs: 1000 })
    client.start()
    await until(() => client.registered, 'registered')
    await client.stop()
    await until(() => hub.closes[0] !== undefined, 'the hub sees the close')
    expect(hub.closes[0]?.code).toBe(1000)
    await until(() => vi.getTimerCount() === 0, 'no timers left')
    expect(client.registered).toBe(false)

    vi.advanceTimersByTime(10 * 60_000)
    expect(client.send(progress('after stop'))).toBe(false)
    client.sendReliable(complete('t-1'))
    client.start()
    await realDelay(100)
    expect(hub.handshakes).toBe(1)
    expect(hub.pings[0]).toBe(0)
    expect(framesOf(hub, 0)).toEqual([registerMsg(1)])
    expect(events.registered).toHaveLength(1)
  })

  it('hands no frame from the stopped socket to the worker', async () => {
    const hub = await startHub()
    const { client, events } = makeClient(hub)
    client.start()
    await until(() => client.registered, 'registered')
    // in flight when stop() runs: the client reads it while its close handshake is under way
    socketOf(hub, 0).send(JSON.stringify(assigned('task.assigned')))
    await client.stop()
    await until(() => hub.closes[0] !== undefined, 'the hub sees the close')
    expect(events.messages).toEqual([])
  })

  it('stop cancels a pending reconnect', async () => {
    fakeTimers()
    const hub = await startHub({
      onFrame: (ws, msg) => {
        if (msg['type'] === 'worker.register') ws.close(1011, 'going away')
      },
    })
    const { client, log } = makeClient(hub, { backoff: { baseMs: 1000, maxMs: 1000 } })
    client.start()
    await until(() => reconnectDelays(log).length === 1, 'reconnect scheduled')
    await client.stop()
    await until(() => vi.getTimerCount() === 0, 'no timers left')
    vi.advanceTimersByTime(60_000)
    await realDelay(100)
    expect(hub.handshakes).toBe(1)
  })

  it('stop terminates the socket when the close handshake does not finish within 2 s', async () => {
    fakeTimers()
    // the hub stops reading, so it never answers the close frame
    const hub = await startHub({
      onConnection: (ws) => (ws as unknown as { _socket: Socket })._socket.pause(),
    })
    const { client, events } = makeClient(hub)
    client.start()
    await until(() => events.registers === 1, 'open')
    let done = false
    const stopped = client.stop().then(() => {
      done = true
    })
    await realDelay(100)
    expect(done).toBe(false)
    vi.advanceTimersByTime(2000)
    await stopped
    expect(done).toBe(true)
    await until(() => vi.getTimerCount() === 0, 'no timers left')
  })
})
