// Plan model: turns raw hub task rows into normalised, dependency-resolved PlanTasks.
// Pure module — no React, no DOM; anything time-dependent takes `now`.
import type { ConductorTask, RouteSpec, TaskReview } from '../api'

export type PlanState =
  | 'done' | 'review' | 'needs_user' | 'gate_lead' | 'escalated'
  | 'running' | 'waiting' | 'ready' | 'blocked' | 'stopped'

export type WaitReason = 'capacity' | 'no_worker' | 'lock'

export interface PlanTask {
  id: string
  key: string
  title: string
  kind: 'work' | 'gate' | 'group'
  approver: 'user' | 'lead' | null
  status: string
  state: PlanState
  parentId: string | null
  groupId: string | null
  deps: string[]
  externalDeps: number
  files: string[]
  estimate: number
  priority: number
  primary: RouteSpec | null
  route: RouteSpec | null
  waitReason: WaitReason | null
  waitUntil: string | null
  escalated: boolean
  rejectCount: number
  failCount: number
  agent: string | null
  reviews: TaskReview[]
  row: ConductorTask
}

const RUNNING = new Set(['assigned', 'accepted', 'in_progress', 'analyzing', 'synthesis', 'discussion', 'strategy_review'])
const WAIT_REASONS = new Set<string>(['capacity', 'no_worker', 'lock'])

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isReview(v: unknown): v is TaskReview {
  return isRecord(v) && typeof v.at === 'string' && typeof v.by === 'string' &&
    (v.verdict === 'approve' || v.verdict === 'reject') && typeof v.feedback === 'string'
}

function asWaitReason(v: string | null | undefined): WaitReason | null {
  return v && WAIT_REASONS.has(v) ? (v as WaitReason) : null
}

export function deriveState(row: ConductorTask): PlanState {
  const s = row.status
  if (s === 'completed' || s === 'approved') return 'done'
  if (s === 'review') return 'review'
  if (s === 'pending') {
    if (row.escalated_at) return 'escalated'
    if (row.kind === 'gate') return row.approver === 'lead' ? 'gate_lead' : 'needs_user'
    return asWaitReason(row.wait_reason) ? 'waiting' : 'ready'
  }
  if (RUNNING.has(s)) return 'running'
  if (s === 'blocked') return 'blocked'
  return 'stopped' // cancelled, failed, rejected and anything unknown
}

function routeFromColumns(row: ConductorTask): RouteSpec | null {
  if (row.executor == null && row.model == null && row.effort == null) return null
  return {
    executor: (row.executor ?? null) as RouteSpec['executor'],
    model: row.model ?? null,
    effort: row.effort ?? null,
  }
}

function parseRoute(value: string | null | undefined): RouteSpec | null {
  const v = parseJson<unknown>(value, null)
  if (!isRecord(v)) return null
  const str = (x: unknown) => (typeof x === 'string' ? x : null)
  return {
    executor: str(v.executor) as RouteSpec['executor'],
    model: str(v.model),
    effort: str(v.effort),
  }
}

function toPlanTask(row: ConductorTask): PlanTask {
  const context = parseJson<unknown>(row.context, {})
  const ctx = isRecord(context) ? context : {}
  const files = parseJson<unknown>(row.files, [])
  const deps = parseJson<unknown>(row.depends_on, [])
  const estimate = ctx.estimate
  const primary = routeFromColumns(row)
  return {
    id: row.id,
    key: row.task_key || row.id.slice(0, 8),
    title: row.title,
    kind: row.kind === 'gate' || row.kind === 'group' ? row.kind : 'work',
    approver: row.approver === 'user' || row.approver === 'lead' ? row.approver : null,
    status: row.status,
    state: deriveState(row),
    parentId: row.parent_task_id,
    groupId: null,
    deps: Array.isArray(deps) ? deps.filter((d): d is string => typeof d === 'string') : [],
    externalDeps: 0,
    files: Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string') : [],
    estimate: typeof estimate === 'number' && Number.isFinite(estimate) && estimate > 0 ? estimate : 1,
    priority: row.priority,
    primary,
    route: parseRoute(row.current_route) ?? primary,
    waitReason: asWaitReason(row.wait_reason),
    waitUntil: row.wait_until ?? null,
    escalated: Boolean(row.escalated_at),
    rejectCount: row.reject_count ?? 0,
    failCount: row.fail_count ?? 0,
    agent: row.assigned_to_agent ?? row.last_agent ?? null,
    reviews: Array.isArray(ctx.reviews) ? ctx.reviews.filter(isReview) : [],
    row,
  }
}

/**
 * Rows of one plan tree → PlanTasks (root excluded) with groupId set and deps resolved. A work or
 * gate root with no descendants is itself the plan: it comes back as a one-task plan.
 */
