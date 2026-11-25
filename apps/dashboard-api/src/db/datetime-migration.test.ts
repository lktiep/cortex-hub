import { describe, it, expect, beforeEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from '../conductor/testing.js'
import {
  migrateLegacyTimestamps,
  revertDoubleShiftedTimestamps,
  toUtcIso,
  TIMESTAMP_SCAN_KEY,
  DOUBLE_SHIFT_REVERT_KEY,
} from './datetime-migration.js'

let db: Database.Database

const BIG = 20_000

/** BIG usage_logs rows in the current format, plus the given legacy ones at the given ids. */
function seedUsage(legacy: Record<number, string>) {
  db.exec(`
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${BIG})
    INSERT INTO usage_logs (id, agent_id, model, total_tokens, created_at)
    SELECT i, 'agent', 'm', i, strftime('%Y-%m-%dT%H:%M:%SZ', '2026-11-01', '+' || i || ' seconds') FROM n
  `)
  const update = db.prepare('UPDATE usage_logs SET created_at = ? WHERE id = ?')
  for (const [id, value] of Object.entries(legacy)) update.run(value, Number(id))
}

const createdAt = (id: number) =>
  (db.prepare('SELECT created_at FROM usage_logs WHERE id = ?').get(id) as { created_at: string }).created_at

beforeEach(() => {
  db = createTestDb()
})

describe('toUtcIso', () => {
  it('reads a timezone-less value as UTC and keeps the rest', () => {
    expect(toUtcIso('2026-05-01 10:00:00')).toBe('2026-05-01T10:00:00Z')
    expect(toUtcIso('2026-05-01T10:00:00')).toBe('2026-05-01T10:00:00Z')
    expect(toUtcIso('2026-05-01')).toBe('2026-05-01T00:00:00Z')
    expect(toUtcIso('not a date')).toBe('not a date')
  })
})

describe('migrateLegacyTimestamps', () => {
  const tables = [{ table: 'usage_logs', cols: ['created_at'] }]

  it('converts only the legacy rows of a big table and reads no others', () => {
    seedUsage({ 5: '2026-05-01 10:00:00', 7_777: '2026-05-02T11:30:00', 19_999: '2026-05-03' })
    db.prepare("UPDATE usage_logs SET created_at = '2026-05-04T01:00:00+07:00' WHERE id = 8").run()
    db.prepare("UPDATE usage_logs SET created_at = '2026-05-04T01:00:00-0700' WHERE id = 9").run()
    db.prepare('UPDATE usage_logs SET created_at = NULL WHERE id = 10').run()
    const allSpy = vi.spyOn(db, 'prepare')

    const result = migrateLegacyTimestamps(db, { batchSize: 2, tables })

    expect(result).toEqual({ scanned: 3, converted: 3 })
    expect(createdAt(5)).toBe('2026-05-01T10:00:00Z')
    expect(createdAt(7_777)).toBe('2026-05-02T11:30:00Z')
    expect(createdAt(19_999)).toBe('2026-05-03T00:00:00Z')
    expect(createdAt(8)).toBe('2026-05-04T01:00:00+07:00')
    expect(createdAt(9)).toBe('2026-05-04T01:00:00-0700')
    expect(createdAt(1)).toBe('2026-11-01T00:00:01Z')
    // No statement reads a whole table.
    for (const [sql] of allSpy.mock.calls) expect(String(sql)).not.toMatch(/SELECT \* FROM/i)
    allSpy.mockRestore()
  })

  it('reads nothing on the next boot, and only rows added since after that', () => {
    seedUsage({ 3: '2026-05-01 10:00:00' })
    migrateLegacyTimestamps(db, { tables })
    expect(JSON.parse((db.prepare('SELECT value FROM hub_config WHERE key = ?').get(TIMESTAMP_SCAN_KEY) as { value: string }).value))
      .toEqual({ usage_logs: BIG })

    expect(migrateLegacyTimestamps(db, { tables })).toEqual({ scanned: 0, converted: 0 })

    // An older image writing the old format again: the next boot fixes just that row.
    db.prepare("INSERT INTO usage_logs (id, agent_id, model, created_at) VALUES (?, 'a', 'm', '2026-11-20 08:00:00')").run(BIG + 1)
    expect(migrateLegacyTimestamps(db, { tables })).toEqual({ scanned: 1, converted: 1 })
    expect(createdAt(BIG + 1)).toBe('2026-11-20T08:00:00Z')
  })

  it('starts over when the table was emptied below its mark', () => {
    seedUsage({})
    migrateLegacyTimestamps(db, { tables })
    db.exec('DELETE FROM usage_logs')
    db.exec("DELETE FROM sqlite_sequence WHERE name = 'usage_logs'")
    db.prepare("INSERT INTO usage_logs (agent_id, model, created_at) VALUES ('a', 'm', '2026-11-20 08:00:00')").run()
    expect(migrateLegacyTimestamps(db, { tables })).toEqual({ scanned: 1, converted: 1 })
  })

  it('handles tables keyed by something other than id, and skips missing tables and columns', () => {
    db.prepare("INSERT INTO hub_config (key, value, updated_at) VALUES ('legacy', 'x', '2026-05-01 10:00:00')").run()
    const result = migrateLegacyTimestamps(db, {
      tables: [
        { table: 'hub_config', cols: ['updated_at', 'no_such_column'] },
        { table: 'no_such_table', cols: ['created_at'] },
      ],
    })
    expect(result.converted).toBe(1)
    expect((db.prepare("SELECT updated_at FROM hub_config WHERE key = 'legacy'").get() as { updated_at: string }).updated_at)
      .toBe('2026-05-01T10:00:00Z')
  })
})

describe('revertDoubleShiftedTimestamps', () => {
  it('shifts back only the double-shifted window, once', () => {
    seedUsage({})
    db.prepare("UPDATE usage_logs SET created_at = '2026-05-22T23:15:00Z' WHERE id = 1").run()
    db.prepare("UPDATE usage_logs SET created_at = '2026-05-23T06:59:59Z' WHERE id = 2").run()
    db.prepare("UPDATE usage_logs SET created_at = '2026-05-23T07:00:00Z' WHERE id = 3").run()

    expect(revertDoubleShiftedTimestamps(db, -7)).toBe(2)
    expect(createdAt(1)).toBe('2026-05-22T16:15:00Z')
    expect(createdAt(2)).toBe('2026-05-22T23:59:59Z')
    expect(createdAt(3)).toBe('2026-05-23T07:00:00Z')
    expect(db.prepare('SELECT 1 FROM hub_config WHERE key = ?').get(DOUBLE_SHIFT_REVERT_KEY)).toBeDefined()

    db.prepare("UPDATE usage_logs SET created_at = '2026-05-23T01:00:00Z' WHERE id = 4").run()
    expect(revertDoubleShiftedTimestamps(db, -7)).toBeNull()
    expect(createdAt(4)).toBe('2026-05-23T01:00:00Z')
  })
})
