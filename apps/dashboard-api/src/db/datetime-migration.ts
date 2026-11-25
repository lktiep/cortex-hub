import type Database from 'better-sqlite3'

// ── Legacy timestamps to UTC ISO-8601 ──
//
// Old versions stored timestamps without a timezone ('2026-05-01 10:00:00'), which Node
// reads as local time. These run at every boot, before the API listens.
//
// They used to `SELECT *` every table into memory on every boot. usage_logs alone reached
// 4.5M rows, and the boot died at the heap limit inside better-sqlite3's all(). Now SQL
// picks only the rows to change, a batch at a time, and each table remembers the rowid it
// was scanned up to: a later boot reads only rows added since. Those are still checked
// because an older image run against the same file (a rollback) writes the old format
// again; nothing in this version does.

export const TIMESTAMP_COLUMNS: ReadonlyArray<{ table: string; cols: readonly string[] }> = [
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
  { table: 'knowledge_links', cols: ['created_at'] },
  { table: 'provider_accounts', cols: ['created_at', 'updated_at'] },
  { table: 'model_routing', cols: ['updated_at'] },
  { table: 'agent_ack', cols: ['updated_at'] },
  { table: 'budget_settings', cols: ['updated_at'] },
  { table: 'change_events', cols: ['created_at'] },
  { table: 'quality_reports', cols: ['created_at'] },
]

/** hub_config key holding { table: rowid scanned up to }. */
export const TIMESTAMP_SCAN_KEY = 'migration.utc_timestamps.scanned_rowid'

const DEFAULT_BATCH = 1000

/** A timezone-less timestamp as YYYY-MM-DDTHH:MM:SSZ, read as UTC; anything else unchanged. */
export function toUtcIso(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return value
  let formatted = trimmed
  if (!formatted.includes('T') && formatted.includes(' ')) formatted = formatted.replace(' ', 'T')
  // SQLite's own defaults are UTC; without the Z, Node would read them as local time.
  if (!formatted.includes('Z') && !/[+-]\d{2}:?\d{2}$/.test(formatted)) formatted += 'Z'
  const parsed = new Date(formatted)
  if (isNaN(parsed.getTime())) return value
  return parsed.toISOString().split('.')[0] + 'Z'
}

/** SQL true for a text value with no 'Z' and no ±HH:MM / ±HHMM suffix: the rows toUtcIso may change. */
function lacksTimezone(col: string): string {
  return `(typeof("${col}") = 'text' AND instr("${col}", 'Z') = 0`
    + ` AND "${col}" NOT GLOB '*[+-][0-9][0-9][0-9][0-9]' AND "${col}" NOT GLOB '*[+-][0-9][0-9]:[0-9][0-9]')`
}

function tableExists(db: Database.Database, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined
}

