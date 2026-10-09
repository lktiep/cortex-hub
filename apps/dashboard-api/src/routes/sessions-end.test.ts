import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ── In-memory DB for tests ──
let testDb: InstanceType<typeof Database>

function createTestDb() {
  const db = new Database(':memory:')
  const schema = readFileSync(join(__dirname, '../db/schema.sql'), 'utf-8')
  db.exec(schema)
  return db
}

vi.mock('../db/client.js', () => ({
  get db() {
    return testDb
  },
}))

// The two side effects of a /ce: the summary stored as memory, and a recipe mined from it.
const { mem9Add, captureFromSession } = vi.hoisted(() => ({
  mem9Add: vi.fn(async () => ({})),
  captureFromSession: vi.fn(async () => {}),
}))
vi.mock('./mem9-proxy.js', () => ({ getMem9: () => ({ add: mem9Add }) }))
vi.mock('../services/recipe-capture.js', () => ({ captureFromSession }))

import { Hono } from 'hono'
import { sessionsRouter } from './quality.js'

const app = new Hono()
app.route('/api/sessions', sessionsRouter)

// Long enough to pass both the memory (>20) and the recipe (>50) thresholds.
const SUMMARY = 'Session auto-closed. Activity: knowledge-searched memory-searched code-searched.'

async function end(id: string, body: Record<string, unknown>) {
  const res = await app.request(`/api/sessions/${id}/end`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as { session?: { status: string } } }
}

function row(id: string) {
  return testDb.prepare('SELECT status, task_summary FROM session_handoffs WHERE id = ?').get(id) as
    { status: string; task_summary: string }
}

/** Let the fire-and-forget dynamic import of recipe-capture settle before asserting on it. */
const settle = () => new Promise((r) => setTimeout(r, 20))

describe('POST /api/sessions/:id/end', () => {
  beforeEach(() => {
    testDb = createTestDb()
    mem9Add.mockClear()
    captureFromSession.mockClear()
    testDb.exec(`
      INSERT INTO session_handoffs (id, from_agent, project, task_summary, context, status) VALUES
        ('s-open', 'claude-code', 'hub', 'started', '{}', 'active'),
        ('s-done', 'claude-code', 'hub', 'what /ce wrote', '{}', 'completed');
    `)
  })

  it('closes an active session as abandoned when the exit hook sends auto', async () => {
    const res = await end('s-open', { summary: SUMMARY, auto: true })
    await settle()
    expect(res.status).toBe(200)
    expect(res.body.session?.status).toBe('abandoned')
    expect(row('s-open')).toEqual({ status: 'abandoned', task_summary: SUMMARY })
  })

  it('keeps an automatic summary out of memory and recipes', async () => {
    await end('s-open', { summary: SUMMARY, auto: true })
    await settle()
    expect(mem9Add).not.toHaveBeenCalled()
    expect(captureFromSession).not.toHaveBeenCalled()
  })

  it('never downgrades a session /ce already completed', async () => {
    const res = await end('s-done', { summary: SUMMARY, auto: true })
    expect(res.status).toBe(200)
    expect(res.body.session?.status).toBe('completed')
    expect(row('s-done')).toEqual({ status: 'completed', task_summary: 'what /ce wrote' })
  })

  it('still completes and remembers a session the agent ends itself', async () => {
    const res = await end('s-open', { summary: SUMMARY })
    await settle()
    expect(res.body.session?.status).toBe('completed')
    expect(row('s-open').status).toBe('completed')
    expect(mem9Add).toHaveBeenCalledTimes(1)
    expect(captureFromSession).toHaveBeenCalledTimes(1)
  })

  it('404s an unknown session either way', async () => {
    expect((await end('nope', { summary: SUMMARY, auto: true })).status).toBe(404)
  })
})
