// Plan layout: depth columns, machine lanes and the phase view as plain geometry.
// Pure module — no React, no DOM; the diagram only renders what this returns.
import type { ConductorWorker } from '../api'
import type { PlanTask } from './model'

export interface Size {
  W: number
  H: number
  COL_W: number
  ROW_H: number
  LABEL_W: number
}

export const SIZES: { compact: Size; detail: Size; HEAD_H: 34 } = {
  compact: { W: 168, H: 34, COL_W: 190, ROW_H: 40, LABEL_W: 120 },
  detail: { W: 222, H: 112, COL_W: 248, ROW_H: 128, LABEL_W: 130 },
  HEAD_H: 34,
}

const LANE_PAD = 24
const CELL_INSET = 12
const QUEUE = 'queue'

export interface Lane {
  id: string
  label: string
  sub: string
  online: boolean
  agentIds: string[]
}

export interface PhaseSelection {
  groupId: string
  members: Set<string>
  inputs: Set<string>
  outputs: Set<string>
}

export interface Cell {
  id: string
  col: number
  laneId: string
  x: number
  y: number
  w: number
  h: number
  ghost: 'input' | 'output' | null
}

export interface PlanLayout {
  cells: Cell[]
  columns: { col: number; x: number; label: string }[]
  lanes: (Lane & { y: number; height: number })[]
  width: number
  height: number
  cyclic: Set<string>
}

const drawable = (t: PlanTask) => t.kind !== 'group'

const byKey = (a: PlanTask, b: PlanTask) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)

/**
 * Column of every work/gate task: the length of its longest dependency chain. Kahn's algorithm
 * places the acyclic part; what it cannot reach is split into strongly connected components, the
 * members of any cycle are reported, and each component sits one column past its deepest dependency.
 */
export function computeDepths(tasks: PlanTask[]): { depth: Map<string, number>; cyclic: Set<string> } {
  const nodes = tasks.filter(drawable)
  const ids = new Set(nodes.map((t) => t.id))
  const depsOf = new Map(nodes.map((t) => [t.id, t.deps.filter((d) => ids.has(d) && d !== t.id)]))
  const selfLoop = new Set(nodes.filter((t) => t.deps.includes(t.id)).map((t) => t.id))
  const depth = new Map<string, number>()
  const cyclic = new Set<string>()

  const waiting = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const [id, ds] of depsOf) {
    waiting.set(id, new Set(ds).size)
    for (const d of new Set(ds)) {
      const list = dependents.get(d)
      if (list) list.push(id)
      else dependents.set(d, [id])
    }
  }
  const queue = [...waiting].filter(([, n]) => n === 0).map(([id]) => id)
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head] as string
    let d = 0
    for (const dep of depsOf.get(id) ?? []) d = Math.max(d, (depth.get(dep) as number) + 1)
    depth.set(id, d)
    for (const next of dependents.get(id) ?? []) {
      const left = (waiting.get(next) as number) - 1
      waiting.set(next, left)
      if (left === 0) queue.push(next)
    }
  }

  const rest = nodes.filter((t) => !depth.has(t.id)).map((t) => t.id)
  if (rest.length === 0) return { depth, cyclic }
  const inRest = new Set(rest)
  // Tarjan emits a component only after everything it depends on, so one pass assigns depths.
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  let counter = 0
  const open = (id: string, frames: { id: string; next: number }[]): void => {
    index.set(id, counter)
    low.set(id, counter)
    counter++
    stack.push(id)
    onStack.add(id)
    frames.push({ id, next: 0 })
  }
  const close = (id: string): void => {
    if (low.get(id) !== index.get(id)) return
    const comp: string[] = []
    let top: string
    do {
      top = stack.pop() as string
      onStack.delete(top)
      comp.push(top)
    } while (top !== id)
    const members = new Set(comp)
    let d = 0
    for (const m of comp) {
      for (const dep of depsOf.get(m) ?? []) if (!members.has(dep)) d = Math.max(d, (depth.get(dep) as number) + 1)
    }
    for (const m of comp) depth.set(m, d)
    if (comp.length > 1 || selfLoop.has(id)) for (const m of comp) cyclic.add(m)
  }
  // Iterative (explicit frames): a long ring must not overflow the call stack.
  const visit = (start: string): void => {
    const frames: { id: string; next: number }[] = []
    open(start, frames)
    while (frames.length > 0) {
      const frame = frames[frames.length - 1] as { id: string; next: number }
      const deps = depsOf.get(frame.id) ?? []
      if (frame.next < deps.length) {
        const dep = deps[frame.next++] as string
        if (!inRest.has(dep)) continue
        if (!index.has(dep)) open(dep, frames)
        else if (onStack.has(dep)) low.set(frame.id, Math.min(low.get(frame.id) as number, index.get(dep) as number))
        continue
      }
      frames.pop()
      close(frame.id)
      const parent = frames[frames.length - 1]
      if (parent) low.set(parent.id, Math.min(low.get(parent.id) as number, low.get(frame.id) as number))
    }
  }
  for (const id of rest) if (!index.has(id)) visit(id)
  return { depth, cyclic }
}

