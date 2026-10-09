import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
  // Added by the runtime migrations in db/client.ts, not by schema.sql.
  db.exec('ALTER TABLE session_handoffs ADD COLUMN last_activity TEXT')
  return db
}

vi.mock('../db/client.js', () => ({
  get db() {
    return testDb
  },
}))

import { expireIdleSessions, sessionIdleHours } from './session-expiry.js'

/** A timestamp `hours` ago in the format the hub stores, or null. */
const ago = (hours: number | null) => (hours === null ? null : `strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-${hours} hours')`)

function seed(rows: Array<[id: string, status: string, createdHoursAgo: number, lastActivityHoursAgo: number | null]>) {
  for (const [id, status, created, last] of rows) {
    testDb.exec(
      `INSERT INTO session_handoffs (id, from_agent, project, task_summary, context, status, created_at, last_activity)
       VALUES ('${id}', 'claude-code', 'hub', 'test', '{}', '${status}', ${ago(created)}, ${ago(last) ?? 'NULL'})`
    )
  }
}

function statuses(): Record<string, string> {
  const rows = testDb.prepare('SELECT id, status FROM session_handoffs ORDER BY id').all() as Array<{ id: string; status: string }>
  return Object.fromEntries(rows.map((r) => [r.id, r.status]))
}

describe('expireIdleSessions', () => {
  beforeEach(() => {
    testDb = createTestDb()
  })

  it('expires active sessions idle past the limit and leaves the rest alone', () => {
    seed([
      ['idle',        'active',    200, 100],
      ['old-but-busy','active',    200, 1],
      ['fresh',       'active',    2,   2],
      ['done',        'completed', 200, 100],
      ['handoff',     'pending',   200, 100],
    ])
    expect(expireIdleSessions(72)).toBe(1)
    expect(statuses()).toEqual({
      done: 'completed',
      fresh: 'active',
      handoff: 'pending',
      idle: 'expired',
      'old-but-busy': 'active',
    })
  })

  it('goes by created_at for a session with no recorded activity', () => {
    seed([
      ['never-used-old', 'active', 100, null],
      ['never-used-new', 'active', 10,  null],
    ])
    expect(expireIdleSessions(72)).toBe(1)
    expect(statuses()).toEqual({ 'never-used-new': 'active', 'never-used-old': 'expired' })
  })

  it('does nothing when the limit is 0', () => {
    seed([['idle', 'active', 200, 100]])
    expect(expireIdleSessions(0)).toBe(0)
    expect(statuses()).toEqual({ idle: 'active' })
  })
})

describe('sessionIdleHours', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.each([
    [undefined, 72],
    ['', 72],
    ['24', 24],
    [' 12 ', 12],
    ['0', 0],
    ['-5', 72],
    ['soon', 72],
  ])('SESSION_IDLE_HOURS=%j → %d', (raw, hours) => {
    vi.stubEnv('SESSION_IDLE_HOURS', raw)
    expect(sessionIdleHours()).toBe(hours)
  })
})
