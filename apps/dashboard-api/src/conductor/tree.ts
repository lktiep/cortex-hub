// Plan trees (spec §6.2, §6.9): a whole task tree in one call, with keys,
// groups, gates, dependencies and cycle checks. Rerouting an existing task
// lives in lifecycle.ts (`rerouteTask`) because it changes status.
import { randomUUID } from 'crypto'
import { EXECUTORS, PRIORITY_LABELS, type RouteSpec, type TreeCreateRequest, type TreeCreateResponse, type TreeTaskInput } from '@cortex/shared-types'
import { db } from '../db/client.js'
import { dispatch } from './dispatcher.js'
import { normalizeFiles } from './files.js'
import { logTask, type TaskRow } from './rows.js'

export type TreeError = { error: string; cycle?: string[] }

const DEFAULT_PRIORITY = 5

/** `critical` 1 … `low` 8; a number passes through; absent → 5; an unknown name → null. */
export function priorityValue(p: number | string | undefined): number | null {
  if (p === undefined) return DEFAULT_PRIORITY
  if (typeof p === 'number') return p
  return Object.hasOwn(PRIORITY_LABELS, p) ? PRIORITY_LABELS[p as keyof typeof PRIORITY_LABELS] : null
}

/** The first cycle reachable from `nodes` as a path that ends where it began (`['A','B','A']`), else null. */
export function findCycle(nodes: string[], edges: ReadonlyMap<string, string[]>): string[] | null {
  const done = new Set<string>()
  const path: string[] = []
  const onPath = new Set<string>()
  const visit = (node: string): string[] | null => {
    if (onPath.has(node)) return [...path.slice(path.indexOf(node)), node]
    if (done.has(node)) return null
    path.push(node)
    onPath.add(node)
    for (const next of edges.get(node) ?? []) {
      const found = visit(next)
      if (found !== null) return found
    }
    path.pop()
    onPath.delete(node)
    done.add(node)
    return null
  }
  for (const node of nodes) {
    const found = visit(node)
    if (found !== null) return found
  }
  return null
}

/** True for an executor name the hub knows. */
export function knownExecutor(e: unknown): boolean {
  return typeof e === 'string' && (EXECUTORS as readonly string[]).includes(e)
}

/** The first problem in a fallback list, or null. A `null` executor means "any". */
export function fallbackProblem(fallback: RouteSpec[] | null | undefined): string | null {
  if (fallback === undefined || fallback === null) return null
  if (!Array.isArray(fallback)) return 'fallback must be a list'
  for (const f of fallback as unknown[]) {
    if (typeof f !== 'object' || f === null || Array.isArray(f)) return 'fallback entries must be objects'
  }
  for (const f of fallback) {
    if (f.executor !== null && !knownExecutor(f.executor)) return `unknown fallback executor ${String(f.executor)}`
  }
  return null
}

/** A problem text when `value` is present but not an array of strings, else null. */
export function stringListProblem(name: string, value: unknown): string | null {
  if (value === undefined) return null
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? null : `${name} must be a list of strings`
}

