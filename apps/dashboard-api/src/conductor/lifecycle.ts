// Task lifecycle, attempt half (spec §6.2, §6.5–§6.7): a worker accepts,
// reports progress, completes, fails, runs out of quota or declines; the lead
// cancels. Each step changes the row, logs and notifies in one transaction.
// After the commit, the worker the step freed is marked idle and a dispatch
// pass runs, so the dispatcher's pushes always follow committed state.
import type { TaskQuotaExhaustedMsg, TaskResult, TaskRevokedMsg } from '@cortex/shared-types'
import { db } from '../db/client.js'
import { getConductorConfig } from './config.js'
import { dispatch } from './dispatcher.js'
import { formatNotification, notifyLead } from './notify.js'
import { getByAgent, sendTo, setStatus } from './registry.js'
import { ACTIVE_STATUSES, getTask, isoSeconds, logTask, taskContext, type TaskRow } from './rows.js'

export type Outcome = { ok: true; task: TaskRow } | { ok: false; status: 403 | 404 | 409; error: string }

const TERMINAL_STATUSES = ['completed', 'cancelled', 'failed'] as const
const PROGRESS_KEPT = 50
const LOG_MESSAGE_MAX = 4000
const LEASE_STEP_MS = 60_000
const QUOTA_DEFAULT_MS = 3600_000
const QUOTA_REASON_MAX = 500
const ESCALATE_AT = 2

function isActive(status: string): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(status)
}

function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status)
}

/** The row as it is now; only used for a task the running transaction has already read. */
function current(taskId: string): TaskRow {
  const task = getTask(taskId)
  if (task === undefined) throw new Error(`conductor task ${taskId} disappeared inside its transaction`)
  return task
}

/**
 * Reads the task inside the caller's transaction. Unknown → 404. A task that
 * `allowed` rejects, or an `attempt` other than the task's current one (a
 * worker re-sending an earlier attempt's outcome) → 409, an `ignored` log row
 * and no other change. Without `attempt` (legacy scripts, REST, MCP) the
 * attempt is not checked.
 */
function load(
  taskId: string, by: string | null, step: string, allowed: (task: TaskRow) => boolean, attempt?: number,
): Outcome {
  const task = getTask(taskId)
  if (task === undefined) return { ok: false, status: 404, error: `task ${taskId} not found` }
  let error: string
  if (!allowed(task)) {
    const holder = task.assigned_to_agent === null ? '' : `, assigned to ${task.assigned_to_agent}`
    error = `${step} ignored: task is ${task.status}${holder}`
  } else if (attempt !== undefined && attempt !== task.attempt) {
    error = `${step} ignored: attempt ${attempt} is stale, the task is on attempt ${task.attempt}`
  } else {
    return { ok: true, task }
  }
  logTask(taskId, by, 'ignored', error)
  return { ok: false, status: 409, error }
}

/** Active and assigned to `agentId`: the worker that holds the task. */
function heldBy(agentId: string): (task: TaskRow) => boolean {
  return (task) => isActive(task.status) && task.assigned_to_agent === agentId
}

/**
 * Back to `pending`, shared by fail, quota, decline and return: the
 * assignment, acceptance and lease are cleared; `branch`, `last_agent` and `attempt` stay,
 * so the next attempt continues on the same branch, preferably on the same machine.
 */
function toPending(task: TaskRow, reason: string): void {
  db.prepare(`
    UPDATE conductor_tasks
    SET status = 'pending', assigned_to_agent = NULL, assigned_at = NULL, accepted_at = NULL, lease_expires_at = NULL
    WHERE id = ?
  `).run(task.id)
  logTask(task.id, task.assigned_to_agent, 'returned', reason.slice(0, LOG_MESSAGE_MAX))
}

function saveContext(task: TaskRow, patch: Record<string, unknown>): void {
  db.prepare('UPDATE conductor_tasks SET context = ? WHERE id = ?').run(JSON.stringify({ ...taskContext(task), ...patch }), task.id)
}

/** What a committed step leaves to do: the worker to mark (null for none) before the dispatch pass. */
interface Settled { outcome: Outcome; worker: string | null; state?: 'idle' | 'busy' }

