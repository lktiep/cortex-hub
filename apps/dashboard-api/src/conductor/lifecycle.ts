// Task lifecycle (spec §6.2, §6.5–§6.7): a worker accepts, reports progress,
// completes, fails, runs out of quota or declines; the lead reviews or cancels.
// Each step changes the row, logs and notifies in one transaction, and a
// completion runs the completion chain (dependents, groups, legacy parents) in
// the same transaction. After the commit, the messages the step queued are
// sent, the worker it freed is marked idle and a dispatch pass runs, so every
// push follows committed state.
import type {
  ReviewRequest, TaskQuotaExhaustedMsg, TaskResult, TaskReview, TaskRevokedMsg,
} from '@cortex/shared-types'
import { db } from '../db/client.js'
import { getConductorConfig } from './config.js'
import { dispatch } from './dispatcher.js'
import { formatNotification, notifyLead } from './notify.js'
import { getByAgent, sendTo, setStatus } from './registry.js'
import {
  ACTIVE_STATUSES, getTask, isoSeconds, logTask, parseJson, stringList, taskContext, taskLabel, type TaskRow,
} from './rows.js'

export type Outcome = { ok: true; task: TaskRow } | { ok: false; status: 403 | 404 | 409; error: string }

const TERMINAL_STATUSES = ['completed', 'cancelled', 'failed'] as const
const PROGRESS_KEPT = 50
const LOG_MESSAGE_MAX = 4000
const LEASE_STEP_MS = 60_000
const QUOTA_DEFAULT_MS = 3600_000
const QUOTA_REASON_MAX = 500
const ESCALATE_AT = 2
/** Legacy subtask statuses that keep a `work` parent open (moved from `checkParentCompletion`). */
const LEGACY_OPEN_STATUSES = ['pending', 'blocked', 'assigned', 'accepted', 'in_progress', 'review']
/** What a return to `pending` sets: the assignment, acceptance and lease are cleared. */
const BACK_TO_PENDING = "status = 'pending', assigned_to_agent = NULL, assigned_at = NULL, accepted_at = NULL, lease_expires_at = NULL"

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
  db.prepare(`UPDATE conductor_tasks SET ${BACK_TO_PENDING} WHERE id = ?`).run(task.id)
  logTask(task.id, task.assigned_to_agent, 'returned', reason.slice(0, LOG_MESSAGE_MAX))
}

function saveContext(task: TaskRow, patch: Record<string, unknown>): void {
  db.prepare('UPDATE conductor_tasks SET context = ? WHERE id = ?').run(JSON.stringify({ ...taskContext(task), ...patch }), task.id)
}

/** A WebSocket message held back until the transaction that produced it has committed. */
interface Send {
  agentId: string
  msg: object
  /** For a `notify_on_complete` message: the task whose `notified_agents` records a delivered send. */
  notifiedFor?: string
}

/**
 * What a committed step leaves to do: the messages to send, then the worker to
 * mark (null for none), then the dispatch pass.
 */
interface Settled { outcome: Outcome; worker: string | null; state?: 'idle' | 'busy'; sends?: Send[] }

/**
 * Pushes to workers (revokes, the dispatch pass) must follow a commit. Inside a
 * caller's open transaction the step would only commit with it, so it refuses.
 */
function assertOutsideTransaction(): void {
  if (db.inTransaction) throw new Error('lifecycle: must not run inside a db transaction')
}

/**
 * Sends the queued messages; must follow the commit. The agents a
 * `notify_on_complete` message reached are added to that task's `notified_agents`.
 */
function flush(sends: Send[]): void {
  const delivered = new Map<string, string[]>()
  for (const { agentId, msg, notifiedFor } of sends) {
    if (sendTo(agentId, msg) && notifiedFor !== undefined) {
      delivered.set(notifiedFor, [...(delivered.get(notifiedFor) ?? []), agentId])
    }
  }
  if (delivered.size === 0) return
  try {
    db.transaction(() => {
      for (const [taskId, agents] of delivered) {
        const task = getTask(taskId)
        if (task === undefined) continue
        const notified = [...new Set([...stringList(task.notified_agents), ...agents])]
        db.prepare('UPDATE conductor_tasks SET notified_agents = ? WHERE id = ?').run(JSON.stringify(notified), taskId)
      }
    })()
  } catch (e) {
    // the step has committed: bookkeeping must not stop the worker update or the dispatch pass
    console.error('[conductor] recording notified_agents failed:', e)
  }
}

