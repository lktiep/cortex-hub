import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from '../conductor/testing.js'

// The scheduler uses the app's database; these tests pass their own.
vi.mock('../db/client.js', () => ({ db: undefined }))

import {
  deleteOldUsageLogsBatch,
  pruneUsageLogs,
  rollUpUsageLogs,
  rollUpUsageLogsHour,
  usageRetentionDays,
  ROLLED_UP_BEFORE_KEY,
} from './usage-retention.js'

let db: Database.Database

/** `count` usage_logs rows created `daysAgo` days (and a minute) ago. */
function seed(count: number, daysAgo: number) {
  db.prepare(`
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
    INSERT INTO usage_logs (agent_id, model, total_tokens, created_at)
    SELECT 'agent', 'm', 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?, '-1 minute') FROM n
  `).run(count, `-${daysAgo} days`)
}

/** One row per second from `from`, `count` of them. */
function seedCalls(count: number, from: string, row: { agent?: string; model?: string; type?: string; project?: string | null; tokens?: number } = {}) {
  db.prepare(`
    WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ? - 1)
    INSERT INTO usage_logs (agent_id, model, prompt_tokens, total_tokens, project_id, request_type, created_at)
    SELECT ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', ?, '+' || i || ' seconds') FROM n
  `).run(count, row.agent ?? 'internal', row.model ?? 'all-minilm', row.tokens ?? 10, row.tokens ?? 10,
    row.project === undefined ? 'p1' : row.project, row.type ?? 'embedding', from)
}

const count = () => (db.prepare('SELECT COUNT(*) AS n FROM usage_logs').get() as { n: number }).n

/** What the Usage page shows: calls and tokens per day, model and agent. */
const totals = () => db.prepare(`
  SELECT date(created_at) AS day, model, agent_id, project_id, request_type,
         SUM(request_count) AS requests, SUM(total_tokens) AS tokens, SUM(prompt_tokens) AS prompt, MAX(created_at) AS last
    FROM usage_logs GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 2, 3, 4, 5
`).all()

beforeEach(() => {
  db = createTestDb()
})

describe('rollUpUsageLogs', () => {
  it('turns the embedding rows of each finished hour into one row per agent, model and project, keeping every total', async () => {
    seedCalls(5_000, '2026-11-01T10:00:00Z')                     // 10:00 – 11:23
    seedCalls(300, '2026-11-01T10:30:00Z', { project: null })
    seedCalls(200, '2026-11-01T10:30:00Z', { agent: 'other', model: 'nomic' })
    seedCalls(40, '2026-11-01T10:30:00Z', { type: 'chat', model: 'gemini' })
    seedCalls(10, '2026-11-01T12:30:00Z')                        // the hour not finished yet
    const before = totals()

    const removed = await rollUpUsageLogs(db, '2026-11-01T12:15:00Z')

    expect(totals()).toEqual(before)
    // 10:00 → 3 groups, 11:00 → 1 group; chat and the 12:00 hour untouched.
    expect(count()).toBe(4 + 40 + 10)
    expect(removed).toBe(5_500 - 4)
    expect((db.prepare('SELECT value FROM hub_config WHERE key = ?').get(ROLLED_UP_BEFORE_KEY) as { value: string }).value)
      .toBe('2026-11-01T12:00:00Z')
    const tenOClock = db.prepare(
      "SELECT request_count, total_tokens, created_at FROM usage_logs WHERE agent_id = 'internal' AND project_id = 'p1' AND created_at < '2026-11-01T11:00:00Z' AND request_type = 'embedding'",
    ).all()
    expect(tenOClock).toEqual([{ request_count: 3_600, total_tokens: 36_000, created_at: '2026-11-01T10:59:59Z' }])
  })

  it('does nothing more on the next run, and only new finished hours after that', async () => {
    seedCalls(100, '2026-11-01T10:00:00Z')
    await rollUpUsageLogs(db, '2026-11-01T12:00:00Z')
    expect(rollUpUsageLogsHour(db, '2026-11-01T12:00:00Z')).toBeNull()
    expect(count()).toBe(1)

    seedCalls(100, '2026-11-01T12:00:00Z')
    expect(await rollUpUsageLogs(db, '2026-11-01T14:00:00Z')).toBe(99)
    expect(count()).toBe(2)
    expect((db.prepare('SELECT SUM(request_count) AS n FROM usage_logs').get() as { n: number }).n).toBe(200)
  })
})

describe('pruneUsageLogs', () => {
  it('deletes every row past the window in batches and keeps the window', async () => {
    seed(2_345, 120)
    seed(10, 91)
    seed(50, 89)
    seed(30, 0)

    expect(deleteOldUsageLogsBatch(db, 90, 1_000)).toBe(1_000)
    expect(await pruneUsageLogs(db, 90, { batchSize: 1_000 })).toBe(1_355)
    expect(count()).toBe(80)
    expect(await pruneUsageLogs(db, 90)).toBe(0)
  })

  it('keeps everything when retention is 0', async () => {
    seed(5, 400)
    expect(await pruneUsageLogs(db, 0)).toBe(0)
    expect(count()).toBe(5)
  })
})

describe('usageRetentionDays', () => {
  const saved = process.env.USAGE_LOG_RETENTION_DAYS
  afterEach(() => {
    if (saved === undefined) delete process.env.USAGE_LOG_RETENTION_DAYS
    else process.env.USAGE_LOG_RETENTION_DAYS = saved
  })

  it('defaults to 365 days, takes 0 to turn it off, and ignores junk', () => {
    delete process.env.USAGE_LOG_RETENTION_DAYS
    expect(usageRetentionDays()).toBe(365)
    process.env.USAGE_LOG_RETENTION_DAYS = '0'
    expect(usageRetentionDays()).toBe(0)
    process.env.USAGE_LOG_RETENTION_DAYS = '30'
    expect(usageRetentionDays()).toBe(30)
    process.env.USAGE_LOG_RETENTION_DAYS = 'soon'
    expect(usageRetentionDays()).toBe(365)
  })
})