export function toPlanTasks(root: ConductorTask, rows: ConductorTask[]): PlanTask[] {
  const tasks = rows.filter((r) => r.id !== root.id).map(toPlanTask)
  if (tasks.length === 0) {
    if (root.kind === 'group') return []
    const solo = toPlanTask(root)
    solo.parentId = null
    resolveDeps([solo])
    return [solo]
  }
  const byId = new Map(tasks.map((t) => [t.id, t]))
  for (const t of tasks) {
    const seen = new Set<string>([t.id])
    let p = t.parentId ? byId.get(t.parentId) : undefined
    while (p && !seen.has(p.id)) {
      if (p.kind === 'group') {
        t.groupId = p.id
        break
      }
      seen.add(p.id)
      p = p.parentId ? byId.get(p.parentId) : undefined
    }
  }
  resolveDeps(tasks)
  return tasks
}

/**
 * In place: drops dependencies outside `tasks` (counted in externalDeps) and replaces a dependency
 * on a group by the group's sinks — its descendant work/gate tasks that no other descendant needs.
 */
export function resolveDeps(tasks: PlanTask[]): void {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const rawDeps = new Map(tasks.map((t) => [t.id, [...t.deps]]))
  const children = new Map<string, PlanTask[]>()
  for (const t of tasks) {
    if (!t.parentId) continue
    const list = children.get(t.parentId)
    if (list) list.push(t)
    else children.set(t.parentId, [t])
  }

  const leavesOf = (groupId: string): PlanTask[] => {
    const out: PlanTask[] = []
    const seen = new Set<string>([groupId])
    const walk = (id: string) => {
      for (const c of children.get(id) ?? []) {
        if (seen.has(c.id)) continue
        seen.add(c.id)
        if (c.kind !== 'group') out.push(c)
        walk(c.id)
      }
    }
    walk(groupId)
    return out
  }

  // Leaf ids a dependency on `id` stands for; `visiting` guards group cycles. A group's sinks are
  // memoised unless a cycle cut made them incomplete, so a chain of groups is linear.
  const sinksCache = new Map<string, string[]>()
  let cuts = 0
  const expand = (id: string, visiting: Set<string>): string[] => {
    const t = byId.get(id)
    if (!t) return []
    if (t.kind !== 'group') return [id]
    const cached = sinksCache.get(id)
    if (cached) return cached
    if (visiting.has(id)) {
      cuts++
      return []
    }
    visiting.add(id)
    const cutsBefore = cuts
    const leaves = leavesOf(id)
    const inside = new Set(leaves.map((l) => l.id))
    const needed = new Set<string>()
    for (const leaf of leaves) {
      for (const d of rawDeps.get(leaf.id) ?? []) {
        for (const e of expand(d, visiting)) if (e !== leaf.id && inside.has(e)) needed.add(e)
      }
    }
    const sinks = leaves.filter((l) => !needed.has(l.id)).map((l) => l.id)
    visiting.delete(id)
    if (cuts === cutsBefore) sinksCache.set(id, sinks)
    return sinks
  }

  for (const t of tasks) {
    const out: string[] = []
    let external = 0
    for (const d of rawDeps.get(t.id) ?? []) {
      if (!byId.has(d)) {
        external++
        continue
      }
      for (const e of expand(d, new Set())) {
        if (e !== t.id && !out.includes(e)) out.push(e)
      }
    }
    t.deps = out
    t.externalDeps += external
  }
}

/** Strips a vendor prefix: gemini-4-argon-low → argon-low, claude-opus-5-5 → opus-5-5. */
export function shortModel(model: string): string {
  return model.replace(/^gemini-\d+(?:\.\d+)*-/, '').replace(/^claude-/, '')
}

export function routeLabel(route: RouteSpec | null): string | null {
  if (!route) return null
  const model = route.model ? shortModel(route.model) : null
  if (route.executor && model) return `${route.executor}·${model}`
  return route.executor ?? model
}

export function formatUntil(iso: string, now: Date): string {
  const ms = new Date(iso).getTime() - now.getTime()
  if (!(ms > 0)) return 'now'
  const total = Math.ceil(ms / 60_000)
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0) return `in ${m}m`
  return m === 0 ? `in ${h}h` : `in ${h}h ${m}m`
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** One-line reason a task is not simply running; precedence escalated, wait reason, fallback. */
export function nodeNote(task: PlanTask, now: Date): string | null {
  if (task.state === 'escalated') {
    if (task.rejectCount > 0) return `escalated · ${plural(task.rejectCount, 'rejection')}`
    if (task.failCount > 0) return `escalated · ${plural(task.failCount, 'failure')}`
    return 'escalated'
  }
  if (task.state !== 'waiting') return fallbackNote(task)
  if (task.waitReason === 'capacity') {
    return task.waitUntil ? `quota · resets ${formatUntil(task.waitUntil, now)}` : 'quota exhausted'
  }
  if (task.waitReason === 'no_worker') return `no worker for ${routeLabel(task.route ?? task.primary) ?? 'this task'}`
  if (task.waitReason === 'lock') return 'waiting on a file lock'
  return fallbackNote(task)
}

function fallbackNote(task: PlanTask): string | null {
  const from = routeLabel(task.primary)
  if (from && task.route && routeLabel(task.route) !== from) return `fallback from ${from}`
  return null
}
