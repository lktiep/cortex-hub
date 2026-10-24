import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from '../conductor/testing.js'

const testDb: Database.Database = createTestDb()
let add: (opts?: unknown) => Promise<unknown> = async () => ({ events: [], tokensUsed: 0 })
const searched: Array<{ userId: string }> = []
vi.mock('../db/client.js', () => ({ get db() { return testDb } }))
vi.mock('../lib/embedder-factory.js', () => ({ createEmbedder: () => ({ embed: async () => [0.1] }) }))
vi.mock('@cortex/shared-mem9', () => ({
  Mem9: class {
    add(opts: unknown) { return add(opts) }
    async search(opts: { userId: string }) { searched.push(opts); return { memories: [], tokensUsed: 0 } }
  },
  blendRecency: (x: unknown) => x,
  byScore: (x: unknown) => x,
}))

import { memoryScope, mem9ProxyRouter, STORE_WAIT_MS } from './mem9-proxy.js'

function store(userId = 'agent', owner?: string): Promise<Response> {
  return Promise.resolve(mem9ProxyRouter.request('/store', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(owner ? { 'X-API-Key-Owner': owner } : {}) },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }], userId }),
  }))
}

afterEach(() => vi.useRealTimers())

describe('POST /store', () => {
  it('answers with what was written when the write is quick', async () => {
    add = async () => ({ events: [{ event: 'ADD' }], tokensUsed: 3 })

    const res = await store()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, userId: 'agent', events: [{ event: 'ADD' }], tokensUsed: 3 })
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
    expect(await res.json()).toEqual({ success: true, pending: true, userId: 'agent', events: [] })
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

describe('the scope of an unscoped memory', () => {
  testDb.exec('ALTER TABLE session_handoffs ADD COLUMN api_key_name TEXT')
  testDb.prepare("INSERT INTO organizations (id, name, slug) VALUES ('org-1', 'Org', 'org')").run()
  testDb.prepare("INSERT INTO projects (id, org_id, name, slug) VALUES ('proj-1', 'org-1', 'Demo', 'demo')").run()
  testDb.prepare(
    `INSERT INTO session_handoffs (id, from_agent, project, task_summary, context, status, project_id, api_key_name)
     VALUES ('s1', 'agent', 'demo', 's', '{}', 'active', 'proj-1', 'k')`,
  ).run()

  it('is the caller\'s session project, for a store and a search alike', async () => {
    let written: { userId?: string; metadata?: Record<string, unknown> } = {}
    add = async (opts) => { written = opts as typeof written; return { events: [], tokensUsed: 0 } }

    expect(await (await store('default', 'k')).json()).toMatchObject({ userId: 'project-proj-1' })
    expect(written).toMatchObject({ userId: 'project-proj-1', metadata: { project_id: 'proj-1' } })

    searched.length = 0
    await mem9ProxyRouter.request('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key-Owner': 'k' },
      body: JSON.stringify({ query: 'q', userId: 'claude-code' }),
    })
    expect(searched.map((s) => s.userId)).toEqual(['project-proj-1'])
  })

  it('stays as named for a project scope, or a caller with no session', async () => {
    expect(memoryScope('project-proj-9', 'k')).toEqual({ userId: 'project-proj-9' })
    expect(memoryScope('default', 'nobody')).toEqual({ userId: 'default' })
    expect(memoryScope('default', undefined)).toEqual({ userId: 'default' })
  })
})