function existingColumns(db: Database.Database, table: string, cols: readonly string[]): string[] {
  const have = new Set((db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((c) => c.name))
  return cols.filter((c) => have.has(c))
}

function readScanMarks(db: Database.Database): Record<string, number> {
  const row = db.prepare('SELECT value FROM hub_config WHERE key = ?').get(TIMESTAMP_SCAN_KEY) as { value: string } | undefined
  if (!row) return {}
  try {
    const parsed: unknown = JSON.parse(row.value)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {}
  } catch {
    return {}
  }
}

export interface TimestampMigrationResult {
  /** Rows read into memory: only those SQL found without a timezone. */
  scanned: number
  converted: number
}

/**
 * Rewrite timezone-less timestamps as UTC ISO-8601. Memory stays at one batch of rows,
 * whatever the table sizes; a table is read from the rowid the previous run reached.
 */
export function migrateLegacyTimestamps(
  db: Database.Database,
  opts: { batchSize?: number; tables?: typeof TIMESTAMP_COLUMNS } = {},
): TimestampMigrationResult {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH
  const result: TimestampMigrationResult = { scanned: 0, converted: 0 }
  const marks = readScanMarks(db)

  for (const { table, cols } of opts.tables ?? TIMESTAMP_COLUMNS) {
    try {
      if (!tableExists(db, table)) continue
      const present = existingColumns(db, table, cols)
      if (present.length === 0) continue

      const maxRowid = (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM "${table}"`).get() as { m: number }).m
      // A mark past the end means the table was emptied or rebuilt: start over.
      let after = marks[table] !== undefined && marks[table] <= maxRowid ? marks[table] : 0
      if (after >= maxRowid) {
        marks[table] = maxRowid
        continue
      }

      const select = db.prepare(
        `SELECT rowid AS rid, ${present.map((c) => `"${c}"`).join(', ')} FROM "${table}"
          WHERE rowid > ? AND rowid <= ? AND (${present.map(lacksTimezone).join(' OR ')})
          ORDER BY rowid LIMIT ?`,
      )
      const batch = db.transaction((rows: Array<Record<string, unknown>>) => {
        for (const row of rows) {
          const sets: string[] = []
          const params: unknown[] = []
          for (const col of present) {
            const value = row[col]
            if (typeof value !== 'string') continue
            const fixed = toUtcIso(value)
            if (fixed !== value) {
              sets.push(`"${col}" = ?`)
              params.push(fixed)
            }
          }
          if (sets.length === 0) continue
          db.prepare(`UPDATE "${table}" SET ${sets.join(', ')} WHERE rowid = ?`).run(...params, row.rid)
          result.converted++
        }
      })

      for (;;) {
        const rows = select.all(after, maxRowid, batchSize) as Array<Record<string, unknown>>
        if (rows.length === 0) break
        result.scanned += rows.length
        batch(rows)
        after = rows[rows.length - 1]?.rid as number
        if (rows.length < batchSize) break
      }
      marks[table] = maxRowid
    } catch (err) {
      console.warn(`[Migration] Failed migrating timestamps of ${table}:`, err)
    }
  }

  db.prepare(
    "INSERT OR REPLACE INTO hub_config (key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))",
  ).run(TIMESTAMP_SCAN_KEY, JSON.stringify(marks))
  return result
}

// ── One-time reversion of timestamps double-shifted on 2026-05-22 ──

export const DOUBLE_SHIFT_REVERT_KEY = 'timezone_recovery_v3_revert_double_shift'

const DOUBLE_SHIFTED_COLUMNS: ReadonlyArray<{ table: string; cols: readonly string[] }> = [
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

/**
 * Shift back by `offsetHours` the UTC timestamps between 2026-05-22T23:00 and 2026-05-23T06:59,
 * once (hub_config marks it done). One UPDATE per column: nothing is read into memory.
 * Returns the rows changed, or null when it had already run.
 */
export function revertDoubleShiftedTimestamps(db: Database.Database, offsetHours: number): number | null {
  if (db.prepare('SELECT 1 FROM hub_config WHERE key = ?').get(DOUBLE_SHIFT_REVERT_KEY)) return null
  const modifier = `${offsetHours >= 0 ? '+' : ''}${offsetHours} hours`
  let changed = 0
  db.transaction(() => {
    for (const { table, cols } of DOUBLE_SHIFTED_COLUMNS) {
      try {
        if (!tableExists(db, table)) continue
        for (const col of existingColumns(db, table, cols)) {
          changed += db.prepare(
            `UPDATE "${table}" SET "${col}" = strftime('%Y-%m-%dT%H:%M:%SZ', "${col}", ?)
              WHERE typeof("${col}") = 'text' AND instr("${col}", 'Z') > 0
                AND ("${col}" GLOB '2026-05-22T23:*' OR "${col}" GLOB '2026-05-23T0[0-6]:*')`,
          ).run(modifier).changes
        }
      } catch (err) {
        console.warn(`[Recovery V3] Failed reverting table ${table}:`, err)
      }
    }
    const mark = db.prepare(
      "INSERT OR REPLACE INTO hub_config (key, value, updated_at) VALUES (?, 'true', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))",
    )
    mark.run(DOUBLE_SHIFT_REVERT_KEY)
    // V2 must never run on this database either.
    mark.run('timezone_recovery_v2_done')
  })()
  return changed
}