function newId(): string {
  return `task_${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

function fail(error: string, cycle?: string[]): { ok: false; err: TreeError } {
  return { ok: false, err: cycle === undefined ? { error } : { error, cycle } }
}

/** Keys already used in the tree that contains `parentId`. */
function keysInTreeOf(parentId: string): Set<string> {
  let root = parentId
  for (;;) {
    const up = db.prepare('SELECT parent_task_id FROM conductor_tasks WHERE id = ?').get(root) as { parent_task_id: string | null } | undefined
    if (up?.parent_task_id === null || up === undefined) break
    root = up.parent_task_id
  }
  const rows = db.prepare(`
    WITH RECURSIVE tree(id) AS (
      SELECT ? UNION SELECT t.id FROM conductor_tasks t JOIN tree ON t.parent_task_id = tree.id
    )
    SELECT task_key FROM conductor_tasks WHERE id IN (SELECT id FROM tree) AND task_key IS NOT NULL
  `).all(root) as { task_key: string }[]
  return new Set(rows.map((r) => r.task_key))
}

interface Plan {
  input: TreeTaskInput
  kind: 'work' | 'gate' | 'group'
  priority: number
  files: string[]
  /** Own and inherited dependencies: keys of this call, or ids of stored tasks. */
  deps: string[]
}

/** Validates the whole request; nothing is written. */
function plan(req: TreeCreateRequest, existingKeys: Set<string>): { plans: Map<string, Plan> } | { err: TreeError } {
  const plans = new Map<string, Plan>()
  if (!Array.isArray(req.tasks)) return { err: { error: 'tasks must be a list' } }
  for (const input of req.tasks) {
    if (typeof input !== 'object' || input === null) return { err: { error: 'every task must be an object' } }
    if (typeof input.key !== 'string' || input.key === '') return { err: { error: 'every task needs a non-empty key' } }
    if (plans.has(input.key)) return { err: { error: `duplicate key ${input.key}` } }
    if (existingKeys.has(input.key)) return { err: { error: `key ${input.key} is already used in that tree` } }
    for (const [name, value] of [['dependsOn', input.dependsOn], ['files', input.files]] as const) {
      const bad = stringListProblem(name, value)
      if (bad !== null) return { err: { error: `${input.key}: ${bad}` } }
    }
    const kind = input.kind ?? 'work'
    const priority = priorityValue(input.priority)
    if (priority === null) return { err: { error: `${input.key}: unknown priority ${String(input.priority)}` } }
    if (input.executor !== undefined && !knownExecutor(input.executor)) return { err: { error: `${input.key}: unknown executor ${String(input.executor)}` } }
    const problem = fallbackProblem(input.fallback)
    if (problem !== null) return { err: { error: `${input.key}: ${problem}` } }
    if (input.approver !== undefined && kind !== 'gate') return { err: { error: `${input.key}: approver is only for gates` } }
    let files: string[] = []
    try { files = normalizeFiles(input.files ?? []) } catch (e) { return { err: { error: `${input.key}: ${(e as Error).message}` } } }
    plans.set(input.key, { input, kind, priority, files, deps: [...new Set(input.dependsOn ?? [])] })
  }
  for (const [key, p] of plans) {
    const parentKey = p.input.parentKey
    if (parentKey !== undefined && plans.get(parentKey)?.kind !== 'group') {
      return { err: { error: `${key}: parentKey ${parentKey} is not a group in this call` } }
    }
    for (const dep of p.deps) {
      if (plans.has(dep)) continue
      if (db.prepare('SELECT 1 FROM conductor_tasks WHERE id = ?').get(dep) === undefined) {
        return { err: { error: `${key}: unknown dependency ${dep}` } }
      }
    }
  }
  return { plans }
}

/** Every group's `dependsOn` goes to all its descendants: a de-duplicated union, so nested groups accumulate. */
function inheritGroupDeps(plans: Map<string, Plan>): void {
  const own = new Map([...plans].map(([key, p]) => [key, p.deps]))
  for (const [key, p] of plans) {
    const seen = new Set([key])
    for (let up = p.input.parentKey; up !== undefined && !seen.has(up); up = plans.get(up)?.input.parentKey) {
      seen.add(up)
      p.deps = [...new Set([...p.deps, ...(own.get(up) ?? [])])]
    }
  }
}

/** Dependencies, plus each group → its children (so a task depending on its own group is a cycle). */
function callEdges(plans: Map<string, Plan>): Map<string, string[]> {
  const edges = new Map<string, string[]>()
  for (const [key, p] of plans) {
    edges.set(key, [...(edges.get(key) ?? []), ...p.deps.filter((d) => plans.has(d))])
    const parent = p.input.parentKey
    if (parent !== undefined) edges.set(parent, [...(edges.get(parent) ?? []), key])
  }
  return edges
}

function completedIds(ids: string[]): Set<string> {
  if (ids.length === 0) return new Set()
  const rows = db.prepare("SELECT id FROM conductor_tasks WHERE status = 'completed' AND id IN (SELECT value FROM json_each(?))")
    .all(JSON.stringify(ids)) as { id: string }[]
  return new Set(rows.map((r) => r.id))
}

export function createTree(
  req: TreeCreateRequest, owner: string | null,
): { ok: true; res: TreeCreateResponse } | { ok: false; err: TreeError } {
  let parent: TaskRow | undefined
  if (req.parentId !== undefined) {
    parent = db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(req.parentId) as TaskRow | undefined
    if (parent === undefined) return fail(`parentId ${req.parentId} not found`)
  }
  const planned = plan(req, req.parentId === undefined ? new Set() : keysInTreeOf(req.parentId))
  if ('err' in planned) return { ok: false, err: planned.err }
  const { plans } = planned
  inheritGroupDeps(plans)
  const cycle = findCycle([...plans.keys()], callEdges(plans))
  if (cycle !== null) return fail(`dependency cycle: ${cycle.join(' -> ')}`, cycle)

  const ids: Record<string, string> = {}
  for (const key of plans.keys()) ids[key] = newId()
  const idOf = (key: string): string => {
    const id = ids[key]
    if (id === undefined) throw new Error(`tree: no id for key ${key}`)
    return id
  }
  const projectOf = (key: string): string | null => {
    const parentKey = plans.get(key)?.input.parentKey
    return req.projectId ?? (parentKey === undefined ? parent?.project_id ?? null : projectOf(parentKey))
  }
  const stored = [...new Set([...plans.values()].flatMap((p) => p.deps.filter((d) => !plans.has(d))))]
  const insert = db.prepare(`
    INSERT INTO conductor_tasks (
      id, title, description, project_id, parent_task_id, created_by_agent, status, priority, required_capabilities,
      depends_on, context, api_key_owner, task_key, kind, approver, executor, model, effort, fallback, files, branch,
      pinned_agent, review_required
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  let ready = 0
  db.transaction(() => {
    const done = completedIds(stored)
    for (const [key, p] of plans) {
      const t = p.input
      const blocked = p.kind !== 'group' && p.deps.some((d) => plans.has(d) || !done.has(d))
      if (!blocked && p.kind === 'work') ready++
      const parentId = t.parentKey === undefined ? req.parentId ?? null : idOf(t.parentKey)
      const deps = p.deps.map((d) => ids[d] ?? d)
      insert.run(
        idOf(key), t.title, t.description ?? '', projectOf(key), parentId, owner, blocked ? 'blocked' : 'pending', p.priority,
        JSON.stringify(t.requiredCapabilities ?? []), JSON.stringify(deps), JSON.stringify(t.context ?? {}), owner, key,
        p.kind, p.kind === 'gate' ? t.approver ?? 'user' : null, t.executor ?? null, t.model ?? null, t.effort ?? null,
        t.fallback === undefined ? null : JSON.stringify(t.fallback), JSON.stringify(p.files), t.branch ?? null,
        t.pinnedAgent ?? null, p.kind === 'work' ? (t.reviewRequired ?? true ? 1 : 0) : 0,
      )
      logTask(idOf(key), owner, 'created', `tree task ${key}`)
    }
  })()
  dispatch()
  const rootIds = [...plans].filter(([, p]) => p.input.parentKey === undefined).map(([key]) => idOf(key))
  return { ok: true, res: { ids, rootIds, ready } }
}
