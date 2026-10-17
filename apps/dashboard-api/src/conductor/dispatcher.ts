// Dispatcher (spec §6.4). selectAssignments() and its helpers are pure: they
// decide from plain state which worker takes which ready task on which route,
// and why the others wait, without reading the database or the registry.
// The DB half below them loads that state, applies the result and pushes the
// assignments (dispatch), and serves pull-mode pickups (pickForPull).
import type { EngineInfo, Executor, RouteSpec, WaitReason } from '@cortex/shared-types'
import { db } from '../db/client.js'
import { baseBranchFor, getConductorConfig, type ConductorConfig } from './config.js'
import { pathsConflict } from './files.js'
import { returnTask } from './lifecycle.js'
import { assignedMsg, branchFor } from './messages.js'
import { formatNotification, notifyLead } from './notify.js'
import { listConnections, sendTo } from './registry.js'
import {
  ACTIVE_STATUSES, LOCKING_STATUSES, getTask, isoSeconds, logTask, parseJson, stringList, taskContext, type TaskRow,
} from './rows.js'

export interface CandidateTask {
  id: string; projectId: string | null; priority: number; createdAt: string
  dependsOn: string[]; requiredCapabilities: string[]; files: string[]
  routes: RouteSpec[]; pinnedAgent: string | null; declined: string[]; lastAgent: string | null
  /** Created as part of a plan (it has a `task_key`): only a protocol-2 worker takes it. */
  inPlan: boolean
}
export interface CandidateWorker {
  agentId: string; host: string; projectId: string | null; protocol: 1 | 2
  capabilities: string[]; engines: EngineInfo[]; busy: boolean; idleSince: number
  /** The executor the worker runs a route without one on (`worker.register.defaultExecutor`). */
  defaultExecutor: Executor | null
}
export interface QuotaRow { host: string; executor: string; model: string; exhaustedUntil: string }
export interface SelectionInput {
  pending: CandidateTask[]; completedIds: ReadonlySet<string>; lockedFiles: string[][]
  workers: CandidateWorker[]; quota: QuotaRow[]; now: string
}
export interface Assignment { taskId: string; agentId: string; route: RouteSpec }
export interface Wait { taskId: string; reason: WaitReason | null; until: string | null }

/** `[primary, ...(fallback ?? defaultFallback)]` without duplicates. An empty fallback means the primary only. */
export function routeChain(primary: RouteSpec, fallback: RouteSpec[] | null, defaultFallback: RouteSpec[]): RouteSpec[] {
  const seen = new Set<string>()
  const chain: RouteSpec[] = []
  for (const route of [primary, ...(fallback ?? defaultFallback)]) {
    const key = JSON.stringify([route.executor, route.model, route.effort])
    if (seen.has(key)) continue
    seen.add(key)
    chain.push(route)
  }
  return chain
}

