import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'
import type { CortexConfig } from './config.js'
import { ConductorClient, classifyClose } from './ws-client.js'

describe('classifyClose', () => {
  it('mirrors the worker: replaced, key errors and agent id in use are fatal', () => {
    expect(classifyClose(4000)).toBe('replaced')
    expect(classifyClose(4001)).toBe('missing-key')
    expect(classifyClose(4003)).toBe('bad-key')
    expect(classifyClose(4009)).toBe('agent-in-use')
  })
  it('anything else reconnects', () => {
    for (const code of [1000, 1001, 1006, 1011, 4002, 4500]) expect(classifyClose(code)).toBeNull()
  })
})

describe('ConductorClient against a real server', () => {
  let server: WebSocketServer | null = null
  let client: ConductorClient | null = null

  afterEach(async () => {
    client?.dispose()
    client = null
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    server = null
  })

  /** A server that runs `onConnection` for each socket, numbered from 1; resolves to its ws:// URL. */
  async function start(onConnection: (socket: WebSocket, n: number) => void): Promise<{ url: string; count: () => number }> {
    let n = 0
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    server = wss
    wss.on('connection', (socket) => onConnection(socket, ++n))
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
    const { port } = wss.address() as AddressInfo
    return { url: `ws://127.0.0.1:${port}/ws/conductor`, count: () => n }
  }

  const config = (hubUrl: string): CortexConfig => ({
    apiKey: 'k1',
    hubUrl,
    agentId: 'a1',
    ide: 'vscode',
    platform: 'macOS',
    capabilities: [],
    autoConnect: true,
    hubSource: 'setting',
    keySource: 'setting',
  })

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  /** A client for this test, disposed afterwards. */
  function newClient(url: string): ConductorClient {
    const c = new ConductorClient(config(url))
    client = c
    return c
  }

  /** Resolves with the arguments of the next `event`. */
  const next = (c: ConductorClient, event: string) =>
    new Promise<unknown[]>((resolve) => c.once(event, (...args: unknown[]) => resolve(args)))

  it('stops after 4000 (replaced by another window) instead of taking the id back', async () => {
    const hub = await start((socket) => socket.close(4000, 'replaced'))
    const c = newClient(hub.url)
    const stopped = next(c, 'stopped')
    c.connect()
    expect(await stopped).toEqual(['replaced', 4000, 'replaced'])
    await sleep(1500) // past the first reconnect delay
    expect(hub.count()).toBe(1)
    expect(c.state).toBe('disconnected')
  })

  it('stops after 4009 (agent id in use on another host)', async () => {
    const hub = await start((socket) => socket.close(4009, 'agent id in use on other-host'))
    const c = newClient(hub.url)
    const stopped = next(c, 'stopped')
    c.connect()
    expect(await stopped).toEqual(['agent-in-use', 4009, 'agent id in use on other-host'])
    await sleep(1500)
    expect(hub.count()).toBe(1)
  })

  it('reconnects after an ordinary close, and connect() works again after a stop', async () => {
    const hub = await start((socket, n) => {
      if (n === 1) socket.close(1011, 'restarting')
      else if (n === 2) socket.close(4000, 'replaced')
    })
    const c = newClient(hub.url)
    let stopped = false
    c.on('stopped', () => { stopped = true })
    c.connect()
    await sleep(1800)
    expect(hub.count()).toBe(2)
    expect(stopped).toBe(true)

    const connected = next(c, 'connected')
    c.connect()
    await connected
    expect(hub.count()).toBe(3)
  })

  it('reconnect() leaves one live socket: the old socket closing late does not touch the new one', async () => {
    const hub = await start(() => {})
    const c = newClient(hub.url)
    let stopped = false
    c.on('stopped', () => { stopped = true })
    const first = next(c, 'connected')
    c.connect()
    await first
    const second = next(c, 'connected')
    c.reconnect()
    await second
    await sleep(1500) // past the first reconnect delay
    expect(hub.count()).toBe(2)
    expect(c.state).toBe('connected')
    expect(stopped).toBe(false)
  })
})