/**
 * Pushes to workers (revokes, the dispatch pass) must follow a commit. Inside a
 * caller's open transaction the step would only commit with it, so it refuses.
 */
function assertOutsideTransaction(): void {
  if (db.inTransaction) throw new Error('lifecycle: must not run inside a db transaction')
}

/** Runs `step` in one transaction; after a successful commit, marks the worker and dispatches. */
function settle(step: () => Settled, now?: number): Outcome {
  assertOutsideTransaction()
  const { outcome, worker, state = 'idle' } = db.transaction(step)()
  if (!outcome.ok) return outcome
  if (worker !== null) setStatus(worker, state, now)
  dispatch(now)
  return outcome
}

function refused(outcome: Outcome): Settled {
  return { outcome, worker: null }
}

// Task 8: the completion chain (unblock dependents, complete finished groups).
function onCompleted(_task: TaskRow): void {
  // no-op until Task 8
}

// Task 8: the parent check after a cancel (a group whose last open child was cancelled).
function checkParent(_task: TaskRow): void {
  // no-op until Task 8
}

/** `assigned → accepted`. A repeat accept of a task already accepted or running is a no-op. */
export function acceptTask(taskId: string, agentId: string): Outcome {
  return db.transaction((): Outcome => {
    const loaded = load(taskId, agentId, 'accept', heldBy(agentId))
    if (!loaded.ok || loaded.task.status !== 'assigned') return loaded
    db.prepare("UPDATE conductor_tasks SET status = 'accepted', accepted_at = ? WHERE id = ?").run(isoSeconds(Date.now()), taskId)
    logTask(taskId, agentId, 'accepted')
    return { ok: true, task: current(taskId) }
  })()
}

/**
 * Logs the progress (the newest 50 rows are kept), moves `accepted → in_progress`,
 * and extends the lease to now + `leaseHours` when that is more than a minute
 * past the stored one.
 */
export function recordProgress(
  taskId: string, agentId: string, message: string, percent?: number, now: number = Date.now(),
): Outcome {
  return db.transaction((): Outcome => {
    const loaded = load(taskId, agentId, 'progress', heldBy(agentId))
    if (!loaded.ok) return loaded
    const { task } = loaded

    const text = typeof percent === 'number' && Number.isFinite(percent) ? `[${Math.round(percent)}%] ${message}` : message
    logTask(taskId, agentId, 'progress', text.slice(0, LOG_MESSAGE_MAX))
    db.prepare(`
      DELETE FROM conductor_task_logs WHERE task_id = ? AND action = 'progress' AND id NOT IN
        (SELECT id FROM conductor_task_logs WHERE task_id = ? AND action = 'progress' ORDER BY id DESC LIMIT ?)
    `).run(taskId, taskId, PROGRESS_KEPT)

    const leaseMs = now + getConductorConfig().leaseHours * 3600_000
    const storedMs = Date.parse(task.lease_expires_at ?? '')
    const extend = Number.isNaN(storedMs) || leaseMs - storedMs > LEASE_STEP_MS
    const status = task.status === 'accepted' ? 'in_progress' : task.status
    if (status !== task.status || extend) {
      db.prepare('UPDATE conductor_tasks SET status = ?, lease_expires_at = ? WHERE id = ?')
        .run(status, extend ? isoSeconds(leaseMs) : task.lease_expires_at, taskId)
    }
    if (status !== task.status) logTask(taskId, agentId, 'in_progress')
    return { ok: true, task: current(taskId) }
  })()
}

/**
 * `failed` → `failAttempt`. `review`, or `completed` with `review_required` → `review`
 * and the lead is told. Otherwise `completed`. With `agentId` null (REST/MCP)
 * the owner check is skipped, but the task must be active or in `review`; an
 * active one is revoked from its worker first. `attempt`: see `load`.
 */