/** Runs `step` in one transaction; after a successful commit, sends, marks the worker and dispatches. */
function settle(step: () => Settled, now?: number): Outcome {
  assertOutsideTransaction()
  const { outcome, worker, state = 'idle', sends = [] } = db.transaction(step)()
  if (!outcome.ok) return outcome
  flush(sends)
  if (worker !== null) setStatus(worker, state, now)
  dispatch(now)
  return outcome
}

/**
 * Before a lead's step on a running task (no agent: REST, MCP, cancel): tells
 * its worker to stop, ahead of the transaction. Skipped for a task not active
 * or a stale `attempt`, which the step itself then refuses.
 */
function revokeBefore(taskId: string, reason: string, attempt?: number): void {
  assertOutsideTransaction()
  const before = getTask(taskId)
  if (before !== undefined && isActive(before.status) && (attempt === undefined || attempt === before.attempt)) {
    revokeTask(taskId, reason)
  }
}

function refused(outcome: Outcome): Settled {
  return { outcome, worker: null }
}

/** Sets `escalated_at` and tells the lead, at the second failure or rejection and only once (spec §6.6). */
function escalate(task: TaskRow, by: string | null, count: number, of: 'failures' | 'rejections', reason: string): void {
  if (count < ESCALATE_AT || task.escalated_at !== null) return
  db.prepare('UPDATE conductor_tasks SET escalated_at = ? WHERE id = ?').run(isoSeconds(Date.now()), task.id)
  logTask(task.id, by, 'escalated', `${count} ${of}`)
  const updated = current(task.id)
  notifyLead(updated, 'escalated', formatNotification('escalated', updated, { count, of, reason }))
}

/** True when every id names a `completed` task. */
function allCompleted(ids: string[]): boolean {
  const unique = [...new Set(ids)]
  const { n } = db.prepare(
    "SELECT COUNT(*) AS n FROM conductor_tasks WHERE status = 'completed' AND id IN (SELECT value FROM json_each(?))",
  ).get(JSON.stringify(unique)) as { n: number }
  return n === unique.length
}

/** `blocked` tasks that depend on `completedId` and whose dependencies are now all completed → `pending`. */
function unblockDependents(completedId: string): void {
  const blocked = db.prepare("SELECT * FROM conductor_tasks WHERE status = 'blocked'").all() as TaskRow[]
  for (const dependent of blocked) {
    const deps = stringList(dependent.depends_on)
    if (!deps.includes(completedId) || !allCompleted(deps)) continue
    db.prepare("UPDATE conductor_tasks SET status = 'pending' WHERE id = ?").run(dependent.id)
    logTask(dependent.id, null, 'unblocked', `All dependencies met after ${completedId} completed`)
    if (dependent.kind === 'gate') {
      const gate = current(dependent.id)
      notifyLead(gate, 'gate_ready', formatNotification('gate_ready', gate, {}))
    }
  }
}

/** Tasks whose completion chain is running; a re-entrant call for one of them is skipped. */
const resolving = new Set<string>()

/**
 * The completion chain, inside the caller's transaction (spec §6.2): unblocks
 * dependents, queues `task.completed` for the `notify_on_complete` agents, and
 * checks the parent. Messages go on `sends`, for after the commit.
 */
