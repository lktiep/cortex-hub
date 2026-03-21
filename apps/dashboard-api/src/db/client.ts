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

if (existsSync(schemaPath)) {
  const schema = readFileSync(schemaPath, 'utf8')
  db.exec(schema)
}

export { db }