export function completeTask(
  taskId: string, agentId: string | null, status: 'completed' | 'review' | 'failed', result: TaskResult, attempt?: number,
): Outcome {
  if (status === 'failed') return failAttempt(taskId, agentId, result.error ?? result.summary, attempt)
  assertOutsideTransaction()
  if (agentId === null) {
    const before = getTask(taskId)
    if (before !== undefined && isActive(before.status) && (attempt === undefined || attempt === before.attempt)) {
      revokeTask(taskId, 'completed')
    }
  }
  return settle((): Settled => {
    const allowed = agentId === null ? (t: TaskRow) => isActive(t.status) || t.status === 'review' : heldBy(agentId)
    const loaded = load(taskId, agentId, 'complete', allowed, attempt)
    if (!loaded.ok) return refused(loaded)
    const { task } = loaded
    const by = agentId ?? task.assigned_to_agent
    // a task already in review holds no worker; its assignee may be running something else
    const worker = isActive(task.status) ? task.assigned_to_agent : null

    if (status === 'review' || task.review_required === 1) {
      db.prepare("UPDATE conductor_tasks SET status = 'review', result = ?, lease_expires_at = NULL WHERE id = ?")
        .run(JSON.stringify(result), taskId)
      logTask(taskId, by, 'review', result.summary.slice(0, LOG_MESSAGE_MAX))
      const updated = current(taskId)
      notifyLead(updated, 'review_ready', formatNotification('review_ready', updated, {
        prUrl: result.prUrl ?? null, branch: result.branch ?? updated.branch ?? null, testOutput: result.testOutput ?? null,
      }))
      return { outcome: { ok: true, task: updated }, worker }
    }

    db.prepare(`
      UPDATE conductor_tasks SET status = 'completed', result = ?, completed_at = ?, completed_by = ?, lease_expires_at = NULL
      WHERE id = ?
    `).run(JSON.stringify(result), isoSeconds(Date.now()), by, taskId)
    logTask(taskId, by, 'completed', result.summary.slice(0, LOG_MESSAGE_MAX))
    const updated = current(taskId)
    onCompleted(updated)
    return { outcome: { ok: true, task: updated }, worker }
  })
}

/**
 * Counts a failed attempt and returns the task to `pending`. The second
 * failure sets `escalated_at` (the dispatcher then skips the task) and tells
 * the lead, once. `agentId` null (reclaim, REST) skips the owner check.
 * `attempt`: see `load`.
 */
export function failAttempt(taskId: string, agentId: string | null, error: string, attempt?: number): Outcome {
  return settle((): Settled => {
    const loaded = load(taskId, agentId, 'fail', agentId === null ? (t) => isActive(t.status) : heldBy(agentId), attempt)
    if (!loaded.ok) return refused(loaded)
    const { task } = loaded
    const failCount = task.fail_count + 1
    db.prepare('UPDATE conductor_tasks SET fail_count = ? WHERE id = ?').run(failCount, taskId)
    toPending(task, `failed: ${error}`)

    if (failCount >= ESCALATE_AT && task.escalated_at === null) {
      db.prepare('UPDATE conductor_tasks SET escalated_at = ? WHERE id = ?').run(isoSeconds(Date.now()), taskId)
      logTask(taskId, task.assigned_to_agent, 'escalated', `${failCount} failures`)
      const updated = current(taskId)
      notifyLead(updated, 'escalated', formatNotification('escalated', updated, { count: failCount, of: 'failures', reason: error }))
    }
    return { outcome: { ok: true, task: current(taskId) }, worker: task.assigned_to_agent }
  })
}

/** Back to `pending` with nothing counted (send failure, reroute). The task must be active. */
export function returnTask(taskId: string, reason: string): Outcome {
  return settle((): Settled => {
    const loaded = load(taskId, null, 'return', (t) => isActive(t.status))
    if (!loaded.ok) return refused(loaded)
    toPending(loaded.task, reason)
    return { outcome: { ok: true, task: current(taskId) }, worker: loaded.task.assigned_to_agent }
  })
}

/** A `resetAt` in the future, to the second; otherwise (absent, unreadable, past) now + 1 h. */
function quotaUntil(resetAt: string | undefined, now: number): string {
  const at = Date.parse(resetAt ?? '')
  return isoSeconds(Number.isFinite(at) && at > now ? at : now + QUOTA_DEFAULT_MS)
}