function completionChain(task: TaskRow, sends: Send[]): void {
  if (resolving.has(task.id)) {
    console.warn(`[conductor] completion chain: skipping ${task.id} (already resolving)`)
    return
  }
  resolving.add(task.id)
  try {
    unblockDependents(task.id)
    const notify = stringList(task.notify_on_complete)
    if (notify.length > 0) {
      const msg = {
        type: 'task.completed',
        taskId: task.id,
        title: task.title,
        result: task.result ? parseJson(task.result, {}) : null,
        completedBy: task.completed_by,
        timestamp: new Date().toISOString(),
      }
      for (const agentId of notify) sends.push({ agentId, msg, notifiedFor: task.id })
    }
    checkParent(task, sends)
  } finally {
    resolving.delete(task.id)
  }
}

/**
 * After a child completes or is cancelled. A `group` parent is `cancelled` when
 * every child is, `completed` when every other child is; a legacy `work` parent
 * keeps `checkParentCompletion`'s behaviour. A finished parent is checked in turn.
 */
function checkParent(task: TaskRow, sends: Send[]): void {
  if (task.parent_task_id === null) return
  const parent = getTask(task.parent_task_id)
  if (parent === undefined || isTerminal(parent.status)) return
  const children = db.prepare('SELECT * FROM conductor_tasks WHERE parent_task_id = ?').all(parent.id) as TaskRow[]
  if (parent.kind === 'group') checkGroup(parent, children, sends)
  else if (parent.kind === 'work') checkLegacyParent(parent, children, sends)
}

function checkGroup(group: TaskRow, children: TaskRow[], sends: Send[]): void {
  const counted = children.filter((c) => c.status !== 'cancelled')
  const at = isoSeconds(Date.now())
  if (counted.length === 0) {
    db.prepare("UPDATE conductor_tasks SET status = 'cancelled', completed_at = ? WHERE id = ?").run(at, group.id)
    logTask(group.id, null, 'cancelled', 'every child cancelled')
    // a cancelled group unblocks nothing; only its own parent may now be done
    checkParent(current(group.id), sends)
  } else if (counted.every((c) => c.status === 'completed')) {
    db.prepare("UPDATE conductor_tasks SET status = 'completed', completed_at = ? WHERE id = ?").run(at, group.id)
    logTask(group.id, null, 'completed', 'every child completed')
    completionChain(current(group.id), sends)
  }
}

/**
 * A legacy parent completes when every non-cancelled subtask is completed (or
 * `approved`): with an assignee it enters `synthesis` and the assignee is
 * asked to synthesize; without one it completes and runs the chain.
 */
function checkLegacyParent(parent: TaskRow, subtasks: TaskRow[], sends: Send[]): void {
  const counted = subtasks.filter((t) => t.status !== 'cancelled')
  if (counted.length === 0 || counted.some((t) => LEGACY_OPEN_STATUSES.includes(t.status))) return

  if (counted.every((t) => t.status === 'completed' || t.status === 'approved')) {
    const subtaskResults = subtasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      assignedTo: t.assigned_to_agent,
      completedBy: t.completed_by,
      result: t.result ? parseJson(t.result, null) : null,
    }))
    if (parent.assigned_to_agent) {
      saveContext(parent, { subtaskResults, phase: 'synthesis' })
      db.prepare("UPDATE conductor_tasks SET status = 'synthesis' WHERE id = ?").run(parent.id)
      logTask(parent.id, null, 'synthesis_ready', `All ${counted.length} subtasks completed. Awaiting Lead Agent synthesis.`)
      // the message `pushTaskToAgent` (ws/conductor.ts) sent
      sends.push({
        agentId: parent.assigned_to_agent,
        msg: {
          type: 'task.assigned',
          taskId: parent.id,
          title: parent.title,
          description: `All ${counted.length} subtasks completed. Please synthesize results and submit final summary.`,
          timestamp: new Date().toISOString(),
        },
      })
    } else {
      db.prepare("UPDATE conductor_tasks SET status = 'completed', completed_at = ?, result = ? WHERE id = ?")
        .run(isoSeconds(Date.now()), JSON.stringify({ subtaskResults, autoCompleted: true }), parent.id)
      logTask(parent.id, null, 'auto_completed', `All ${subtasks.length} subtasks completed`)
      completionChain(current(parent.id), sends)
    }
  } else if (counted.some((t) => t.status === 'failed')) {
    const failed = subtasks.filter((t) => t.status === 'failed').map((t) => t.id)
    logTask(parent.id, null, 'subtask_failed', `Subtasks failed: ${failed.join(', ')}`)
  }
}

