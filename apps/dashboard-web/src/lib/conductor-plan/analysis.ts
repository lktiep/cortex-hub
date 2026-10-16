// Plan analysis: critical path (red outline) and same-file conflicts (dashed orange edges).
// Pure module — no React, no DOM.
import type { PlanTask } from './model'
import { computeDepths } from './layout'

export interface FileConflict {
  from: string
  to: string
  file: string
}

export interface CriticalPath {
  ids: string[]
  /** 'from>to' where `from` is the dependency. */
  edges: Set<string>
  days: number
}

/** Paths overlap when equal, or when one is a directory (trailing slash) containing the other. */
export function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true
  if (a.endsWith('/') && b.startsWith(a)) return true
  if (b.endsWith('/') && a.startsWith(b)) return true
  return false
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Pairs of tasks that touch the same file but have no direct dependency. Tasks sharing a path are
 * chained in (depth, key) order rather than linked pairwise; one conflict per unordered pair.
 */
export function fileConflicts(tasks: PlanTask[], depth: Map<string, number>): FileConflict[] {
  const live = tasks.filter((t) => t.kind !== 'group' && t.state !== 'stopped' && t.files.length > 0)
  const d = (t: PlanTask): number => depth.get(t.id) ?? 0
  const order = (a: PlanTask, b: PlanTask): number => d(a) - d(b) || cmp(a.key, b.key) || cmp(a.id, b.id)
  const keys = [...new Set(live.flatMap((t) => t.files))].sort(cmp)

  const pairs = new Map<string, FileConflict>()
  for (const key of keys) {
    const group = live.filter((t) => t.files.some((f) => pathsOverlap(f, key))).sort(order)
    for (let i = 1; i < group.length; i++) {
      const a = group[i - 1] as PlanTask
      const b = group[i] as PlanTask
      if (a.deps.includes(b.id) || b.deps.includes(a.id)) continue
      const id = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`
      // keys ascend, so the first group to emit a pair holds its smallest shared key
      if (!pairs.has(id)) pairs.set(id, { from: a.id, to: b.id, file: key })
    }
  }
  return [...pairs.values()]
}

/** Longest estimate-weighted path through the remaining work and gate tasks. */
export function criticalPath(tasks: PlanTask[], cyclic: Set<string>): CriticalPath {
  const { depth } = computeDepths(tasks)
  const nodes = tasks
    .filter((t) => (t.kind === 'work' || t.kind === 'gate') && t.state !== 'done' && t.state !== 'stopped')
    .sort((a, b) => (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0) || cmp(a.key, b.key) || cmp(a.id, b.id))
  const byId = new Map(nodes.map((t) => [t.id, t]))

  const best = new Map<string, number>()
  const prev = new Map<string, string>()
  for (const t of nodes) {
    let base = 0
    let from: PlanTask | undefined
    if (!cyclic.has(t.id)) {
      for (const depId of t.deps) {
        const dep = byId.get(depId)
        const score = dep ? best.get(dep.id) : undefined
        if (!dep || score === undefined) continue // outside the set, or not yet scored (cycle order)
        if (!from || score > base || (score === base && cmp(dep.key, from.key) < 0)) {
          base = score
          from = dep
        }
      }
    }
    best.set(t.id, base + t.estimate)
    if (from) prev.set(t.id, from.id)
  }

  let end: PlanTask | undefined
  for (const t of nodes) {
    const score = best.get(t.id) as number
    if (!end || score > (best.get(end.id) as number) ||
        (score === best.get(end.id) && cmp(t.key, end.key) < 0)) end = t
  }
  if (!end) return { ids: [], edges: new Set(), days: 0 }

  const ids: string[] = []
  const seen = new Set<string>()
  for (let cur: string | undefined = end.id; cur && !seen.has(cur); cur = prev.get(cur)) {
    seen.add(cur)
    ids.push(cur)
  }
  ids.reverse()
  const edges = new Set<string>()
  for (let i = 1; i < ids.length; i++) edges.add(`${ids[i - 1]}>${ids[i]}`)
  const days = ids.reduce((sum, id) => sum + (byId.get(id)?.estimate ?? 0), 0)
  return { ids, edges, days }
}