/**
 * Machine lanes: online hosts by name, then offline agents, then the queue; only lanes in use.
 * Lane ids are namespaced (`host:`, `agent:`, `queue`) so a host, an agent and the queue never collide.
 */
export function assignLanes(
  tasks: PlanTask[],
  workers: ConductorWorker[],
): { lanes: Lane[]; laneOf: Map<string, string> } {
  const hostOf = new Map(workers.map((w) => [w.agentId, w.hostname ?? w.agentId]))
  const hosts = new Map<string, ConductorWorker[]>()
  for (const w of workers) {
    const host = hostOf.get(w.agentId) as string
    const list = hosts.get(host)
    if (list) list.push(w)
    else hosts.set(host, [w])
  }

  const nodes = tasks.filter(drawable)
  const nodeById = new Map(nodes.map((t) => [t.id, t]))
  const laneOf = new Map<string, string>()
  const offline = new Set<string>()
  const laneOfWork = (t: PlanTask): string => {
    if (!t.agent) return QUEUE
    const host = hostOf.get(t.agent)
    if (host !== undefined) return `host:${host}`
    offline.add(t.agent)
    return `agent:${t.agent}`
  }
  for (const t of nodes) if (t.kind === 'work') laneOf.set(t.id, laneOfWork(t))

  const firstDependent = new Map<string, PlanTask>()
  for (const t of [...nodes].sort(byKey)) {
    for (const d of t.deps) if (!firstDependent.has(d)) firstDependent.set(d, t)
  }
  const resolveGate = (g: PlanTask, visiting: Set<string>): string => {
    const known = laneOf.get(g.id)
    if (known) return known
    const next = firstDependent.get(g.id)
    let lane = QUEUE
    if (next && !visiting.has(next.id)) {
      if (next.kind === 'gate') {
        visiting.add(g.id)
        lane = resolveGate(nodeById.get(next.id) as PlanTask, visiting)
      } else {
        lane = laneOf.get(next.id) ?? QUEUE
      }
    }
    laneOf.set(g.id, lane)
    return lane
  }
  for (const t of nodes) if (t.kind === 'gate') resolveGate(t, new Set())

  const used = new Set(laneOf.values())
  const lanes: Lane[] = []
  const onlineHosts = [...hosts.keys()].filter((h) => used.has(`host:${h}`)).sort()
  for (const host of onlineHosts) {
    const ws = hosts.get(host) as ConductorWorker[]
    const agentIds = ws.map((w) => w.agentId).sort()
    const os = ws.find((w) => w.os)?.os
    lanes.push({ id: `host:${host}`, label: host, sub: [os, agentIds.join(', ')].filter(Boolean).join(' · '), online: true, agentIds })
  }
  for (const agent of [...offline].sort()) {
    if (used.has(`agent:${agent}`)) lanes.push({ id: `agent:${agent}`, label: agent, sub: 'offline', online: false, agentIds: [agent] })
  }
  if (used.has(QUEUE)) lanes.push({ id: QUEUE, label: 'Queue', sub: 'unassigned', online: true, agentIds: [] })
  return { lanes, laneOf }
}