/**
 * The completion chain for a task completed outside this module (the legacy
 * REST and WS handlers): runs it in one transaction, then sends what it queued
 * and dispatches. Must not be called inside a transaction.
 */
export function onCompleted(task: TaskRow): void {
  assertOutsideTransaction()
  const sends = db.transaction((): Send[] => {
    const queued: Send[] = []
    completionChain(task, queued)
    return queued
  })()
  flush(sends)
  dispatch()
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
  // failAttempt sends its own revoke ('failed'), so a lead's failure is revoked once
  if (status === 'failed') return failAttempt(taskId, agentId, result.error ?? result.summary, attempt)
  if (agentId === null) revokeBefore(taskId, 'completed', attempt)
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
    const sends: Send[] = []
    completionChain(updated, sends)
    return { outcome: { ok: true, task: updated }, worker, sends }
  })
}

/**
 * Counts a failed attempt and returns the task to `pending`. The second
 * failure sets `escalated_at` (the dispatcher then skips the task) and tells
 * the lead, once. `agentId` null (reclaim, REST) skips the owner check and
 * revokes the task from its worker first. `attempt`: see `load`.
 */
export function failAttempt(taskId: string, agentId: string | null, error: string, attempt?: number): Outcome {
  if (agentId === null) revokeBefore(taskId, 'failed', attempt)
  return settle((): Settled => {
    const loaded = load(taskId, agentId, 'fail', agentId === null ? (t) => isActive(t.status) : heldBy(agentId), attempt)
    if (!loaded.ok) return refused(loaded)
    const { task } = loaded
    const failCount = task.fail_count + 1
    db.prepare('UPDATE conductor_tasks SET fail_count = ? WHERE id = ?').run(failCount, taskId)
    toPending(task, `failed: ${error}`)
    escalate(task, task.assigned_to_agent, failCount, 'failures', error)
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
  revokeBefore(taskId, 'cancelled')
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
    const sends: Send[] = []
    checkParent(updated, sends)
    return { outcome: { ok: true, task: updated }, worker: isActive(task.status) ? task.assigned_to_agent : null, sends }
  })
}

/** A `work` task in `review`, or a `gate` in `pending` (awaiting approval). */
function reviewable(task: TaskRow): boolean {
  return (task.kind === 'work' && task.status === 'review') || (task.kind === 'gate' && task.status === 'pending')
}

/**
 * A rejection (spec §6.6): the review entry is appended, `reject_count` grows
 * and the task returns to `pending`, any completion cleared; `branch`,
 * `last_agent` and `attempt` stay. The second rejection escalates.
 */
function rejectWork(task: TaskRow, by: string, feedback: string, now: number): void {
  const reviews = taskContext(task).reviews
  const review: TaskReview = { at: isoSeconds(now), by, verdict: 'reject', feedback }
  const rejectCount = task.reject_count + 1
  saveContext(task, { reviews: [...(Array.isArray(reviews) ? reviews : []), review] })
  db.prepare(`UPDATE conductor_tasks SET ${BACK_TO_PENDING}, completed_at = NULL, completed_by = NULL, reject_count = ? WHERE id = ?`)
    .run(rejectCount, task.id)
  logTask(task.id, by, 'rejected', feedback.slice(0, LOG_MESSAGE_MAX))
  escalate(task, by, rejectCount, 'rejections', feedback)
}

/**
 * Undoes what `returned`'s completion released, now that `gate` sent it back:
 * its `pending` dependents are blocked again, and a completed `group` parent
 * reopens (`pending`, completion cleared), in turn up the tree. Dependents that
 * already started are left alone (spec §6.2); a legacy `work` parent is not
 * reopened. Completing the task again releases them through the chain.
 */
