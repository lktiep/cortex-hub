// Plan flow: turns a PlanLayout into React Flow nodes and edges (colours, widths, labels).
// Pure module — only types and plain values from @xyflow/react; no React, no DOM.
import { MarkerType, type Edge, type Node } from '@xyflow/react'
import type { CriticalPath, FileConflict } from './analysis'
import type { Lane, PlanLayout } from './layout'
import { nodeNote, routeLabel, type PlanTask } from './model'

export const EDGE_CRITICAL = '#f87171'
export const EDGE_GATE = '#fbbf24'
export const EDGE_DONE = 'rgba(52,211,153,.55)'
export const EDGE_DEFAULT = 'rgba(148,163,184,.55)'
export const EDGE_FILE = '#fb923c'

type Mode = 'compact' | 'detail'

// React Flow 12 requires node data to be a Record, hence the index signatures.
export type TaskNodeData = {
  task: PlanTask
  mode: Mode
  critical: boolean
  ghost: 'input' | 'output' | null
  note: string | null
  route: string | null
  noFiles: boolean
  selected: boolean
  [key: string]: unknown
}

export type GateNodeData = {
  task: PlanTask
  mode: Mode
  critical: boolean
  ghost: 'input' | 'output' | null
  /** Number of tasks that depend on this gate. */
  blocks: number
  selected: boolean
  [key: string]: unknown
}

export type LaneNodeData = {
  lane: Lane
  width: number
  height: number
  index: number
  [key: string]: unknown
}

export type ColNodeData = {
  label: string
  [key: string]: unknown
}

const arrow = (color: string) => ({ type: MarkerType.ArrowClosed, width: 10, height: 10, color })

export function basename(file: string): string {
  return file.split('/').filter(Boolean).pop() ?? file
}

export function toFlow(
  layout: PlanLayout,
  byId: Map<string, PlanTask>,
  critical: CriticalPath,
  conflicts: FileConflict[],
  mode: Mode,
  now: Date,
  selectedId?: string,
): { nodes: Node[]; edges: Edge[] } {
  const onPath = new Set(critical.ids)
  const blocks = new Map<string, number>()
  for (const t of byId.values()) for (const d of t.deps) blocks.set(d, (blocks.get(d) ?? 0) + 1)

  const nodes: Node[] = []
  layout.lanes.forEach((lane, index) => {
    nodes.push({
      id: `lane:${lane.id}`,
      type: 'lane',
      position: { x: 0, y: lane.y },
      draggable: false,
      selectable: false,
      zIndex: -1,
      data: { lane, width: layout.width, height: lane.height, index } satisfies LaneNodeData,
    })
  })
  for (const c of layout.columns) {
    nodes.push({
      id: `col:${c.col}`,
      type: 'col',
      position: { x: c.x, y: 4 },
      draggable: false,
      selectable: false,
      zIndex: -1,
      data: { label: c.label } satisfies ColNodeData,
    })
  }

  const cellById = new Map(layout.cells.map((c) => [c.id, c]))
  for (const cell of layout.cells) {
    const task = byId.get(cell.id)
    if (!task) continue
    const selected = cell.id === selectedId
    const position = { x: cell.x, y: cell.y }
    if (task.kind === 'gate') {
      const data: GateNodeData = {
        task, mode, critical: onPath.has(task.id), ghost: cell.ghost, blocks: blocks.get(task.id) ?? 0, selected,
      }
      nodes.push({ id: task.id, type: 'gate', position, data, style: { width: cell.w }, selected })
    } else {
      const data: TaskNodeData = {
        task,
        mode,
        critical: onPath.has(task.id),
        ghost: cell.ghost,
        note: nodeNote(task, now),
        route: routeLabel(task.route ?? task.primary),
        noFiles: task.files.length === 0 && task.state !== 'done',
        selected,
      }
      nodes.push({ id: task.id, type: 'task', position, data, style: { width: cell.w, height: cell.h }, selected })
    }
  }

  const edges: Edge[] = []
  for (const cell of layout.cells) {
    const to = byId.get(cell.id)
    if (!to) continue
    for (const dep of to.deps) {
      const fromCell = cellById.get(dep)
      const from = byId.get(dep)
      if (!fromCell || !from) continue
      // In a phase view a ghost's own links to other ghosts stay out of the picture.
      if (fromCell.ghost && cell.ghost) continue
      const gates = [from, to].filter((t) => t.kind === 'gate')
      let color: string
      let width: number
      if (critical.edges.has(`${dep}>${to.id}`)) {
        color = EDGE_CRITICAL
        width = 2.4
      } else if (gates.length > 0) {
        color = gates.every((g) => g.state === 'done') ? EDGE_DONE : EDGE_GATE
        width = 1
      } else {
        color = from.state === 'done' ? EDGE_DONE : EDGE_DEFAULT
        width = 1.2
      }
      edges.push({
        id: `dep:${dep}>${to.id}`,
        source: dep,
        target: to.id,
        type: 'smoothstep',
        animated: to.state === 'running',
        style: { stroke: color, strokeWidth: width },
        markerEnd: arrow(color),
      })
    }
  }

  for (const c of conflicts) {
    if (!cellById.has(c.from) || !cellById.has(c.to)) continue
    edges.push({
      id: `file:${c.from}>${c.to}`,
      source: c.from,
      target: c.to,
      type: 'straight',
      label: mode === 'detail' ? basename(c.file) : undefined,
      labelStyle: { fill: EDGE_FILE, fontSize: 10 },
      labelBgStyle: { fill: '#0f1117' },
      style: { stroke: EDGE_FILE, strokeWidth: 1.4, strokeDasharray: '6 4' },
      markerEnd: arrow(EDGE_FILE),
    })
  }

  return { nodes, edges }
}
