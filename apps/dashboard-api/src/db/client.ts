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

// Conductor Phase 1v2: session identity columns
const sessionIdentityCols = [
  'ALTER TABLE session_handoffs ADD COLUMN hostname TEXT',
  'ALTER TABLE session_handoffs ADD COLUMN os TEXT',
  'ALTER TABLE session_handoffs ADD COLUMN ide TEXT',
  'ALTER TABLE session_handoffs ADD COLUMN branch TEXT',
  'ALTER TABLE session_handoffs ADD COLUMN capabilities TEXT DEFAULT \'[]\'',
  'ALTER TABLE session_handoffs ADD COLUMN role TEXT',
  "ALTER TABLE session_handoffs ADD COLUMN last_activity TEXT DEFAULT (datetime('now', 'localtime'))",
]
for (const sql of sessionIdentityCols) {
  try { db.exec(sql) } catch (e) { /* ignore if column exists */ }
}
// Knowledge evolution: quality counters + lineage metadata (OpenSpace-inspired)
const knowledgeEvolutionCols = [
  'ALTER TABLE knowledge_documents ADD COLUMN selection_count INTEGER DEFAULT 0',
  'ALTER TABLE knowledge_documents ADD COLUMN applied_count INTEGER DEFAULT 0',
  'ALTER TABLE knowledge_documents ADD COLUMN completion_count INTEGER DEFAULT 0',
  'ALTER TABLE knowledge_documents ADD COLUMN fallback_count INTEGER DEFAULT 0',
  "ALTER TABLE knowledge_documents ADD COLUMN origin TEXT DEFAULT 'manual'",
  'ALTER TABLE knowledge_documents ADD COLUMN generation INTEGER DEFAULT 0',
  'ALTER TABLE knowledge_documents ADD COLUMN source_task_id TEXT',
  'ALTER TABLE knowledge_documents ADD COLUMN created_by_agent TEXT',
  "ALTER TABLE knowledge_documents ADD COLUMN category TEXT DEFAULT 'general'",
]
for (const sql of knowledgeEvolutionCols) {
  try { db.exec(sql) } catch (e) { /* ignore if column exists */ }
}

// MemPalace-inspired memory hierarchy + temporal validity
const memoryHierarchyCols = [
  "ALTER TABLE knowledge_documents ADD COLUMN hall_type TEXT DEFAULT 'general' CHECK(hall_type IN ('fact','event','discovery','preference','advice','general'))",
  "ALTER TABLE knowledge_documents ADD COLUMN valid_from TEXT",
  "ALTER TABLE knowledge_documents ADD COLUMN invalidated_at TEXT",
  "ALTER TABLE knowledge_documents ADD COLUMN superseded_by TEXT",
  "CREATE INDEX IF NOT EXISTS idx_knowledge_hall_type ON knowledge_documents(hall_type)",
  "CREATE INDEX IF NOT EXISTS idx_knowledge_valid_from ON knowledge_documents(valid_from)",
  "CREATE INDEX IF NOT EXISTS idx_knowledge_invalidated_at ON knowledge_documents(invalidated_at)",
]
for (const sql of memoryHierarchyCols) {
  try { db.exec(sql) } catch { /* ignore if exists */ }
}

if (existsSync(schemaPath)) {
  const schema = readFileSync(schemaPath, 'utf8')
  db.exec(schema)
}

export { db }
