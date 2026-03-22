import Database, { Database as SqliteDatabase } from 'better-sqlite3'
import { join } from 'path'
import { readFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const dbPath = process.env.DATABASE_PATH ?? join(process.cwd(), 'data', 'cortex.db')
const dbDir = dirname(dbPath)

if (!existsSync(dbDir)) {
  mkdirSync(dbDir, { recursive: true })
}

const db: SqliteDatabase = new Database(dbPath, { 
  verbose: process.env.NODE_ENV === 'development' ? console.log : undefined 
})

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL')

// Initialize schema — resolve relative to THIS file, not cwd()
const schemaPath = join(__dirname, 'schema.sql')
const schemaStr = readFileSync(schemaPath, 'utf-8')
db.exec(schemaStr)

// Safe migrations for early schema changes without drop
try {
  db.exec('ALTER TABLE projects ADD COLUMN git_username TEXT')
} catch (e) { /* ignore if exists */ }

try {
  db.exec('ALTER TABLE projects ADD COLUMN git_token TEXT')
} catch (e) { /* ignore if exists */ }

// Add missing columns to api_keys (added after initial schema)
try {
  db.exec('ALTER TABLE api_keys ADD COLUMN permissions TEXT')
} catch (e) { /* ignore if exists */ }

try {
  db.exec('ALTER TABLE api_keys ADD COLUMN project_id TEXT')
} catch (e) { /* ignore if exists */ }

// Mem9 embedding status on index_jobs
try {
  db.exec("ALTER TABLE index_jobs ADD COLUMN mem9_status TEXT DEFAULT 'pending'")
} catch (e) { /* ignore if exists */ }

try {
  db.exec('ALTER TABLE index_jobs ADD COLUMN mem9_chunks INTEGER DEFAULT 0')
} catch (e) { /* ignore if exists */ }

// Reset stale mem9 states: 'done' with 0 chunks means embedding never ran
try {
  db.exec("UPDATE index_jobs SET mem9_status = 'pending' WHERE mem9_status = 'done' AND (mem9_chunks IS NULL OR mem9_chunks = 0)")
} catch (e) { /* ignore */ }

if (existsSync(schemaPath)) {
  const schema = readFileSync(schemaPath, 'utf8')
  db.exec(schema)
}

// Auto-cleanup: remove change_events older than 24h (runs every hour)
setInterval(() => {
  try {
    db.prepare(`DELETE FROM change_events WHERE created_at < datetime('now', '-1 day')`).run()
  } catch { /* ignore */ }
}, 60 * 60 * 1000)

// Auto-cleanup: mark stale active sessions as completed (> 4 hours old)
setInterval(() => {
  try {
    db.prepare(
      `UPDATE session_handoffs SET status = 'completed'
       WHERE status = 'active' AND created_at < datetime('now', '-4 hours')`
    ).run()
  } catch { /* ignore */ }
}, 30 * 60 * 1000) // check every 30 minutes

export { db }
