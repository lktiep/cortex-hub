import type Database from 'better-sqlite3'
import { createLogger } from '@cortex/shared-utils'
import { db } from '../db/client.js'

// ── Usage log upkeep ──
//
// usage_logs gets a row per LLM call, and nothing ever removed one. On one hub it reached
// 4.5M rows (450 MB with its indexes) in two months, 99.9% of them one row per embeddings
// call from indexing. Two jobs keep it small, off the boot path, a step at a time with the
// event loop free in between:
//
// - Roll-up: embedding rows of each finished hour become one row per agent, model, project
//   and type, carrying the summed tokens and `request_count`, the calls it stands for. The
//   Usage page counts SUM(request_count), so its numbers do not change; only the per-call
//   timestamps inside an hour go.
// - Retention: rows older than USAGE_LOG_RETENTION_DAYS (default 365) are deleted. The
//   Usage page reads 90 days back and the budget check the current month; the page's
//   all-time totals then cover the kept window.
//
// SQLite reuses the freed pages for new rows; giving the space back to the disk takes a VACUUM.

const logger = createLogger('usage-retention')

const FIRST_RUN_DELAY_MS = 2 * 60 * 1000
const RUN_INTERVAL_MS = 6 * 60 * 60 * 1000
const DEFAULT_RETENTION_DAYS = 365
const DEFAULT_BATCH = 5000

/** Request types rolled up per hour. Chat and tool rows are few and kept one per call. */
export const ROLLED_UP_TYPES: readonly string[] = ['embedding']
/** hub_config key: every rolled-up row before this hour boundary has been rolled up. */
export const ROLLED_UP_BEFORE_KEY = 'usage_logs.rolled_up_before'

const TYPES_IN = `request_type IN (${ROLLED_UP_TYPES.map(() => '?').join(', ')})`
const ISO_HOUR = "created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:*'"

/** Days of usage_logs to keep; 0 keeps everything. */
export function usageRetentionDays(): number {
  const raw = process.env.USAGE_LOG_RETENTION_DAYS?.trim()
  if (!raw) return DEFAULT_RETENTION_DAYS
  const days = Number(raw)
  if (!Number.isFinite(days) || days < 0) return DEFAULT_RETENTION_DAYS
  return days
}

const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve))

/**
 * Roll up the oldest hour not yet rolled up, if it ends by `before` (default: the start of
 * the previous hour). Returns the rows it removed, or null when no such hour is left.
 */
export function rollUpUsageLogsHour(conn: Database.Database, before?: string): number | null {
  return conn.transaction((): number | null => {
    const cutoff = (conn.prepare(
      before === undefined
        ? "SELECT strftime('%Y-%m-%dT%H:00:00Z', 'now', '-1 hour') AS c"
        : "SELECT strftime('%Y-%m-%dT%H:00:00Z', ?) AS c",
    ).get(...(before === undefined ? [] : [before])) as { c: string | null }).c
    if (!cutoff) return null
    const done = (conn.prepare('SELECT value FROM hub_config WHERE key = ?').get(ROLLED_UP_BEFORE_KEY) as { value: string } | undefined)?.value ?? ''
    const setDone = (value: string) => conn.prepare(
      "INSERT OR REPLACE INTO hub_config (key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))",
    ).run(ROLLED_UP_BEFORE_KEY, value)

    const next = (conn.prepare(
      `SELECT created_at FROM usage_logs
        WHERE ${TYPES_IN} AND created_at >= ? AND created_at < ? AND ${ISO_HOUR}
        ORDER BY created_at LIMIT 1`,
    ).get(...ROLLED_UP_TYPES, done, cutoff) as { created_at: string } | undefined)?.created_at
    if (!next) {
      if (done < cutoff) setDone(cutoff)
      return null
    }

    const { start, end } = conn.prepare(
      "SELECT strftime('%Y-%m-%dT%H:00:00Z', ?) AS start, strftime('%Y-%m-%dT%H:00:00Z', ?, '+1 hour') AS \"end\"",
    ).get(next, next) as { start: string; end: string }
    const lastRowid = (conn.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM usage_logs').get() as { m: number }).m
    const added = conn.prepare(
      `INSERT INTO usage_logs (agent_id, model, prompt_tokens, completion_tokens, total_tokens, project_id, request_type, created_at, request_count)
       SELECT agent_id, model, SUM(prompt_tokens), SUM(completion_tokens), SUM(total_tokens), project_id, request_type,
              MAX(created_at), SUM(COALESCE(request_count, 1))
         FROM usage_logs
        WHERE ${TYPES_IN} AND created_at >= ? AND created_at < ?
        GROUP BY agent_id, model, project_id, request_type`,
    ).run(...ROLLED_UP_TYPES, start, end).changes
    const removed = conn.prepare(
      `DELETE FROM usage_logs WHERE ${TYPES_IN} AND created_at >= ? AND created_at < ? AND rowid <= ?`,
    ).run(...ROLLED_UP_TYPES, start, end, lastRowid).changes
    setDone(end)
    return removed - added
  })()
}

/** Roll up every finished hour, one hour per transaction, yielding in between. Returns rows removed. */
export async function rollUpUsageLogs(conn: Database.Database, before?: string): Promise<number> {
  let total = 0
  for (;;) {
    const removed = rollUpUsageLogsHour(conn, before)
    if (removed === null) return total
    total += removed
    await yieldToEventLoop()
  }
}

/** Delete up to `batchSize` usage_logs rows older than `days`; returns how many went. */
export function deleteOldUsageLogsBatch(conn: Database.Database, days: number, batchSize = DEFAULT_BATCH): number {
  if (days <= 0) return 0
  return conn.prepare(
    `DELETE FROM usage_logs WHERE rowid IN (
       SELECT rowid FROM usage_logs
        WHERE created_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)
        LIMIT ?
     )`,
  ).run(`-${days} days`, batchSize).changes
}

/** Delete every usage_logs row older than `days`, one batch at a time, yielding in between. */
export async function pruneUsageLogs(
  conn: Database.Database,
  days: number,
  opts: { batchSize?: number } = {},
): Promise<number> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH
  let total = 0
  for (;;) {
    const deleted = deleteOldUsageLogsBatch(conn, days, batchSize)
    total += deleted
    if (deleted < batchSize) return total
    await yieldToEventLoop()
  }
}

/** Roll up and prune two minutes after start, then every six hours. USAGE_LOG_RETENTION_DAYS=0 keeps every row's age. */
export function scheduleUsageRetention(): void {
  const days = usageRetentionDays()
  logger.info(days > 0
    ? `Usage log upkeep on: embedding rows rolled up per hour, rows older than ${days} days deleted`
    : 'Usage log upkeep on: embedding rows rolled up per hour, no age limit (USAGE_LOG_RETENTION_DAYS=0)')
  let running = false
  const run = async () => {
    if (running) return
    running = true
    try {
      const rolled = await rollUpUsageLogs(db)
      if (rolled > 0) logger.info(`Usage log upkeep: ${rolled} row(s) rolled up into hourly rows`)
      const deleted = await pruneUsageLogs(db, days)
      if (deleted > 0) logger.info(`Usage log upkeep: ${deleted} row(s) older than ${days} days deleted`)
    } catch (err) {
      logger.warn(`Usage log upkeep failed: ${String(err).slice(0, 200)}`)
    } finally {
      running = false
    }
  }
  setTimeout(() => void run(), FIRST_RUN_DELAY_MS).unref()
  setInterval(() => void run(), RUN_INTERVAL_MS).unref()
}
