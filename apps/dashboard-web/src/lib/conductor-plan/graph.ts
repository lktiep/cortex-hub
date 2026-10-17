// Plan graph: the dependency DAG by depth column, with SVG paths for every edge.
// Pure module — no React, no DOM; the graph only renders what this returns.
import type { ConductorWorker } from '../api'
import type { CriticalPath, FileConflict } from './analysis'
import { toChip, type BoardChip } from './board'
import { assignLanes, computeDepths, type PhaseSelection } from './layout'
import { compareText } from './model'
import type { PlanTask } from './model'

/** Node size and the gaps between them. The column gap is where edges bend. */
export const GRAPH = { W: 200, H: 64, COL_GAP: 72, ROW_GAP: 30, PAD: 20, HEAD_H: 36 } as const

export type GraphNode = BoardChip & { col: number; row: number; x: number; y: number; critical: boolean }

export type EdgeKind = 'critical' | 'done' | 'gate' | 'default'

export interface GraphEdge {
  id: string
  from: string
  to: string
  kind: EdgeKind
  /** The target is running: the edge carries flowing dashes. */
  animated: boolean
  d: string
}

export interface GraphShare {
  id: string
  from: string
  to: string
  file: string
  d: string
  labelX: number
  labelY: number
}

export interface GraphLayout {
  nodes: GraphNode[]
  edges: GraphEdge[]
  shares: GraphShare[]
  columns: { col: number; x: number; label: string }[]
  width: number
  height: number
  cyclic: Set<string>
}

export function basename(file: string): string {
  return file.split('/').filter(Boolean).pop() ?? file
}

const { W, H, COL_GAP, ROW_GAP, PAD, HEAD_H } = GRAPH
const colX = (col: number) => PAD + col * (W + COL_GAP)
const rowY = (row: number) => HEAD_H + row * (H + ROW_GAP)

function edgeKind(from: PlanTask, to: PlanTask, critical: CriticalPath): EdgeKind {
  if (critical.edges.has(`${from.id}>${to.id}`)) return 'critical'
  const gates = [from, to].filter((t) => t.kind === 'gate')
  if (gates.length > 0) return gates.every((g) => g.state === 'done') ? 'done' : 'gate'
  return from.state === 'done' ? 'done' : 'default'
}

/**
 * Left to right between columns; within a column (a cycle) a loop out of one right side into the other.
 * An edge that would pass under a node in a column between its ends runs through the gap beside the
 * source's row instead, so it never reads as going through that node.
 */
function depPath(a: GraphNode, b: GraphNode, blocked: boolean): string {
  if (a.col < b.col) {
    const x1 = a.x + W
    const y1 = a.y + H / 2
    const x2 = b.x
    const y2 = b.y + H / 2
    if (blocked) {
      const yc = rowY(b.row < a.row ? a.row - 1 : a.row) + H + ROW_GAP / 2
      const g = COL_GAP / 2
      return `M${x1} ${y1} C${x1 + g} ${y1} ${x1 + g} ${yc} ${x1 + COL_GAP} ${yc} L${x2 - COL_GAP} ${yc} C${x2 - g} ${yc} ${x2 - g} ${y2} ${x2} ${y2}`
    }
    const mx = (x1 + x2) / 2
    return `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`
  }
  if (a.col === b.col) {
    const x = a.x + W
    const bulge = 36 + 12 * Math.min(Math.abs(a.row - b.row), 4)
    const y1 = a.y + H / 2 - 8
    const y2 = b.y + H / 2 + 8
    return `M${x} ${y1} C${x + bulge} ${y1} ${x + bulge} ${y2} ${x} ${y2}`
  }
  const x1 = a.x
  const y1 = a.y + H / 2
  const x2 = b.x + W
  const y2 = b.y + H / 2
  return `M${x1} ${y1} C${x1 - 48} ${y1} ${x2 + 48} ${y2} ${x2} ${y2}`
}

/** Same-file pairs: a short vertical run between neighbours, an arc beside a column, a curve across columns. */
function sharePath(a: GraphNode, b: GraphNode): { d: string; labelX: number; labelY: number } {
  if (a.col === b.col && Math.abs(a.row - b.row) === 1) {
    const x = a.x + W / 2
    const [y1, y2] = a.row < b.row ? [a.y + H, b.y] : [a.y, b.y + H]
    return { d: `M${x} ${y1} L${x} ${y2}`, labelX: x + 8, labelY: (y1 + y2) / 2 + 4 }
  }
  if (a.col === b.col) {
    const x = a.x + W
    const y1 = a.y + H / 2
    const y2 = b.y + H / 2
    return { d: `M${x} ${y1} C${x + 56} ${y1} ${x + 56} ${y2} ${x} ${y2}`, labelX: x + 48, labelY: (y1 + y2) / 2 + 4 }
  }
  const [left, right] = a.col < b.col ? [a, b] : [b, a]
  // Offset below the mid-line so the share does not sit on top of a dependency edge.
  const x1 = left.x + W
  const y1 = left.y + H / 2 + 12
  const x2 = right.x
  const y2 = right.y + H / 2 + 12
  const mx = (x1 + x2) / 2
  const d = a === left
    ? `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`
    : `M${x2} ${y2} C${mx} ${y2} ${mx} ${y1} ${x1} ${y1}`
  return { d, labelX: mx + 6, labelY: (y1 + y2) / 2 - 4 }
}

