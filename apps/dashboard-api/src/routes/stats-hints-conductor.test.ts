import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

let testDb: InstanceType<typeof Database>

function createTestDb() {
  const db = new Database(':memory:')
  db.exec(readFileSync(join(__dirname, '../db/schema.sql'), 'utf-8'))
  return db
}

vi.mock('../db/client.js', () => ({
  get db() {
    return testDb
  },
}))

vi.mock('./intel.js', () => ({ getGitNexusRepos: vi.fn() }))

import { Hono } from 'hono'
import { statsRouter } from './stats.js'

const app = new Hono()
app.route('/api/metrics', statsRouter)

interface HintsBody { agentId: string; hints: string[]; conductor: string[]; toolsUsedCount: number }

async function getHints(agentId: string, tool = ''): Promise<HintsBody> {
  const res = await app.request(`/api/metrics/hints/${agentId}?currentTool=${tool}`)
  expect(res.status).toBe(200)
  return (await res.json()) as HintsBody
}

function seedNotice(recipient: string, message: string) {
  testDb
    .prepare(`INSERT INTO conductor_notifications (recipient, task_id, kind, message) VALUES (?, 'task-1', 'review_ready', ?)`)
    .run(recipient, message)
}

beforeEach(() => {
  testDb = createTestDb()
})

describe('GET /hints/:agentId conductor notifications', () => {
  it('returns and marks conductor notifications', async () => {
    seedNotice('lead-key', 'TT1 ready')
    seedNotice('lead-key', 'TT2 ready')

    const first = await getHints('lead-key')
    expect(first.conductor).toEqual(['TT1 ready', 'TT2 ready'])
    expect(first.hints.length).toBeGreaterThan(0)

    const second = await getHints('lead-key')
    expect(second.conductor).toEqual([])
  })

  it('answers an empty conductor list and unchanged hints when nothing is pending', async () => {
    const body = await getHints('lead-key')
    expect(body.conductor).toEqual([])
    expect(body.hints).toHaveLength(1)
    expect(body.hints[0]).toContain('cortex_session_start')
    expect(body.toolsUsedCount).toBe(0)
  })

  it('does not cap conductor notices at the two-hint limit', async () => {
    for (let i = 0; i < 4; i++) seedNotice('lead-key', `TT${i} ready`)
    const body = await getHints('lead-key', 'session_end')
    expect(body.hints.length).toBeLessThanOrEqual(2)
    expect(body.conductor).toHaveLength(4)
  })

  it('leaves another recipient\'s notices undelivered', async () => {
    seedNotice('other-key', 'for someone else')
    const body = await getHints('lead-key')
    expect(body.conductor).toEqual([])
    const row = testDb
      .prepare(`SELECT delivered_at FROM conductor_notifications WHERE recipient = 'other-key'`)
      .get() as { delivered_at: string | null }
    expect(row.delivered_at).toBeNull()
  })

  it('does not consume notices when the hint queries fail', async () => {
    seedNotice('lead-key', 'TT1 ready')
    testDb.exec('DROP TABLE query_logs')
    const res = await app.request('/api/metrics/hints/lead-key')
    expect(res.status).toBe(500)
    const row = testDb
      .prepare(`SELECT delivered_at FROM conductor_notifications`)
      .get() as { delivered_at: string | null }
    expect(row.delivered_at).toBeNull()
  })
})
