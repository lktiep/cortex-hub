// Task lifecycle (spec §6.2, §6.5–§6.7): a worker accepts, reports progress,
// completes, fails, runs out of quota or declines; the lead reviews or cancels.
// Each step changes the row, logs and notifies in one transaction, and a
// completion runs the completion chain (dependents, groups, legacy parents) in
// the same transaction. After the commit, the messages the step queued are
// sent, the worker it freed is marked idle and a dispatch pass runs, so every
// push follows committed state.
import type {
  ReviewRequest, RoutePatch, TaskQuotaExhaustedMsg, TaskResult, TaskReview, TaskRevokedMsg,
} from '@cortex/shared-types'
import { db } from '../db/client.js'
import { getConductorConfig } from './config.js'
import { dispatch } from './dispatcher.js'
import { formatNotification, notifyLead } from './notify.js'
import { getByAgent, markFreed, sendTo, setStatus } from './registry.js'
import { normalizeFiles } from './files.js'
import {
  ACTIVE_STATUSES, getTask, isoSeconds, logTask, parseJson, stringList, taskContext, taskLabel, type TaskRow,
} from './rows.js'
import { fallbackProblem, findCycle, knownExecutor, priorityValue, stringListProblem } from './tree.js'

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

/**
 * The quota handoff points at the WIP commit of an attempt that has now
 * finished: kept across fail, decline and return, dropped once the work is
 * done or handed to review, so a later attempt (a rework) does not resume from it.
 */
function dropHandoff(task: TaskRow): void {
  const { handoff, ...rest } = taskContext(task)
  if (handoff === undefined) return
  db.prepare('UPDATE conductor_tasks SET context = ? WHERE id = ?').run(JSON.stringify(rest), task.id)
}

/** A WebSocket message held back until the transaction that produced it has committed. */
interface Send {
  agentId: string
  msg: object
  /** For a `notify_on_complete` message: the task whose `notified_agents` records a delivered send. */
  notifiedFor?: string
}

/**
 * What a committed step leaves to do: the messages to send, then the worker
 * whose task just left it (null for none) — idle from now (`markFreed`), or
 * busy if `state` says so — and the `freed` workers, idle from now (a
 * cancelled group's), then the dispatch pass.
 */
