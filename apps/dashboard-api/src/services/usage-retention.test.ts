import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from '../conductor/testing.js'

// The scheduler uses the app's database; these tests pass their own.
vi.mock('../db/client.js', () => ({ db: undefined }))

import { deleteOldUsageLogsBatch, pruneUsageLogs, usageRetentionDays } from './usage-retention.js'

let db: Database.Database

/** `count` usage_logs rows created `daysAgo` days (and a minute) ago. */
function seed(count: number, daysAgo: number) {
  db.prepare(`
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
    INSERT INTO usage_logs (agent_id, model, total_tokens, created_at)
    SELECT 'agent', 'm', 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?) FROM n
  `).run(count, `-${daysAgo} days`)
}

const count = () => (db.prepare('SELECT COUNT(*) AS n FROM usage_logs').get() as { n: number }).n

beforeEach(() => {
  db = createTestDb()
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

  it('defaults to 90 days, takes 0 to turn it off, and ignores junk', () => {
    delete process.env.USAGE_LOG_RETENTION_DAYS
    expect(usageRetentionDays()).toBe(90)
    process.env.USAGE_LOG_RETENTION_DAYS = '0'
    expect(usageRetentionDays()).toBe(0)
    process.env.USAGE_LOG_RETENTION_DAYS = '30'
    expect(usageRetentionDays()).toBe(30)
    process.env.USAGE_LOG_RETENTION_DAYS = 'soon'
    expect(usageRetentionDays()).toBe(90)
  })
})
