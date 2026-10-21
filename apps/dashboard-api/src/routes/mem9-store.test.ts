import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from '../conductor/testing.js'

const testDb: Database.Database = createTestDb()
let add: () => Promise<unknown> = async () => ({ events: [], tokensUsed: 0 })
vi.mock('../db/client.js', () => ({ get db() { return testDb } }))
vi.mock('../lib/embedder-factory.js', () => ({ createEmbedder: () => ({ embed: async () => [0.1] }) }))
vi.mock('@cortex/shared-mem9', () => ({
  Mem9: class { add() { return add() } },
  blendRecency: (x: unknown) => x,
  byScore: () => 0,
}))

import { mem9ProxyRouter, STORE_WAIT_MS } from './mem9-proxy.js'

function store(): Promise<Response> {
  return Promise.resolve(mem9ProxyRouter.request('/store', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }], userId: 'agent' }),
  }))
}

afterEach(() => vi.useRealTimers())

describe('POST /store', () => {
  it('answers with what was written when the write is quick', async () => {
    add = async () => ({ events: [{ event: 'ADD' }], tokensUsed: 3 })

    const res = await store()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, events: [{ event: 'ADD' }], tokensUsed: 3 })
  })

  it('does not hold the agent through a slow write, which still finishes', async () => {
    vi.useFakeTimers()
    let finish: (value: unknown) => void = () => {}
    let written = false
    add = () => new Promise((resolve) => { finish = resolve }).then((r) => { written = true; return r })

    const pending = store()
    await vi.advanceTimersByTimeAsync(STORE_WAIT_MS)
    const res = await pending

    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ success: true, pending: true, events: [] })
    finish({ events: [], tokensUsed: 0 })
    await vi.runAllTimersAsync()
    expect(written).toBe(true)
  })

  it('still reports a write that fails before the wait is over', async () => {
    add = async () => { throw new Error('qdrant down') }

    const res = await store()

    expect(res.status).toBe(500)
  })
})
