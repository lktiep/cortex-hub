import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { applyConductorMigrations } from './conductor-migrations.js'
import { createTestDb } from '../conductor/testing.js'

const here = dirname(fileURLToPath(import.meta.url))

const NEW_COLUMNS = [
  'api_key_owner', 'task_key', 'kind', 'approver', 'executor', 'model', 'effort', 'fallback', 'files',
  'branch', 'pinned_agent', 'review_required', 'attempt', 'fail_count', 'reject_count', 'current_route',
  'lease_expires_at', 'wait_reason', 'wait_until', 'escalated_at', 'last_agent',
]

const OLD_TABLE = `CREATE TABLE conductor_tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    project_id TEXT,
    parent_task_id TEXT,
    created_by_agent TEXT,
    assigned_to_agent TEXT,
    assigned_session_id TEXT,
    status TEXT DEFAULT 'pending'
        CHECK(status IN ('pending','blocked','assigned','accepted','in_progress','analyzing','strategy_review','synthesis','discussion','review','approved','rejected','completed','failed','cancelled')),
    priority INTEGER DEFAULT 5,
    required_capabilities TEXT DEFAULT '[]',
    depends_on TEXT DEFAULT '[]',
    notify_on_complete TEXT DEFAULT '[]',
    notified_agents TEXT DEFAULT '[]',
    context TEXT DEFAULT '{}',
    result TEXT,
    completed_by TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    assigned_at TEXT,
    accepted_at TEXT,
    completed_at TEXT
)`

function columns(db: Database.Database): string[] {
  return (db.prepare('PRAGMA table_info(conductor_tasks)').all() as Array<{ name: string }>).map((c) => c.name)
}

describe('conductor migrations', () => {
  it('adds every new column to an old-shape table', () => {
    const db = new Database(':memory:')
    db.exec(OLD_TABLE)
    db.prepare("INSERT INTO conductor_tasks (id, title) VALUES ('t1', 'old')").run()
    applyConductorMigrations(db)
    applyConductorMigrations(db)
    expect(columns(db)).toEqual(expect.arrayContaining(NEW_COLUMNS))
    const row = db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get('t1') as Record<string, unknown>
    expect(row.kind).toBe('work')
    expect(row.review_required).toBe(0)
    expect(row.attempt).toBe(0)
    expect(row.fail_count).toBe(0)
    expect(row.reject_count).toBe(0)
    expect(row.files).toBe('[]')
  })

  it('schema.sql alone creates the same columns', () => {
    const db = createTestDb()
    expect(columns(db)).toEqual(expect.arrayContaining(NEW_COLUMNS))
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name)
    expect(tables).toEqual(expect.arrayContaining(['conductor_quota', 'conductor_notifications']))
    const cfg = db.prepare("SELECT value FROM hub_config WHERE key = 'conductor.defaultFallback'").get() as { value: string }
    expect(cfg.value).toBe('[{"executor":"claude","model":"opus"}]')
  })

  it('an old-shape table survives schema.sql after the migrations', () => {
    const db = new Database(':memory:')
    db.exec(OLD_TABLE)
    applyConductorMigrations(db)
    const schema = readFileSync(join(here, 'schema.sql'), 'utf-8')
    expect(() => db.exec(schema)).not.toThrow()
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_conductor_tasks_kind_status'").get()
    expect(idx).toBeDefined()
  })
})