interface Settled<O extends { ok: boolean } = Outcome> {
  outcome: O; worker: string | null; state?: 'idle' | 'busy'; freed?: string[]; sends?: Send[]
}

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
function settle<O extends { ok: boolean } = Outcome>(step: () => Settled<O>, now?: number): O {
  assertOutsideTransaction()
  const { outcome, worker, state = 'idle', freed = [], sends = [] } = db.transaction(step)()
  if (!outcome.ok) return outcome
  flush(sends)
  if (worker !== null) {
    if (state === 'idle') markFreed(worker, now)
    else setStatus(worker, state, now)
  }
  for (const agentId of freed) markFreed(agentId, now)
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
function escalate(
  task: TaskRow, by: string | null, count: number, of: 'failures' | 'rejections', reason: string, now: number,
): void {
  if (count < ESCALATE_AT || task.escalated_at !== null) return
  db.prepare('UPDATE conductor_tasks SET escalated_at = ? WHERE id = ?').run(isoSeconds(now), task.id)
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

/** Tells the lead a gate is now `pending`, awaiting approval. */
function notifyGateReady(gateId: string): void {
  const gate = current(gateId)
  notifyLead(gate, 'gate_ready', formatNotification('gate_ready', gate, {}))
}

/** `blocked` tasks that depend on `completedId` and whose dependencies are now all completed → `pending`. */
function unblockDependents(completedId: string): void {
  const blocked = db.prepare("SELECT * FROM conductor_tasks WHERE status = 'blocked'").all() as TaskRow[]
  for (const dependent of blocked) {
    const deps = stringList(dependent.depends_on)
    if (!deps.includes(completedId) || !allCompleted(deps)) continue
    db.prepare("UPDATE conductor_tasks SET status = 'pending' WHERE id = ?").run(dependent.id)
    logTask(dependent.id, null, 'unblocked', `All dependencies met after ${completedId} completed`)
    if (dependent.kind === 'gate') notifyGateReady(dependent.id)
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
      // the flat legacy `task.assigned` (no `task` object) asking the lead to synthesize
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
      dropHandoff(task)
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
    dropHandoff(task)
    logTask(taskId, by, 'completed', result.summary.slice(0, LOG_MESSAGE_MAX))
    const updated = current(taskId)
    const sends: Send[] = []
    completionChain(updated, sends)
    return { outcome: { ok: true, task: updated }, worker, sends }
  })
}

/**
 * A failed attempt, inside the caller's transaction: `fail_count` grows and
 * the task returns to `pending`; the second failure sets `escalated_at` (the
 * dispatcher then skips the task) and tells the lead, once.
 */
function countFailure(task: TaskRow, error: string, now: number = Date.now()): Settled {
  const failCount = task.fail_count + 1
  db.prepare('UPDATE conductor_tasks SET fail_count = ? WHERE id = ?').run(failCount, task.id)
  toPending(task, `failed: ${error}`)
  escalate(task, task.assigned_to_agent, failCount, 'failures', error, now)
  return { outcome: { ok: true, task: current(task.id) }, worker: task.assigned_to_agent }
}

/**
 * Counts a failed attempt (`countFailure`). `agentId` null (REST, MCP) skips
 * the owner check and revokes the task from its worker first. `attempt`: see `load`.
 */
export function failAttempt(taskId: string, agentId: string | null, error: string, attempt?: number): Outcome {
  if (agentId === null) revokeBefore(taskId, 'failed', attempt)
  return settle((): Settled => {
    const loaded = load(taskId, agentId, 'fail', agentId === null ? (t) => isActive(t.status) : heldBy(agentId), attempt)
    if (!loaded.ok) return refused(loaded)
    return countFailure(loaded.task, error)
  })
}

/**
 * The scheduler's reclaim of an active task (spec §6.8: lease expired, worker
 * offline): one `task.revoked` with `reason` to its worker if connected, then
 * the failure is counted as `failAttempt` counts it, with `reason` as the
 * error. `attempt`: see `load`. `now` is the tick's clock, for the dispatch pass.
 */
export function reclaimTask(taskId: string, reason: string, attempt?: number, now?: number): Outcome {
  revokeBefore(taskId, reason, attempt)
  return settle((): Settled => {
    const loaded = load(taskId, null, 'reclaim', (t) => isActive(t.status), attempt)
    if (!loaded.ok) return refused(loaded)
    return countFailure(loaded.task, reason, now)
  }, now)
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

/** The unfinished tasks under `parentId`, at any depth. */
function openDescendants(parentId: string): TaskRow[] {
  return db.prepare(`
    WITH RECURSIVE subtree(id) AS (
      SELECT id FROM conductor_tasks WHERE parent_task_id = ?
      UNION SELECT t.id FROM conductor_tasks t JOIN subtree s ON t.parent_task_id = s.id
    )
    SELECT * FROM conductor_tasks
    WHERE id IN (SELECT id FROM subtree) AND status NOT IN (${TERMINAL_STATUSES.map(() => '?').join(', ')})
  `).all(parentId, ...TERMINAL_STATUSES) as TaskRow[]
}

function markCancelled(taskId: string, at: string): void {
  db.prepare(`
    UPDATE conductor_tasks
    SET status = 'cancelled', completed_at = ?, lease_expires_at = NULL, wait_reason = NULL, wait_until = NULL
    WHERE id = ?
  `).run(at, taskId)
}

/**
 * Any task not yet finished → `cancelled`; an active one is revoked first and
 * its worker freed. A group takes every unfinished task under it along, the
 * active ones revoked and their workers freed, and stays `cancelled`: so
 * cancelling a plan's root stops the whole plan.
 */
export function cancelTask(taskId: string, by: string | null): Outcome {
  revokeBefore(taskId, 'cancelled')
  return settle((): Settled => {
    const loaded = load(taskId, by, 'cancel', (t) => !isTerminal(t.status))
    if (!loaded.ok) return refused(loaded)
    const { task } = loaded
    const at = isoSeconds(Date.now())
    const sends: Send[] = []
    const freed: string[] = []
    if (task.kind === 'group') {
      for (const d of openDescendants(taskId)) {
        markCancelled(d.id, at)
        logTask(d.id, by, 'cancelled', `was ${d.status}; group ${taskLabel(task)} cancelled`)
        if (isActive(d.status) && d.assigned_to_agent !== null) {
          sends.push({ agentId: d.assigned_to_agent, msg: { type: 'task.revoked', taskId: d.id, reason: 'cancelled' } satisfies TaskRevokedMsg })
          freed.push(d.assigned_to_agent)
        }
      }
    }
    markCancelled(taskId, at)
    logTask(taskId, by, 'cancelled', `was ${task.status}`)
    const updated = current(taskId)
    checkParent(updated, sends)
    return { outcome: { ok: true, task: updated }, worker: isActive(task.status) ? task.assigned_to_agent : null, freed, sends }
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
  escalate(task, by, rejectCount, 'rejections', feedback, now)
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

export type RerouteOutcome = Outcome | { ok: false; status: 400; error: string; cycle?: string[] }

function badRoute(error: string, cycle?: string[]): RerouteOutcome {
  return cycle === undefined ? { ok: false, status: 400, error } : { ok: false, status: 400, error, cycle }
}

/** The first problem in a route patch, before anything is written. */
function routeProblem(task: TaskRow, patch: RoutePatch): RerouteOutcome | null {
  const taskId = task.id
  for (const [name, value] of [['dependsOn', patch.dependsOn], ['files', patch.files]] as const) {
    const bad = stringListProblem(name, value)
    if (bad !== null) return badRoute(bad)
  }
  if (patch.dependsOn !== undefined && task.kind === 'group') return badRoute("a group's dependencies are set on its tasks")
  if (patch.executor !== undefined && patch.executor !== null && !knownExecutor(patch.executor)) {
    return badRoute(`unknown executor ${String(patch.executor)}`)
  }
  const fallback = fallbackProblem(patch.fallback)
  if (fallback !== null) return badRoute(fallback)
  if (patch.priority !== undefined && priorityValue(patch.priority) === null) return badRoute(`unknown priority ${String(patch.priority)}`)
  if (patch.files !== undefined) {
    try { normalizeFiles(patch.files) } catch (e) { return badRoute((e as Error).message) }
  }
  for (const dep of patch.dependsOn ?? []) {
    if (dep === taskId) return badRoute(`dependency cycle: ${taskId} -> ${taskId}`, [taskId, taskId])
    if (getTask(dep) === undefined) return badRoute(`unknown dependency ${dep}`)
  }
  return null
}

/** A cycle that `dependsOn` would close in the stored graph (dependencies, and each group → its children), as keys or ids. */
function rerouteCycle(task: TaskRow, dependsOn: string[]): string[] | null {
  const rows = db.prepare("SELECT id, task_key, kind, parent_task_id, depends_on FROM conductor_tasks WHERE status NOT IN ('completed', 'cancelled', 'failed')")
    .all() as Pick<TaskRow, 'id' | 'task_key' | 'kind' | 'parent_task_id' | 'depends_on'>[]
  const edges = new Map<string, string[]>()
  for (const r of rows) {
    edges.set(r.id, [...(edges.get(r.id) ?? []), ...(r.id === task.id ? dependsOn : stringList(r.depends_on))])
    if (r.parent_task_id !== null) edges.set(r.parent_task_id, [...(edges.get(r.parent_task_id) ?? []), r.id])
  }
  const cycle = findCycle([task.id], edges)
  if (cycle === null) return null
  const labels = new Map(rows.map((r) => [r.id, r.task_key ?? r.id]))
  return cycle.map((id) => labels.get(id) ?? id)
}

/** The 400 for a patch that cannot apply to `task` (its shape, its dependencies, a cycle it would close), or null. */
function rerouteProblem(task: TaskRow, patch: RoutePatch): RerouteOutcome | null {
  const problem = routeProblem(task, patch)
  if (problem !== null) return problem
  if (patch.dependsOn === undefined) return null
  const cycle = rerouteCycle(task, patch.dependsOn)
  return cycle === null ? null : badRoute(`dependency cycle: ${cycle.join(' -> ')}`, cycle)
}

/** The columns a patch sets, in `column = ?` order with their values. */
function patchColumns(patch: RoutePatch): { sets: string[]; values: (string | number | null)[] } {
  const sets: string[] = []
  const values: (string | number | null)[] = []
  const put = (column: string, value: string | number | null): void => { sets.push(`${column} = ?`); values.push(value) }
  if (patch.executor !== undefined) put('executor', patch.executor)
  if (patch.model !== undefined) put('model', patch.model)
  if (patch.effort !== undefined) put('effort', patch.effort)
  if (patch.fallback !== undefined) put('fallback', patch.fallback === null ? null : JSON.stringify(patch.fallback))
  if (patch.pinnedAgent !== undefined) put('pinned_agent', patch.pinnedAgent)
  if (patch.priority !== undefined) put('priority', priorityValue(patch.priority))
  if (patch.files !== undefined) put('files', JSON.stringify(normalizeFiles(patch.files)))
  if (patch.dependsOn !== undefined) put('depends_on', JSON.stringify([...new Set(patch.dependsOn)]))
  if (patch.clearEscalation === true) { sets.push('escalated_at = NULL', 'fail_count = 0', 'reject_count = 0') }
  return { sets, values }
}

/**
 * Changes a task's route, priority, files or dependencies (spec §6.9). An
 * active task is revoked first and returned to `pending` in the same step as
 * the patch, so the one dispatch pass after the commit sees the new route. A
 * `pending` or `blocked` task is re-sorted by its dependencies.
 */
export function rerouteTask(taskId: string, patch: RoutePatch, by: string | null): RerouteOutcome {
  const before = getTask(taskId)
  if (before === undefined) return { ok: false, status: 404, error: `task ${taskId} not found` }
  if (isTerminal(before.status)) return { ok: false, status: 409, error: `reroute ignored: task is ${before.status}` }
  // checked ahead too, so that a patch that is refused does not revoke the worker
  const problem = rerouteProblem(before, patch)
  if (problem !== null) return problem
  revokeBefore(taskId, 'rerouted')
  return settle((): Settled<RerouteOutcome> => {
    const loaded = load(taskId, by, 'reroute', (t) => !isTerminal(t.status))
    if (!loaded.ok) return refused(loaded)
    const { task } = loaded
    // against the row as this transaction reads it: what it writes is what was checked
    const late = rerouteProblem(task, patch)
    if (late !== null) return { outcome: late, worker: null }
    const wasActive = isActive(task.status)
    if (wasActive) toPending(task, 'rerouted')
    const { sets, values } = patchColumns(patch)
    if (sets.length > 0) db.prepare(`UPDATE conductor_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values, taskId)
    const patched = current(taskId)
    if (patched.status === 'pending' || patched.status === 'blocked') {
      const next = allCompleted(stringList(patched.depends_on)) ? 'pending' : 'blocked'
      if (next !== patched.status) {
        db.prepare('UPDATE conductor_tasks SET status = ? WHERE id = ?').run(next, taskId)
        if (next === 'pending' && patched.kind === 'gate') notifyGateReady(taskId)
      }
    }
    logTask(taskId, by, 'rerouted', JSON.stringify(patch))
    return { outcome: { ok: true, task: current(taskId) }, worker: wasActive ? task.assigned_to_agent : null }
  })
}
