import type Database from 'better-sqlite3'

// One ALTER per column; each in its own try/catch so an existing column (or a
// missing table on a fresh database, where schema.sql creates it whole) is ignored.
const CONDUCTOR_TASK_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['api_key_owner', 'TEXT'],
  ['task_key', 'TEXT'],
  ['kind', "TEXT DEFAULT 'work'"],
  ['approver', 'TEXT'],
  ['executor', 'TEXT'],
  ['model', 'TEXT'],
  ['effort', 'TEXT'],
  ['fallback', 'TEXT'],
  ['files', "TEXT DEFAULT '[]'"],
  ['branch', 'TEXT'],
  ['pinned_agent', 'TEXT'],
  ['review_required', 'INTEGER DEFAULT 0'],
  ['attempt', 'INTEGER DEFAULT 0'],
  ['fail_count', 'INTEGER DEFAULT 0'],
  ['reject_count', 'INTEGER DEFAULT 0'],
  ['current_route', 'TEXT'],
  ['lease_expires_at', 'TEXT'],
  ['wait_reason', 'TEXT'],
  ['wait_until', 'TEXT'],
  ['escalated_at', 'TEXT'],
  ['last_agent', 'TEXT'],
]

export function applyConductorMigrations(db: Database.Database): void {
  for (const [name, type] of CONDUCTOR_TASK_COLUMNS) {
    try { db.exec(`ALTER TABLE conductor_tasks ADD COLUMN ${name} ${type}`) } catch { /* ignore if exists */ }
  }
}