/** The tasks of one group plus the tasks it reads from (inputs) and the tasks it unlocks (outputs). */
export function selectPhase(tasks: PlanTask[], groupId: string): PhaseSelection {
  const nodes = tasks.filter(drawable)
  const members = new Set(nodes.filter((t) => t.groupId === groupId).map((t) => t.id))
  const known = new Set(nodes.map((t) => t.id))
  const inputs = new Set<string>()
  for (const t of nodes) {
    if (!members.has(t.id)) continue
    for (const d of t.deps) if (known.has(d) && !members.has(d)) inputs.add(d)
  }
  const outputs = new Set<string>()
  for (const t of nodes) {
    if (members.has(t.id) || inputs.has(t.id)) continue
    if (t.deps.some((d) => members.has(d))) outputs.add(t.id)
  }
  return { groupId, members, inputs, outputs }
}

export function layoutPlan(
  tasks: PlanTask[],
  workers: ConductorWorker[],
  opts: { mode: 'compact' | 'detail'; phase?: PhaseSelection },
): PlanLayout {
  const { phase } = opts
  const size = phase || opts.mode === 'detail' ? SIZES.detail : SIZES.compact
  const nodes = tasks.filter(drawable)
  const shown = phase ? nodes.filter((t) => phase.members.has(t.id) || phase.inputs.has(t.id) || phase.outputs.has(t.id)) : nodes

  const colOf = new Map<string, number>()
  const ghostOf = new Map<string, 'input' | 'output'>()
  let cyclic: Set<string>
  let columnCount: number
  const hasInputs = phase !== undefined && phase.inputs.size > 0
  const hasOutputs = phase !== undefined && phase.outputs.size > 0
  if (phase) {
    const own = computeDepths(nodes.filter((t) => phase.members.has(t.id)))
    cyclic = own.cyclic
    const shift = hasInputs ? 1 : 0
    let last = shift - 1
    for (const [id, d] of own.depth) {
      colOf.set(id, d + shift)
      last = Math.max(last, d + shift)
    }
    for (const id of phase.inputs) {
      colOf.set(id, 0)
      ghostOf.set(id, 'input')
    }
    for (const id of phase.outputs) {
      colOf.set(id, last + 1)
      ghostOf.set(id, 'output')
    }
    columnCount = hasOutputs ? last + 2 : last + 1
  } else {
    const all = computeDepths(nodes)
    cyclic = all.cyclic
    let max = -1
    for (const [id, d] of all.depth) {
      colOf.set(id, d)
      max = Math.max(max, d)
    }
    columnCount = max + 1
  }

  const { lanes: allLanes, laneOf } = assignLanes(tasks, workers)
  const buckets = new Map<string, Map<number, PlanTask[]>>()
  for (const t of shown) {
    const lane = laneOf.get(t.id) as string
    const col = colOf.get(t.id) as number
    let cols = buckets.get(lane)
    if (!cols) buckets.set(lane, (cols = new Map()))
    const list = cols.get(col)
    if (list) list.push(t)
    else cols.set(col, [t])
  }

  const cells: Cell[] = []
  const lanes: PlanLayout['lanes'] = []
  let top = SIZES.HEAD_H
  for (const lane of allLanes) {
    const cols = buckets.get(lane.id)
    if (!cols) continue
    let fullest = 0
    for (const [col, list] of cols) {
      list.sort((a, b) => a.priority - b.priority || byKey(a, b))
      fullest = Math.max(fullest, list.length)
      list.forEach((t, row) => {
        cells.push({
          id: t.id,
          col,
          laneId: lane.id,
          x: size.LABEL_W + col * size.COL_W,
          y: top + CELL_INSET + row * size.ROW_H,
          w: size.W,
          h: size.H,
          ghost: ghostOf.get(t.id) ?? null,
        })
      })
    }
    const height = fullest * size.ROW_H + LANE_PAD
    lanes.push({ ...lane, y: top, height })
    top += height
  }

  const columns = Array.from({ length: columnCount }, (_, col) => {
    let label = `Step ${col + 1}`
    if (phase) {
      if (hasInputs && col === 0) label = 'Inputs'
      else if (hasOutputs && col === columnCount - 1) label = 'Unlocks next'
      else label = `Step ${col - (hasInputs ? 1 : 0) + 1}`
    }
    return { col, x: size.LABEL_W + col * size.COL_W, label }
  })

  return { cells, columns, lanes, width: size.LABEL_W + columnCount * size.COL_W, height: top, cyclic }
}
