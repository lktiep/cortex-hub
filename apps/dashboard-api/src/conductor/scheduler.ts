// Scheduler (spec §6.8, §6.7). Every tick, in order: (0) active tasks without
// a lease get one, (1) tasks whose lease has passed are reclaimed, (2) tasks
// whose worker has been gone longer than `offlineReclaimMinutes` are
// reclaimed, (3) expired quota rows are deleted, (4) a dispatch pass runs.
// Leases and quota resets are `isoSeconds` text and are compared as such.
import { db } from '../db/client.js'
import { getConductorConfig, type ConductorConfig } from './config.js'
import { dispatch, leaseUntil } from './dispatcher.js'
import { reclaimTask } from './lifecycle.js'
import { getByAgent, lastSeen } from './registry.js'
import { ACTIVE_STATUSES, isoSeconds, taskContext, type TaskRow } from './rows.js'

const TICK_MS = 60_000
const ACTIVE_IN = ACTIVE_STATUSES.map(() => '?').join(', ')

export interface TickResult {
  leasesBackfilled: number
  /** Task ids: the lease reclaims, then the offline ones. */
  reclaimed: string[]
  quotaDeleted: number
}

/** Reclaims one task; a throw is logged so that the other rows still run. True when it went back. */
function reclaim(row: TaskRow, reason: string, now: number): boolean {
  try {
    return reclaimTask(row.id, reason, row.attempt, now).ok
  } catch (err) {
    console.error(`[conductor] scheduler: reclaiming ${row.id} (${reason}) failed:`, err)
    return false
  }
}

/**
 * (0) An active task without a lease (made active before leases existed, or by
 * a legacy route that sets none) gets the lease a dispatch would give it, so that it can expire.
 */
function backfillLeases(now: number, cfg: ConductorConfig): number {
  return db.prepare(`UPDATE conductor_tasks SET lease_expires_at = ? WHERE status IN (${ACTIVE_IN}) AND lease_expires_at IS NULL`)
    .run(leaseUntil(now, cfg), ...ACTIVE_STATUSES).changes
}

/** (1) Active tasks whose lease has passed: the worker, if connected, is told to stop and the failure counted. */
function reclaimExpiredLeases(now: number): string[] {
  const rows = db.prepare(`SELECT * FROM conductor_tasks WHERE status IN (${ACTIVE_IN}) AND lease_expires_at <= ? ORDER BY rowid`)
    .all(...ACTIVE_STATUSES, isoSeconds(now)) as TaskRow[]
  const reclaimed: string[] = []
  for (const row of rows) {
    if (reclaim(row, 'lease expired', now)) reclaimed.push(row.id)
  }
  return reclaimed
}

/**
 * (2) Active tasks whose assignee is not connected and was last seen more than
 * `offlineReclaimMinutes` ago. A pull-mode task has no worker connection to
 * lose, and a task without an assignee no one to be offline: only their
 * lease applies. After a restart an unknown worker counts from the registry's
 * start, so it gets the full window to reconnect.
 */
function reclaimOffline(now: number, offlineMinutes: number, skip: ReadonlySet<string>): string[] {
  const seenBefore = now - offlineMinutes * 60_000
  const rows = db.prepare(`SELECT * FROM conductor_tasks WHERE status IN (${ACTIVE_IN}) AND assigned_to_agent IS NOT NULL ORDER BY rowid`)
    .all(...ACTIVE_STATUSES) as TaskRow[]
  const reclaimed: string[] = []
  for (const row of rows) {
    const agent = row.assigned_to_agent
    if (agent === null || skip.has(row.id) || getByAgent(agent) !== undefined || taskContext(row).pull) continue
    if (lastSeen(agent, now) >= seenBefore) continue
    if (reclaim(row, 'worker offline', now)) reclaimed.push(row.id)
  }
  return reclaimed
}

/** One scheduler pass (spec §6.8). Each step reads its rows afresh. */
export function runSchedulerTick(now: number = Date.now()): TickResult {
  const cfg = getConductorConfig()
  const leasesBackfilled = backfillLeases(now, cfg)
  const expired = reclaimExpiredLeases(now)
  const offline = reclaimOffline(now, cfg.offlineReclaimMinutes, new Set(expired))
  // (3) the dispatcher already ignores these rows; deleting them keeps the table to live quota
  const quotaDeleted = db.prepare('DELETE FROM conductor_quota WHERE exhausted_until <= ?').run(isoSeconds(now)).changes
  // (4)
  dispatch(now)
  return { leasesBackfilled, reclaimed: [...expired, ...offline], quotaDeleted }
}

/**
 * Runs `runSchedulerTick` every `intervalMs`. A failing tick is logged, not
 * thrown: a throw in a timer would take the hub down. The timer does not keep
 * the process alive. Returns the function that stops it.
 */
export function scheduleConductor(intervalMs: number = TICK_MS): () => void {
  const timer = setInterval(() => {
    try {
      runSchedulerTick()
    } catch (err) {
      console.error('[conductor] scheduler tick failed:', err)
    }
  }, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