/** A quota row's model matches exactly, by prefix (`foo-*`), or as `*`. */
export function quotaModelMatches(pattern: string, model: string): boolean {
  if (pattern === '*') return true
  if (pattern.endsWith('*')) return model.startsWith(pattern.slice(0, -1))
  return pattern === model
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * A legacy (protocol 1) worker on a key scoped to no project takes any
 * project; any other worker (protocol 2, or a key scoped to a project) takes
 * its own project's tasks and project-less ones. Also the `GET /:id/tree` worker filter.
 */
export function servesProject(
  worker: Pick<CandidateWorker, 'protocol' | 'projectId'>, task: Pick<CandidateTask, 'projectId'>,
): boolean {
  if (worker.protocol === 1 && worker.projectId === null) return true
  return task.projectId === null || task.projectId === worker.projectId
}

function listsModel(engine: EngineInfo, model: string): boolean {
  return engine.models.includes(model) || engine.models.includes('*')
}

/**
 * The worker's engines that can run the route. A route without an executor
 * runs on the worker's default executor, so only that engine fits; a worker
 * without a default executor keeps the old reading, where any engine fits.
 */
function fittingEngines(worker: CandidateWorker, route: RouteSpec): EngineInfo[] {
  const executor = route.executor ?? worker.defaultExecutor
  const { model } = route
  return worker.engines.filter((e) =>
    (executor === null || e.executor === executor) && (model === null || listsModel(e, model)))
}

/**
 * An executor-null, model-null route fits any worker, even one without
 * engines or without an engine for its default executor; any other route
 * needs a fitting engine (see `fittingEngines`).
 */
function fitsRoute(worker: CandidateWorker, route: RouteSpec): boolean {
  if (route.executor === null && route.model === null) return true
  return fittingEngines(worker, route).length > 0
}

/**
 * A plan's tasks are pushed only to protocol-2 workers (conductor-worker). A
 * protocol-1 client (an IDE window, or the old cortex-agent scripts) cannot
 * tell reliably when its agent has finished, so it is pushed loose tasks only;
 * it can still claim a plan task in pull mode.
 */
function staticallyEligible(task: CandidateTask, route: RouteSpec, worker: CandidateWorker): boolean {
  return (worker.protocol === 2 || !task.inPlan)
    && servesProject(worker, task)
    && !task.declined.includes(worker.agentId)
    && (task.pinnedAgent === null || task.pinnedAgent === worker.agentId)
    && task.requiredCapabilities.every((c) => worker.capabilities.includes(c))
    && fitsRoute(worker, route)
}

/**
 * The rows that keep the worker off this route, or null when it is free.
 * The worker is blocked only when it has a fitting engine and every fitting
 * engine is blocked. A route without an executor counts only the engine of
 * the worker's default executor, the one the worker would run; every engine
 * only when the worker has no default executor. A model-null route is checked
 * against each engine's `defaultModel`; an engine without one is blocked only
 * by `*` rows, which is what a worker reports when it cannot name the model.
 * `activeQuota` holds only rows with `exhaustedUntil > now`.
 */
function quotaBlock(worker: CandidateWorker, route: RouteSpec, activeQuota: QuotaRow[]): QuotaRow[] | null {
  const engines = fittingEngines(worker, route)
  if (engines.length === 0) return null
  const blocking: QuotaRow[] = []
  for (const engine of engines) {
    const model = route.model ?? engine.defaultModel
    const rows = activeQuota.filter((q) => q.host === worker.host && q.executor === engine.executor
      && (model === null ? q.model === '*' : quotaModelMatches(q.model, model)))
    if (rows.length === 0) return null
    blocking.push(...rows)
  }
  return blocking
}

/** `lastAgent` if it is available, else the worker idle longest. */
function preferredWorker(available: CandidateWorker[], lastAgent: string | null): CandidateWorker | undefined {
  const last = available.find((w) => w.agentId === lastAgent)
  if (last !== undefined) return last
  return available.reduce<CandidateWorker | undefined>((best, w) =>
    best === undefined || w.idleSince < best.idleSince ? w : best, undefined)
}

/**
 * One pass: ready tasks in `priority`, `createdAt` order each take the first
 * route that has an eligible, idle, unblocked worker not yet used this pass.
 * Every ready task gets a `Wait` (reason null when assigned, to clear a stale
 * one); tasks with unfinished dependencies get nothing.
 */
export function selectAssignments(input: SelectionInput): { assign: Assignment[]; wait: Wait[] } {
  const activeQuota = input.quota.filter((q) => q.exhaustedUntil > input.now)
  const locks: string[][] = [...input.lockedFiles]
  const used = new Set<string>()
  const assign: Assignment[] = []
  const wait: Wait[] = []

  const ready = input.pending
    .filter((t) => t.dependsOn.every((id) => input.completedIds.has(id)))
    .sort((a, b) => a.priority - b.priority || compareText(a.createdAt, b.createdAt))

  for (const task of ready) {
    if (locks.some((files) => pathsConflict(files, task.files))) {
      wait.push({ taskId: task.id, reason: 'lock', until: null })
      continue
    }

    let anyEligible = false
    let onlyQuota = true
    let earliestReset: string | null = null
    let chosen: Assignment | null = null

    for (const route of task.routes) {
      const available: CandidateWorker[] = []
      for (const worker of input.workers) {
        if (!staticallyEligible(task, route, worker)) continue
        anyEligible = true
        const blocking = quotaBlock(worker, route, activeQuota)
        if (blocking !== null) {
          for (const row of blocking) {
            if (earliestReset === null || row.exhaustedUntil < earliestReset) earliestReset = row.exhaustedUntil
          }
          continue
        }
        onlyQuota = false
        if (!worker.busy && !used.has(worker.agentId)) available.push(worker)
      }
      const picked = preferredWorker(available, task.lastAgent)
      if (picked !== undefined) {
        chosen = { taskId: task.id, agentId: picked.agentId, route }
        break
      }
    }

    if (chosen !== null) {
      used.add(chosen.agentId)
      locks.push(task.files)
      assign.push(chosen)
      wait.push({ taskId: task.id, reason: null, until: null })
    } else if (!anyEligible) {
      wait.push({ taskId: task.id, reason: 'no_worker', until: null })
    } else if (onlyQuota) {
      wait.push({ taskId: task.id, reason: 'capacity', until: earliestReset })
    } else {
      wait.push({ taskId: task.id, reason: null, until: null })
    }
  }

  return { assign, wait }
}

/** Normalize agent identity for flexible matching (lowercase, trimmed) */
export function normalizeIdentity(id: string | null | undefined): string {
  if (!id) return ''
  return id.toLowerCase().trim()
}

// ── DB half: load state, apply the selection, push the assignments ──

const WS_OPEN = 1

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

/** Executors are validated on write; an unknown one is kept so that it matches no engine. */
function toRoute(executor: unknown, model: unknown, effort: unknown): RouteSpec {
  return { executor: str(executor) as Executor | null, model: str(model), effort: str(effort) }
}

/** `[primary, ...fallback]`; a null or unreadable `fallback` means the project default. */
function routesOf(row: TaskRow, defaultFallback: RouteSpec[]): RouteSpec[] {
  const parsed = parseJson<unknown>(row.fallback, null)
  const fallback = Array.isArray(parsed)
    ? parsed
      .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
      .map((r) => toRoute(r.executor, r.model, r.effort))
    : null
  return routeChain(toRoute(row.executor, row.model, row.effort), fallback, defaultFallback)
}

/** `agy/gemini-4-argon-low`, as shown in notifications and logs. */
function routeLabel(route: RouteSpec): string {
  const base = `${route.executor ?? 'any'}/${route.model ?? 'default'}`
  return route.effort === null ? base : `${base}@${route.effort}`
}

function declinedBy(row: TaskRow): string[] {
  const declined = taskContext(row).declined
  return Array.isArray(declined) ? declined.filter((d): d is string => typeof d === 'string') : []
}

/** `kind = 'work'`, `pending`, not escalated; dependencies and file locks are checked by the caller. */
function pendingWork(): TaskRow[] {
  return db.prepare(
    "SELECT * FROM conductor_tasks WHERE kind = 'work' AND status = 'pending' AND escalated_at IS NULL ORDER BY priority ASC, created_at ASC, rowid ASC",
  ).all() as TaskRow[]
}

/** The ids among `ids` whose task is `completed`. */
function completedAmong(ids: string[]): Set<string> {
  if (ids.length === 0) return new Set()
  const rows = db.prepare(
    "SELECT id FROM conductor_tasks WHERE status = 'completed' AND id IN (SELECT value FROM json_each(?))",
  ).all(JSON.stringify([...new Set(ids)])) as { id: string }[]
  return new Set(rows.map((r) => r.id))
}

function inList(statuses: readonly string[]): string {
  return statuses.map(() => '?').join(', ')
}

/** File lists of the tasks that hold locks (`LOCKING_STATUSES`). */
function lockedFiles(): string[][] {
  const rows = db.prepare(`SELECT files FROM conductor_tasks WHERE status IN (${inList(LOCKING_STATUSES)})`)
    .all(...LOCKING_STATUSES) as { files: string | null }[]
  return rows.map((r) => stringList(r.files)).filter((files) => files.length > 0)
}

/** Agents with a task in `ACTIVE_STATUSES`; a task in `review` does not count. */
function agentsWithActiveTask(): Set<string> {
  const rows = db.prepare(
    `SELECT DISTINCT assigned_to_agent AS agent FROM conductor_tasks WHERE status IN (${inList(ACTIVE_STATUSES)}) AND assigned_to_agent IS NOT NULL`,
  ).all(...ACTIVE_STATUSES) as { agent: string }[]
  return new Set(rows.map((r) => r.agent))
}

/** Registered connections whose socket is open. */
function loadWorkers(): CandidateWorker[] {
  const active = agentsWithActiveTask()
  return listConnections()
    .filter((c) => c.ready && c.ws.readyState === WS_OPEN)
    .map((c) => ({
      agentId: c.agentId, host: c.hostname, projectId: c.projectId, protocol: c.protocol,
      capabilities: c.capabilities, engines: c.engines, defaultExecutor: c.defaultExecutor,
      busy: c.status === 'busy' || active.has(c.agentId), idleSince: c.idleSince,
    }))
}

function toCandidate(row: TaskRow, defaultFallback: RouteSpec[]): CandidateTask {
  return {
    id: row.id, projectId: row.project_id, priority: row.priority, createdAt: row.created_at,
    dependsOn: stringList(row.depends_on), requiredCapabilities: stringList(row.required_capabilities),
    files: stringList(row.files), routes: routesOf(row, defaultFallback),
    pinnedAgent: row.pinned_agent || null, declined: declinedBy(row), lastAgent: row.last_agent,
    inPlan: row.task_key !== null,
  }
}

function loadState(now: number, cfg: ConductorConfig): { input: SelectionInput; rows: Map<string, TaskRow> } {
  const nowIso = isoSeconds(now)
  const rows = pendingWork()
  const pending = rows.map((r) => toCandidate(r, cfg.defaultFallback))
  const quota = db.prepare(
    'SELECT host, executor, model, exhausted_until AS exhaustedUntil FROM conductor_quota WHERE exhausted_until > ?',
  ).all(nowIso) as QuotaRow[]
  return {
    input: {
      pending,
      completedIds: completedAmong(pending.flatMap((t) => t.dependsOn)),
      lockedFiles: lockedFiles(),
      workers: loadWorkers(),
      quota,
      now: nowIso,
    },
    rows: new Map(rows.map((r) => [r.id, r])),
  }
}

export function loadSelectionInput(now: number): SelectionInput {
  return loadState(now, getConductorConfig()).input
}

/** A new lease: now + `leaseHours`, as `lease_expires_at` stores it. */
export function leaseUntil(now: number, cfg: ConductorConfig): string {
  return isoSeconds(now + cfg.leaseHours * 3600_000)
}

/** Writes the wait only when it changed; a change to `capacity` or `no_worker` tells the lead once. */
function applyWait(row: TaskRow, wait: Wait, routes: RouteSpec[]): void {
  if (row.wait_reason === wait.reason && row.wait_until === wait.until) return
  db.prepare("UPDATE conductor_tasks SET wait_reason = ?, wait_until = ? WHERE id = ? AND status = 'pending'")
    .run(wait.reason, wait.until, row.id)
  if (wait.reason === row.wait_reason) return
  if (wait.reason === 'capacity') {
    notifyLead(row, 'capacity', formatNotification('capacity', row, { until: wait.until }))
  } else if (wait.reason === 'no_worker') {
    notifyLead(row, 'no_worker', formatNotification('no_worker', row, { routes: routes.map(routeLabel).join(' → ') }))
  }
}

/** The conditional assign; null when the task is no longer pending. */
function applyAssignment(row: TaskRow, a: Assignment, now: number, cfg: ConductorConfig): TaskRow | null {
  const changed = db.prepare(`
    UPDATE conductor_tasks
    SET status = 'assigned', assigned_to_agent = ?, assigned_at = ?, attempt = attempt + 1, current_route = ?,
        lease_expires_at = ?, last_agent = ?, branch = COALESCE(NULLIF(branch, ''), ?), wait_reason = NULL, wait_until = NULL
    WHERE id = ? AND status = 'pending'
  `).run(a.agentId, isoSeconds(now), JSON.stringify(a.route), leaseUntil(now, cfg), a.agentId,
    branchFor(row, cfg.branchTemplate), row.id).changes
  if (changed === 0) return null
  logTask(row.id, a.agentId, 'assigned', routeLabel(a.route))
  return getTask(row.id) ?? null
}

let running = false
let rerun = false

/** One load–select–apply pass in a transaction, then the pushes. Agents in `sendFailed` count as busy. */
function dispatchPass(now: number, sendFailed: Set<string>): Assignment[] {
  const cfg = getConductorConfig()
  const applied = db.transaction((): { assignment: Assignment; task: TaskRow }[] => {
    const { input, rows } = loadState(now, cfg)
    input.workers = input.workers.map((w) => (sendFailed.has(w.agentId) ? { ...w, busy: true } : w))
    const { assign, wait } = selectAssignments(input)
    const assigned = new Set(assign.map((a) => a.taskId))
    const routes = new Map(input.pending.map((t) => [t.id, t.routes]))
    for (const w of wait) {
      const row = rows.get(w.taskId)
      if (row !== undefined && !assigned.has(w.taskId)) applyWait(row, w, routes.get(w.taskId) ?? [])
    }
    const out: { assignment: Assignment; task: TaskRow }[] = []
    for (const a of assign) {
      const row = rows.get(a.taskId)
      const task = row === undefined ? null : applyAssignment(row, a, now, cfg)
      if (task !== null) out.push({ assignment: a, task })
    }
    return out
  })()

  const sent: Assignment[] = []
  for (const { assignment, task } of applied) {
    if (sendTo(assignment.agentId, assignedMsg(task, baseBranchFor(task.project_id), 'task.assigned'))) {
      sent.push(assignment)
    } else {
      sendFailed.add(assignment.agentId)
      // returnTask's own dispatch() call lands while this one runs, so it asks for one more pass
      returnTask(task.id, 'send failed')
    }
  }
  return sent
}

/**
 * Assigns ready tasks to idle workers and pushes `task.assigned`. Synchronous;
 * a call made while one runs (e.g. from a send) only asks the running call for
 * one more pass. Returns the assignments that were applied and delivered.
 */
export function dispatch(now: number = Date.now()): Assignment[] {
  if (running) {
    rerun = true
    return []
  }
  running = true
  const sendFailed = new Set<string>()
  const done: Assignment[] = []
  try {
    do {
      rerun = false
      done.push(...dispatchPass(now, sendFailed))
    } while (rerun)
  } finally {
    running = false
    rerun = false
  }
  return done
}

/**
 * Pull mode (`cortex_task_pickup` without a worker): the first ready task that
 * is pinned to the caller, or unpinned with no executor and no required
 * capabilities, becomes `accepted` by the caller. Null when there is none.
 * A pin matches when it equals one of the caller's ids after normalizing both
 * (no substring match); an empty pin means unpinned. With `projectId` given,
 * only that project's tasks and project-less ones are eligible; without it
 * there is no project filter, as for a protocol-1 worker. With `taskId` given,
 * only that task is considered (claiming one task by id).
 */
export function pickForPull(
  identity: { agentId?: string; apiKeyOwner?: string; sessionAgent?: string; projectId?: string | null; taskId?: string },
  now: number = Date.now(),
): TaskRow | null {
  const { agentId, apiKeyOwner, sessionAgent, projectId, taskId } = identity
  const assignee = agentId ?? apiKeyOwner ?? sessionAgent
  if (!assignee) return null
  const callerIds = [agentId, apiKeyOwner, sessionAgent].map(normalizeIdentity).filter(Boolean)
  const cfg = getConductorConfig()

  return db.transaction((): TaskRow | null => {
    const rows = pendingWork()
    const completed = completedAmong(rows.flatMap((r) => stringList(r.depends_on)))
    const locks = lockedFiles()
    const nowIso = isoSeconds(now)
    for (const row of rows) {
      if (taskId !== undefined && row.id !== taskId) continue
      if (projectId !== undefined && row.project_id !== null && row.project_id !== projectId) continue
      const pinned = row.pinned_agent || null
      const takes = pinned !== null
        ? callerIds.includes(normalizeIdentity(pinned))
        : !row.executor && stringList(row.required_capabilities).length === 0
      if (!takes) continue
      if (declinedBy(row).some((d) => callerIds.includes(normalizeIdentity(d)))) continue
      if (!stringList(row.depends_on).every((id) => completed.has(id))) continue
      const files = stringList(row.files)
      if (locks.some((held) => pathsConflict(held, files))) continue

      const changed = db.prepare(`
        UPDATE conductor_tasks
        SET status = 'accepted', assigned_to_agent = ?, assigned_at = ?, accepted_at = ?, attempt = attempt + 1,
            lease_expires_at = ?, last_agent = ?, context = ?, branch = COALESCE(NULLIF(branch, ''), ?),
            wait_reason = NULL, wait_until = NULL
        WHERE id = ? AND status = 'pending'
      `).run(assignee, nowIso, nowIso, leaseUntil(now, cfg), assignee,
        JSON.stringify({ ...taskContext(row), pull: true }), branchFor(row, cfg.branchTemplate), row.id).changes
      if (changed === 0) continue
      logTask(row.id, assignee, 'accepted', 'picked up in pull mode')
      return getTask(row.id) ?? null
    }
    return null
  })()
}
