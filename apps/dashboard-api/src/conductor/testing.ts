// Test helpers. Must not import vitest: this file compiles with the app.
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import type { TaskRow } from './rows.js'

const here = dirname(fileURLToPath(import.meta.url))

export function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.exec(readFileSync(join(here, '../db/schema.sql'), 'utf-8'))
  return db
}

export function insertTask(db: Database.Database, partial: Partial<TaskRow> & { id: string }): TaskRow {
  const entries = Object.entries({ title: partial.id, ...partial })
  const cols = entries.map(([k]) => k).join(', ')
  const marks = entries.map(() => '?').join(', ')
  db.prepare(`INSERT INTO conductor_tasks (${cols}) VALUES (${marks})`).run(...entries.map(([, v]) => v))
  return db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(partial.id) as TaskRow
}

export interface FakeSocket {
  sent: unknown[]
  closed: { code: number; reason: string } | null
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
}

export function fakeSocket(): FakeSocket {
  const s: FakeSocket = {
    sent: [],
    closed: null,
    readyState: 1,
    send(data: string) { s.sent.push(JSON.parse(data)) },
    close(code = 1000, reason = '') { s.closed = { code, reason }; s.readyState = 3 },
  }
  return s
}
