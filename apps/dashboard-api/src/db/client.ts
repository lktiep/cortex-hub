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

try {
  db.exec('ALTER TABLE projects ADD COLUMN enabled BOOLEAN DEFAULT 1')
} catch (e) { /* ignore if exists */ }

// Conductor Phase 1v2: session identity columns
const sessionIdentityCols = [
  'ALTER TABLE session_handoffs ADD COLUMN hostname TEXT',
  'ALTER TABLE session_handoffs ADD COLUMN os TEXT',
  'ALTER TABLE session_handoffs ADD COLUMN ide TEXT',
  'ALTER TABLE session_handoffs ADD COLUMN branch TEXT',
  'ALTER TABLE session_handoffs ADD COLUMN capabilities TEXT DEFAULT \'[]\'',
  'ALTER TABLE session_handoffs ADD COLUMN role TEXT',
  "ALTER TABLE session_handoffs ADD COLUMN last_activity TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))",
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

// Index jobs: extended status + git metadata + mem9 + docs-knowledge progress
const indexJobsCols = [
  'ALTER TABLE index_jobs ADD COLUMN triggered_by TEXT',
  'ALTER TABLE index_jobs ADD COLUMN commit_hash TEXT',
  'ALTER TABLE index_jobs ADD COLUMN commit_message TEXT',
  'ALTER TABLE index_jobs ADD COLUMN mem9_status TEXT',
  'ALTER TABLE index_jobs ADD COLUMN mem9_chunks INTEGER DEFAULT 0',
  'ALTER TABLE index_jobs ADD COLUMN mem9_progress INTEGER DEFAULT 0',
  'ALTER TABLE index_jobs ADD COLUMN mem9_total_chunks INTEGER DEFAULT 0',
  'ALTER TABLE index_jobs ADD COLUMN docs_knowledge_status TEXT',
  'ALTER TABLE index_jobs ADD COLUMN docs_knowledge_count INTEGER DEFAULT 0',
]
for (const sql of indexJobsCols) {
  try { db.exec(sql) } catch { /* ignore if exists */ }
}

// Query logs: cost tracking columns
const queryLogsCols = [
  'ALTER TABLE query_logs ADD COLUMN input_size INTEGER DEFAULT 0',
  'ALTER TABLE query_logs ADD COLUMN output_size INTEGER DEFAULT 0',
  'ALTER TABLE query_logs ADD COLUMN compute_tokens INTEGER DEFAULT 0',
  'ALTER TABLE query_logs ADD COLUMN compute_model TEXT',
]
for (const sql of queryLogsCols) {
  try { db.exec(sql) } catch { /* ignore if exists */ }
}

// Session handoffs: api key audit trail
try { db.exec('ALTER TABLE session_handoffs ADD COLUMN api_key_name TEXT') } catch { /* ignore if exists */ }

// Conductor tasks: api key ownership
try { db.exec('ALTER TABLE conductor_tasks ADD COLUMN api_key_owner TEXT') } catch { /* ignore if exists */ }

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

// Missing incremental migrations from the installer script
const dynamicInstallerPatches = [
  "ALTER TABLE provider_accounts ADD COLUMN auth_type TEXT",
  "ALTER TABLE provider_accounts ADD COLUMN api_base TEXT",
  "ALTER TABLE provider_accounts ADD COLUMN capabilities TEXT DEFAULT '[]'",
  "ALTER TABLE provider_accounts ADD COLUMN models TEXT DEFAULT '[]'",
  "ALTER TABLE provider_accounts ADD COLUMN created_at TEXT",
  "ALTER TABLE provider_accounts ADD COLUMN updated_at TEXT",
]
for (const sql of dynamicInstallerPatches) {
  try { db.exec(sql) } catch (e) { /* ignore if column exists */ }
}

if (existsSync(schemaPath)) {
  const schema = readFileSync(schemaPath, 'utf8')
  db.exec(schema)
}

// ── Self-Healing Date-Time Migration ──
// Automatically converts any legacy timezone-less local timestamps in the SQLite database to strict ISO-8601 UTC strings YYYY-MM-DDTHH:MM:SSZ.
try {
  const tablesAndCols = [
    { table: 'setup_status', cols: ['completed_at'] },
    { table: 'api_keys', cols: ['created_at', 'expires_at', 'last_used_at'] },
    { table: 'query_logs', cols: ['created_at'] },
    { table: 'session_handoffs', cols: ['created_at', 'expires_at', 'last_activity'] },
    { table: 'organizations', cols: ['created_at', 'updated_at'] },
    { table: 'projects', cols: ['created_at', 'updated_at', 'indexed_at'] },
    { table: 'index_jobs', cols: ['created_at', 'started_at', 'completed_at'] },
    { table: 'usage_logs', cols: ['created_at'] },
    { table: 'conductor_tasks', cols: ['created_at', 'assigned_at', 'accepted_at', 'completed_at'] },
    { table: 'conductor_task_logs', cols: ['created_at'] },
    { table: 'conductor_comments', cols: ['created_at'] },
    { table: 'hub_config', cols: ['updated_at'] },
    { table: 'notification_preferences', cols: ['updated_at'] },
    { table: 'knowledge_lineage', cols: ['created_at'] },
    { table: 'knowledge_usage_log', cols: ['created_at'] },
    { table: 'recipe_capture_log', cols: ['created_at'] },
    { table: 'knowledge_documents', cols: ['created_at', 'updated_at', 'valid_from', 'invalidated_at'] },
    { table: 'knowledge_chunks', cols: ['created_at'] },
    { table: 'provider_accounts', cols: ['created_at', 'updated_at'] },
    { table: 'model_routing', cols: ['updated_at'] },
    { table: 'agent_ack', cols: ['updated_at'] },
    { table: 'budget_settings', cols: ['updated_at'] },
    { table: 'change_events', cols: ['created_at'] },
    { table: 'quality_reports', cols: ['created_at'] },
  ]

  const toUtcIso = (localStr: string | null | undefined): string | null => {
    if (!localStr) return null
    const trimmed = localStr.trim()
    if (!trimmed) return null
    if (trimmed.includes('T') && trimmed.includes('Z')) return trimmed
    let formatted = trimmed
    if (!formatted.includes('T') && formatted.includes(' ')) {
      formatted = formatted.replace(' ', 'T')
    }
    // Standard SQLite date-time defaults are written in UTC time.
    // If there is no timezone indicator, treat it as UTC ('Z') to prevent Node.js 
    // from incorrectly parsing it as local time and shifting the hours.
    if (!formatted.includes('Z') && !formatted.match(/[+-]\d{2}:?\d{2}$/)) {
      formatted = formatted + 'Z'
    }
    const parsed = new Date(formatted)
    if (isNaN(parsed.getTime())) return trimmed
    return parsed.toISOString().split('.')[0] + 'Z'
  }

  const migrateTx = db.transaction(() => {
    for (const { table, cols } of tablesAndCols) {
      try {
        const tableCheck = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table)
        if (!tableCheck) continue
        const rows = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, any>[]
        for (const row of rows) {
          let needsUpdate = false
          const updates: string[] = []
          const params: any[] = []
          for (const col of cols) {
            if (row[col] !== undefined && row[col] !== null) {
              const originalVal = String(row[col])
              if (!originalVal.includes('Z') && !originalVal.match(/[+-]\d{2}:?\d{2}$/)) {
                const utcIso = toUtcIso(originalVal)
                if (utcIso && utcIso !== originalVal) {
                  needsUpdate = true
                  updates.push(`${col} = ?`)
                  params.push(utcIso)
                }
              }
            }
          }
          if (needsUpdate) {
            let pkCol = 'id'
            if (row.id === undefined) {
              if (row.key !== undefined) pkCol = 'key'
              else if (row.purpose !== undefined) pkCol = 'purpose'
              else if (row.agent_id !== undefined && row.project_id !== undefined) {
                db.prepare(`UPDATE ${table} SET ${updates.join(', ')} WHERE agent_id = ? AND project_id = ?`).run(...params, row.agent_id, row.project_id)
                continue
              }
            }
            db.prepare(`UPDATE ${table} SET ${updates.join(', ')} WHERE ${pkCol} = ?`).run(...params, row[pkCol])
          }
        }
      } catch (err) {
        console.warn(`[Migration] Failed migrating table ${table}:`, err)
      }
    }
  })
  migrateTx()

  // ── One-Time Reversion of Incorrectly Double-Shifted May 22 Timestamps ──
  try {
    const recoveryV3Key = 'timezone_recovery_v3_revert_double_shift'
    const alreadyReverted = db.prepare("SELECT value FROM hub_config WHERE key = ?").get(recoveryV3Key)
    const rawOffset = process.env.RECOVERY_TIMEZONE_OFFSET_HOURS;
    const offsetHours = rawOffset ? parseInt(rawOffset, 10) : NaN;
    if (!alreadyReverted && !isNaN(offsetHours)) {
      const offsetModifier = `${offsetHours >= 0 ? '+' : ''}${offsetHours} hours`;
      const tablesAndColsToRevert = [
        { table: 'api_keys', cols: ['created_at', 'last_used_at'] },
        { table: 'query_logs', cols: ['created_at'] },
        { table: 'projects', cols: ['created_at', 'updated_at', 'indexed_at'] },
        { table: 'index_jobs', cols: ['created_at'] },
        { table: 'usage_logs', cols: ['created_at'] },
        { table: 'setup_status', cols: ['completed_at'] },
        { table: 'model_routing', cols: ['updated_at'] },
        { table: 'budget_settings', cols: ['updated_at'] },
        { table: 'hub_config', cols: ['updated_at'] },
      ]
      db.transaction(() => {
        for (const { table, cols } of tablesAndColsToRevert) {
          try {
            const tableCheck = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table)
            if (!tableCheck) continue
            const rows = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, any>[]
            for (const row of rows) {
              let needsUpdate = false
              const updates: string[] = []
              const params: any[] = []
              for (const col of cols) {
                if (row[col] !== undefined && row[col] !== null) {
                  const val = String(row[col])
                  // Detect timestamps that were double-shifted to May 22/23
                  // Range: 2026-05-22T23:00:00Z to 2026-05-23T06:59:59Z
                  const isDoubleShifted = val.includes('Z') && (
                    val.startsWith('2026-05-22T23:') ||
                    val.startsWith('2026-05-23T00:') ||
                    val.startsWith('2026-05-23T01:') ||
                    val.startsWith('2026-05-23T02:') ||
                    val.startsWith('2026-05-23T03:') ||
                    val.startsWith('2026-05-23T04:') ||
                    val.startsWith('2026-05-23T05:') ||
                    val.startsWith('2026-05-23T06:')
                  )
                  if (isDoubleShifted) {
                    const restored = (db.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%SZ', ?, ?) as r`).get(val, offsetModifier) as any).r
                    needsUpdate = true
                    updates.push(`${col} = ?`)
                    params.push(restored)
                  }
                }
              }
              if (needsUpdate) {
                let pkCol = 'id'
                if (row.id === undefined) {
                  if (row.key !== undefined) pkCol = 'key'
                  else if (row.purpose !== undefined) pkCol = 'purpose'
                }
                db.prepare(`UPDATE ${table} SET ${updates.join(', ')} WHERE ${pkCol} = ?`).run(...params, row[pkCol])
              }
            }
          } catch (e) {
            console.warn(`[Recovery V3] Failed reverting table ${table}:`, e)
          }
        }
        db.prepare("INSERT OR REPLACE INTO hub_config (key, value, updated_at) VALUES (?, 'true', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))").run(recoveryV3Key)
        // Mark V2 recovery done as well to prevent it from ever executing on new/clean databases
        db.prepare("INSERT OR REPLACE INTO hub_config (key, value, updated_at) VALUES (?, 'true', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))").run('timezone_recovery_v2_done')
      })()
    }
  } catch (revertErr) {
    console.warn('[Recovery V3] Timezone reversion failed:', revertErr)
  }
} catch (migrationErr) {
  console.warn('[Migration] Date-time migration failed:', migrationErr)
}

// Create indexes on critical tables to prevent full table scans and timeouts
try {
  db.exec('CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_query_logs_agent_created ON query_logs(agent_id, created_at)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_query_logs_project ON query_logs(project_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_usage_logs_created ON usage_logs(created_at)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_usage_logs_project ON usage_logs(project_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_handoffs_agent_status ON session_handoffs(from_agent, status)')
} catch (e) {
  console.warn('[Migration] Failed to create indexing indexes:', e)
}

export { db }

