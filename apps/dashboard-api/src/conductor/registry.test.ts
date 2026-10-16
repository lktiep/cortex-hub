import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb, fakeSocket } from './testing.js'

let testDb: Database.Database
vi.mock('../db/client.js', () => ({ get db() { return testDb } }))

import {
  addConnection, broadcastToOwner, getByAgent, lastSeen, removeConnection, resetRegistry,
  sendTo, setStatus, updateConnection, type ConnInit,
} from './registry.js'

beforeAll(() => { testDb = createTestDb() })

function init(agentId: string, hostname: string, ws = fakeSocket(), owner = 'o1'): ConnInit {
  return { ws, agentId, apiKeyOwner: owner, apiKeyProjectId: null, hostname, ide: null, platform: null, capabilities: [] }
}

describe('registry', () => {
  beforeEach(() => resetRegistry(1_000))

  it('new connections start unregistered', () => {
    const r = addConnection(init('w1', 'h1'))
    if (!r.ok) throw new Error('expected ok')
    expect(r.conn.ready).toBe(false)
    expect(r.conn.protocol).toBe(1)
    expect(r.conn.engines).toEqual([])
    expect(r.conn.status).toBe('idle')
    expect(updateConnection(r.conn.connectionId, { ready: true })?.ready).toBe(true)
  })

  it('replaces a connection from the same host', () => {
    const a = fakeSocket(), b = fakeSocket()
    addConnection(init('w1', 'h1', a))
    const r = addConnection(init('w1', 'h1', b))
    expect(r.ok && r.replaced).toBe(true)
    expect(a.closed).toEqual({ code: 4000, reason: 'replaced' })
    expect(getByAgent('w1')?.ws).toBe(b)
  })

  it('refuses the same agent id from another host', () => {
    const a = fakeSocket(), b = fakeSocket()
    addConnection(init('w1', 'h1', a))
    const r = addConnection(init('w1', 'h2', b))
    expect(r).toEqual({ ok: false, code: 4009, reason: 'agent id in use on h1' })
    expect(a.closed).toBeNull()
    expect(getByAgent('w1')?.ws).toBe(a)
  })

  it('late close of a replaced socket keeps the new one', () => {
    const a = addConnection(init('w1', 'h1'))
    const b = addConnection(init('w1', 'h1'))
    if (!a.ok || !b.ok) throw new Error('expected ok')
    expect(removeConnection(a.conn.connectionId)).toBe(false)
    expect(getByAgent('w1')?.connectionId).toBe(b.conn.connectionId)
  })

  it('lastSeen', () => {
    const r = addConnection(init('w1', 'h1'), 2_000)
    if (!r.ok) throw new Error('expected ok')
    expect(lastSeen('w1', 3_000)).toBe(3_000)
    removeConnection(r.conn.connectionId, 5_000)
    expect(lastSeen('w1', 9_000)).toBe(5_000)
    expect(lastSeen('nobody', 9_000)).toBe(1_000)
  })

  it('sendTo skips closed sockets', () => {
    const a = fakeSocket()
    addConnection(init('w1', 'h1', a))
    expect(sendTo('w1', { type: 'x' })).toBe(true)
    a.readyState = 3
    expect(sendTo('w1', { type: 'y' })).toBe(false)
    expect(a.sent).toEqual([{ type: 'x' }])
  })

  it('sendTo returns false when the send throws', () => {
    const a = fakeSocket()
    a.send = () => { throw new Error('socket broke') }
    addConnection(init('w1', 'h1', a))
    expect(sendTo('w1', { type: 'x' })).toBe(false)
  })

  it('a throwing send is logged with the agent id and the error message', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const a = fakeSocket()
      a.send = () => { throw new Error('socket broke') }
      addConnection(init('w1', 'h1', a))
      expect(sendTo('w1', { type: 'x' })).toBe(false)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('w1')
      expect(String(warn.mock.calls[0]?.[0])).toContain('socket broke')
    } finally {
      warn.mockRestore()
    }
  })

  it('broadcastToOwner skips a socket whose send throws and reaches the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const a = fakeSocket(), b = fakeSocket()
      a.send = () => { throw new Error('socket broke') }
      addConnection(init('w1', 'h1', a))
      addConnection(init('w2', 'h2', b))
      expect(() => broadcastToOwner('o1', { type: 'n' })).not.toThrow()
      expect(b.sent).toEqual([{ type: 'n' }])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('w1')
    } finally {
      warn.mockRestore()
    }
  })

  it('setStatus idle sets idleSince once', () => {
    addConnection(init('w1', 'h1'), 2_000)
    setStatus('w1', 'busy', 3_000)
    setStatus('w1', 'idle', 7_000)
    expect(getByAgent('w1')?.idleSince).toBe(7_000)
    setStatus('w1', 'idle', 9_000)
    expect(getByAgent('w1')?.idleSince).toBe(7_000)
  })

  it('broadcastToOwner reaches same owner only, minus the excluded agent', () => {
    const a = fakeSocket(), b = fakeSocket(), c = fakeSocket()
    addConnection(init('w1', 'h1', a))
    addConnection(init('w2', 'h2', b))
    addConnection(init('w3', 'h3', c, 'o2'))
    broadcastToOwner('o1', { type: 'n' }, 'w1')
    expect(a.sent).toEqual([])
    expect(b.sent).toEqual([{ type: 'n' }])
    expect(c.sent).toEqual([])
  })
})