/**
 * Records the quota for (the worker's host, executor, `modelScope ?? model`),
 * keeping the later reset with its own reason and time; stores the handoff;
 * returns the task with no failure counted. A worker with no live connection
 * has no known host, so no quota row is written. `msg.attempt`: see `load`.
 */
export function quotaExhausted(taskId: string, agentId: string, msg: TaskQuotaExhaustedMsg, now: number = Date.now()): Outcome {
  return settle((): Settled => {
    const loaded = load(taskId, agentId, 'quota_exhausted', heldBy(agentId), msg.attempt)
    if (!loaded.ok) return refused(loaded)
    const { task } = loaded
    const model = msg.modelScope ?? msg.model
    const host = getByAgent(agentId)?.hostname
    if (host !== undefined) {
      db.prepare(`
        INSERT INTO conductor_quota (host, executor, model, exhausted_until, reason, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (host, executor, model) DO UPDATE SET
          exhausted_until = MAX(conductor_quota.exhausted_until, excluded.exhausted_until),
          reason = CASE WHEN excluded.exhausted_until >= conductor_quota.exhausted_until
            THEN excluded.reason ELSE conductor_quota.reason END,
          updated_at = CASE WHEN excluded.exhausted_until >= conductor_quota.exhausted_until
            THEN excluded.updated_at ELSE conductor_quota.updated_at END
      `).run(host, msg.executor, model, quotaUntil(msg.resetAt, now), msg.raw.slice(0, QUOTA_REASON_MAX), isoSeconds(now))
    }
    saveContext(task, { handoff: msg.handoff })
    toPending(task, `quota exhausted: ${msg.executor}/${model}${host === undefined ? ' (host unknown, not recorded)' : ''}`)
    return { outcome: { ok: true, task: current(taskId) }, worker: agentId }
  }, now)
}

/**
 * Back to `pending`. `busy` marks the worker busy; any other reason keeps the
 * task away from it for good. `attempt`: see `load`.
 */
export function declineTask(taskId: string, agentId: string, reason: string, attempt?: number): Outcome {
  const busy = reason === 'busy'
  return settle((): Settled => {
    const loaded = load(taskId, agentId, 'decline', heldBy(agentId), attempt)
    if (!loaded.ok) return refused(loaded)
    const { task } = loaded
    if (!busy) {
      const declined = taskContext(task).declined
      const list = Array.isArray(declined) ? declined.filter((d): d is string => typeof d === 'string') : []
      if (!list.includes(agentId)) saveContext(task, { declined: [...list, agentId] })
    }
    toPending(task, `declined: ${reason}`)
    return { outcome: { ok: true, task: current(taskId) }, worker: agentId, state: busy ? 'busy' : 'idle' }
  })
}

/** Tells the task's current assignee, if connected, to stop. The row is not changed. */
export function revokeTask(taskId: string, reason: string): void {
  const agentId = getTask(taskId)?.assigned_to_agent
  if (agentId) sendTo(agentId, { type: 'task.revoked', taskId, reason } satisfies TaskRevokedMsg)
}

/** Any task not yet finished → `cancelled`; an active one is revoked first and its worker freed. */
export function cancelTask(taskId: string, by: string | null): Outcome {
  assertOutsideTransaction()
  const before = getTask(taskId)
  if (before !== undefined && isActive(before.status)) revokeTask(taskId, 'cancelled')
  return settle((): Settled => {
    const loaded = load(taskId, by, 'cancel', (t) => !isTerminal(t.status))
    if (!loaded.ok) return refused(loaded)
    const { task } = loaded
    db.prepare(`
      UPDATE conductor_tasks
      SET status = 'cancelled', completed_at = ?, lease_expires_at = NULL, wait_reason = NULL, wait_until = NULL
      WHERE id = ?
    `).run(isoSeconds(Date.now()), taskId)
    logTask(taskId, by, 'cancelled', `was ${task.status}`)
    const updated = current(taskId)
    checkParent(updated)
    return { outcome: { ok: true, task: updated }, worker: isActive(task.status) ? task.assigned_to_agent : null }
  })
}