/**
 * Columns by dependency depth (a phase: its inputs, its own steps, then what it unlocks). Rows in the
 * first column follow the machine lanes, then priority, then key; every later column orders its tasks
 * by the average row of their dependencies and sits each one level with that average where the rows
 * above leave room, which keeps the edges short, mostly straight and mostly uncrossed.
 */
export function layoutGraph(
  tasks: PlanTask[],
  workers: ConductorWorker[],
  opts: { phase?: PhaseSelection; critical: CriticalPath; conflicts: FileConflict[]; now: Date },
): GraphLayout {
  const { phase, critical, conflicts, now } = opts
  const nodes = tasks.filter((t) => t.kind !== 'group')
  const shown = phase
    ? nodes.filter((t) => phase.members.has(t.id) || phase.inputs.has(t.id) || phase.outputs.has(t.id))
    : nodes

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

  const { lanes, laneOf } = assignLanes(tasks, workers)
  const laneIndex = new Map(lanes.map((l, i) => [l.id, i]))
  const laneRank = (t: PlanTask) => laneIndex.get(laneOf.get(t.id) as string) ?? lanes.length
  const byColumn: PlanTask[][] = Array.from({ length: columnCount }, () => [])
  for (const t of shown) byColumn[colOf.get(t.id) as number]?.push(t)

  const rowOf = new Map<string, number>()
  const onPath = new Set(critical.ids)
  const placed: GraphNode[] = []
  byColumn.forEach((list, col) => {
    const centre = new Map<string, number>()
    for (const t of list) {
      const rows = t.deps.map((d) => rowOf.get(d)).filter((r): r is number => r !== undefined)
      if (rows.length > 0) centre.set(t.id, rows.reduce((a, b) => a + b, 0) / rows.length)
    }
    list.sort((a, b) => {
      const ca = centre.get(a.id)
      const cb = centre.get(b.id)
      if (ca !== undefined && cb !== undefined && ca !== cb) return ca - cb
      if ((ca === undefined) !== (cb === undefined)) return ca === undefined ? 1 : -1
      return laneRank(a) - laneRank(b) || a.priority - b.priority || compareText(a.key, b.key)
    })
    let next = 0
    for (const t of list) {
      const c = centre.get(t.id)
      const row = Math.max(next, c === undefined ? 0 : Math.round(c))
      next = row + 1
      rowOf.set(t.id, row)
      placed.push({
        ...toChip(t, ghostOf.get(t.id) ?? null, now),
        col,
        row,
        x: colX(col),
        y: rowY(row),
        critical: onPath.has(t.id),
      })
    }
  })

  const nodeOf = new Map(placed.map((n) => [n.id, n]))
  const occupied = new Set(placed.map((n) => `${n.col}:${n.row}`))
  /** Whether a node sits in a column strictly between a and b, within the rows the edge sweeps. */
  const inTheWay = (a: GraphNode, b: GraphNode) => {
    const lo = Math.min(a.row, b.row)
    const hi = Math.max(a.row, b.row)
    for (let col = a.col + 1; col < b.col; col++) {
      for (let row = lo; row <= hi; row++) if (occupied.has(`${col}:${row}`)) return true
    }
    return false
  }
  const taskOf = new Map(shown.map((t) => [t.id, t]))
  const edges: GraphEdge[] = []
  for (const to of placed) {
    const target = taskOf.get(to.id) as PlanTask
    for (const dep of target.deps) {
      const from = nodeOf.get(dep)
      const source = taskOf.get(dep)
      if (!from || !source) continue
      // In a phase view a ghost's own links to other ghosts stay out of the picture.
      if (from.ghost && to.ghost) continue
      edges.push({
        id: `dep:${dep}>${to.id}`,
        from: dep,
        to: to.id,
        kind: edgeKind(source, target, critical),
        animated: target.state === 'running',
        d: depPath(from, to, inTheWay(from, to)),
      })
    }
  }

  const shares: GraphShare[] = []
  for (const c of conflicts) {
    const a = nodeOf.get(c.from)
    const b = nodeOf.get(c.to)
    if (!a || !b) continue
    shares.push({ id: `file:${c.from}>${c.to}`, from: c.from, to: c.to, file: basename(c.file), ...sharePath(a, b) })
  }

  const columns = Array.from({ length: columnCount }, (_, col) => {
    let label = `Step ${col + 1}`
    if (phase) {
      if (hasInputs && col === 0) label = 'Inputs'
      else if (hasOutputs && col === columnCount - 1) label = 'Unlocks next'
      else label = `Step ${col - (hasInputs ? 1 : 0) + 1}`
    }
    return { col, x: colX(col), label }
  })

  const rows = Math.max(0, ...placed.map((n) => n.row + 1))
  // Room on the right for a loop or arc beside the last column.
  const width = columnCount > 0 ? colX(columnCount - 1) + W + PAD + 44 : PAD * 2
  const height = rows > 0 ? rowY(rows - 1) + H + PAD : HEAD_H + PAD
  return { nodes: placed, edges, shares, columns, width, height, cyclic }
}