function unwindCompletion(returned: TaskRow, gate: TaskRow, by: string): void {
  const message = `${taskLabel(returned)} returned by ${taskLabel(gate)}`
  const pending = db.prepare("SELECT * FROM conductor_tasks WHERE status = 'pending'").all() as TaskRow[]
  for (const dependent of pending) {
    if (!stringList(dependent.depends_on).includes(returned.id)) continue
    db.prepare("UPDATE conductor_tasks SET status = 'blocked' WHERE id = ?").run(dependent.id)
    logTask(dependent.id, by, 'reblocked', message)
  }
  const parent = returned.parent_task_id === null ? undefined : getTask(returned.parent_task_id)
  if (parent?.kind !== 'group' || parent.status !== 'completed') return
  db.prepare("UPDATE conductor_tasks SET status = 'pending', completed_at = NULL, completed_by = NULL WHERE id = ?").run(parent.id)
  logTask(parent.id, by, 'reopened', message)
  unwindCompletion(current(parent.id), gate, by)
}

/**
 * The lead's verdict (spec §6.2, §6.6). On a `work` task in `review`: approve
 * → `completed` and the chain; reject → back to `pending` with the feedback.
 * On a `gate` in `pending`: approve (every dependency completed, else 409) →
 * `completed` and the chain; reject → the gate returns to `blocked` and each
 * completed direct dependency of kind `work` is rejected the same way, its
 * completion unwound (`unwindCompletion`); with none to return → 409. A `user`
 * gate is reviewed only from the dashboard. `by` defaults to the channel.
 * Anything else → 409 with an `ignored` log row; the 403 and the two gate
 * 409s above write nothing.
 */
export function reviewTask(taskId: string, req: ReviewRequest, via: 'mcp' | 'dashboard'): Outcome {
  const by = req.by ?? (via === 'dashboard' ? 'dashboard' : 'mcp')
  return settle((): Settled => {
    const loaded = load(taskId, by, 'review', reviewable)
    if (!loaded.ok) return refused(loaded)
    const { task } = loaded
    if (task.kind === 'gate' && task.approver === 'user' && via === 'mcp') {
      return refused({ ok: false, status: 403, error: 'user gates are approved in the dashboard' })
    }
    const now = Date.now()

    if (req.verdict === 'approve') {
      if (task.kind === 'gate' && !allCompleted(stringList(task.depends_on))) {
        return refused({ ok: false, status: 409, error: 'dependencies not complete' })
      }
      db.prepare("UPDATE conductor_tasks SET status = 'completed', completed_at = ?, completed_by = ? WHERE id = ?")
        .run(isoSeconds(now), by, taskId)
      logTask(taskId, by, 'approved', req.feedback?.slice(0, LOG_MESSAGE_MAX))
      const updated = current(taskId)
      const sends: Send[] = []
      completionChain(updated, sends)
      // a task in review holds no worker
      return { outcome: { ok: true, task: updated }, worker: null, sends }
    }

    const feedback = req.feedback ?? ''
    if (task.kind === 'work') {
      rejectWork(task, by, feedback, now)
      return { outcome: { ok: true, task: current(taskId) }, worker: null }
    }

    // only finished direct work goes back (not a group's children); an active task would need its worker revoked first
    const returned = [...new Set(stringList(task.depends_on))]
      .map((id) => getTask(id))
      .filter((dep): dep is TaskRow => dep?.kind === 'work' && dep.status === 'completed')
    if (returned.length === 0) {
      return refused({ ok: false, status: 409, error: 'nothing to return: cancel the gate or reroute its dependencies' })
    }
    // blocked first, so the unwinding below does not count the gate among the pending dependents
    db.prepare("UPDATE conductor_tasks SET status = 'blocked' WHERE id = ?").run(taskId)
    logTask(taskId, by, 'rejected', feedback.slice(0, LOG_MESSAGE_MAX))
    for (const dep of returned) {
      rejectWork(dep, by, feedback, now)
      unwindCompletion(dep, task, by)
    }
    return { outcome: { ok: true, task: current(taskId) }, worker: null }
  })
}
