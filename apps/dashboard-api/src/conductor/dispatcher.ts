// Dispatcher (spec §6.4). selectAssignments() and its helpers are pure: they
// decide from plain state which worker takes which ready task on which route,
// and why the others wait, without reading the database or the registry.
import type { EngineInfo, RouteSpec, WaitReason } from '@cortex/shared-types'
import { pathsConflict } from './files.js'

export interface CandidateTask {
  id: string; projectId: string | null; priority: number; createdAt: string
  dependsOn: string[]; requiredCapabilities: string[]; files: string[]
  routes: RouteSpec[]; pinnedAgent: string | null; declined: string[]; lastAgent: string | null
}
export interface CandidateWorker {
  agentId: string; host: string; projectId: string | null; protocol: 1 | 2
  capabilities: string[]; engines: EngineInfo[]; busy: boolean; idleSince: number
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

/** A legacy (protocol 1) worker takes any project; otherwise its own project's tasks and project-less ones. */
function servesProject(worker: CandidateWorker, task: CandidateTask): boolean {
  if (worker.protocol === 1) return true
  return task.projectId === null || task.projectId === worker.projectId
}

function listsModel(engine: EngineInfo, model: string): boolean {
  return engine.models.includes(model) || engine.models.includes('*')
}

/** The worker's engines that can run the route. */
function fittingEngines(worker: CandidateWorker, route: RouteSpec): EngineInfo[] {
  const { executor, model } = route
  return worker.engines.filter((e) =>
    (executor === null || e.executor === executor) && (model === null || listsModel(e, model)))
}

/** An executor-null, model-null route fits any worker, even one without engines. */
function fitsRoute(worker: CandidateWorker, route: RouteSpec): boolean {
  if (route.executor === null && route.model === null) return true
  return fittingEngines(worker, route).length > 0
}

function staticallyEligible(task: CandidateTask, route: RouteSpec, worker: CandidateWorker): boolean {
  return servesProject(worker, task)
    && !task.declined.includes(worker.agentId)
    && (task.pinnedAgent === null || task.pinnedAgent === worker.agentId)
    && task.requiredCapabilities.every((c) => worker.capabilities.includes(c))
    && fitsRoute(worker, route)
}

/**
 * The rows that keep the worker off this route, or null when it is free.
 * The worker is blocked only when it has a fitting engine and every fitting
 * engine is blocked. A model-null route is checked against each engine's
 * `defaultModel`; an engine without one is blocked only by `*` rows.
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
