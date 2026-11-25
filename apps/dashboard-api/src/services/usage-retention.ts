import type Database from 'better-sqlite3'
import { createLogger } from '@cortex/shared-utils'
import { db } from '../db/client.js'

// ── Usage log retention ──
//
// usage_logs gets a row per LLM call and per tool call that spent compute tokens, and nothing
// ever removed one: one hub reached 4.5M rows (450 MB with its index). The Usage page reads at
// most 90 days back (its heatmap and /api/usage/history?days=90); the budget check reads the
// current month. Rows older than USAGE_LOG_RETENTION_DAYS are deleted in small batches,
// off the boot path, yielding between batches so requests keep being served. The all-time
// totals on that page (requests, tokens, by model, by agent) then cover the kept window.
// SQLite reuses the freed pages for new rows; giving the space back to the disk takes a VACUUM.

const logger = createLogger('usage-retention')

const FIRST_RUN_DELAY_MS = 2 * 60 * 1000
const RUN_INTERVAL_MS = 6 * 60 * 60 * 1000
const DEFAULT_RETENTION_DAYS = 90
const DEFAULT_BATCH = 5000

/** Days of usage_logs to keep; 0 keeps everything. */
export function usageRetentionDays(): number {
  const raw = process.env.USAGE_LOG_RETENTION_DAYS?.trim()
  if (!raw) return DEFAULT_RETENTION_DAYS
  const days = Number(raw)
  if (!Number.isFinite(days) || days < 0) return DEFAULT_RETENTION_DAYS
  return days
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
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/** Prune two minutes after start, then every six hours. Off when USAGE_LOG_RETENTION_DAYS is 0. */
export function scheduleUsageRetention(): void {
  const days = usageRetentionDays()
  if (days <= 0) {
    logger.info('Usage log retention off (USAGE_LOG_RETENTION_DAYS=0)')
    return
  }
  logger.info(`Usage log retention on: usage_logs rows older than ${days} days are deleted`)
  let running = false
  const run = () => {
    if (running) return
    running = true
    pruneUsageLogs(db, days)
      .then((deleted) => {
        if (deleted > 0) logger.info(`Usage log retention: ${deleted} row(s) older than ${days} days deleted`)
      })
      .catch((err) => logger.warn(`Usage log retention failed: ${String(err).slice(0, 200)}`))
      .finally(() => { running = false })
  }
  setTimeout(run, FIRST_RUN_DELAY_MS).unref()
  setInterval(run, RUN_INTERVAL_MS).unref()
}
