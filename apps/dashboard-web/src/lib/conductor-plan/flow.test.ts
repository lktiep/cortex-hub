import { describe, expect, it } from 'vitest'
import { criticalPath, fileConflicts } from './analysis'
import type { CriticalPath, FileConflict } from './analysis'
import { STATUS_COLOR, STATUS_LABEL, toFlow } from './flow'
import type { GateNodeData, TaskNodeData } from './flow'
import { computeDepths, layoutPlan, selectPhase } from './layout'
import { toPlanTasks } from './model'
import type { PlanTask } from './model'
import { row, worker } from './test-fixtures'

const root = row({ id: 'root', kind: 'group' })
const NOW = new Date('2026-10-16T12:00:00.000Z')
const NO_CRIT: CriticalPath = { ids: [], edges: new Set(), days: 0 }

function tasks(...specs: Array<Parameters<typeof row>[0]>): PlanTask[] {
  return toPlanTasks(root, [root, ...specs.map((s) => row({ parent_task_id: 'root', ...s }))])
}

const deps = (...ids: string[]) => JSON.stringify(ids)

function build(
  list: PlanTask[],
  opts: { crit?: CriticalPath; conflicts?: FileConflict[]; mode?: 'compact' | 'detail'; phaseGroup?: string } = {},
) {
  const mode = opts.mode ?? 'compact'
  const phase = opts.phaseGroup ? selectPhase(list, opts.phaseGroup) : undefined
  const layout = layoutPlan(list, [worker()], { mode, phase })
  const byId = new Map(list.map((t) => [t.id, t]))
  return toFlow(layout, byId, opts.crit ?? NO_CRIT, opts.conflicts ?? [], mode, NOW)
}

const edgeOf = (edges: ReturnType<typeof build>['edges'], from: string, to: string) => {
  const e = edges.find((x) => x.source === from && x.target === to && !x.id.startsWith('file:'))
  if (!e) throw new Error(`no edge ${from}>${to}`)
  return e
}

describe('toFlow', () => {
  it('emits one node per cell plus background lane and column nodes', () => {
    const list = tasks({ id: 'a' }, { id: 'b', depends_on: deps('a') }, { id: 'g', kind: 'gate', approver: 'user' })
    const { nodes } = build(list)
    const layout = layoutPlan(list, [worker()], { mode: 'compact' })
    const lanes = nodes.filter((n) => n.type === 'lane')
    const cols = nodes.filter((n) => n.type === 'col')
    expect(nodes.filter((n) => n.type === 'task' || n.type === 'gate')).toHaveLength(3)
    expect(lanes.map((n) => n.id)).toEqual(layout.lanes.map((l) => `lane:${l.id}`))
    expect(cols.map((n) => n.id)).toEqual(layout.columns.map((c) => `col:${c.col}`))
    for (const n of [...lanes, ...cols]) {
      expect(n.zIndex).toBe(-1)
      expect(n.draggable).toBe(false)
      expect(n.selectable).toBe(false)
    }
    expect(nodes.find((n) => n.id === 'g')?.type).toBe('gate')
    expect(nodes.find((n) => n.id === 'a')?.type).toBe('task')
  })

  it('a critical edge is red and 2.4 wide, even into a gate or from a done task', () => {
    const list = tasks(
      { id: 'a', status: 'completed' },
      { id: 'g', kind: 'gate', approver: 'user', depends_on: deps('a') },
      { id: 'b', depends_on: deps('g') },
    )
    const crit: CriticalPath = { ids: ['a', 'g', 'b'], edges: new Set(['a>g', 'g>b']), days: 3 }
    const { edges } = build(list, { crit })
    for (const [f, t] of [['a', 'g'], ['g', 'b']]) {
      const e = edgeOf(edges, f as string, t as string)
      expect(e.style?.stroke).toBe('#f87171')
      expect(e.style?.strokeWidth).toBe(2.4)
      expect((e.markerEnd as { color: string }).color).toBe('#f87171')
    }
  })

  it('an edge from a done task is green, and an edge into a running task is animated', () => {
    const list = tasks(
      { id: 'a', status: 'completed' },
      { id: 'b', depends_on: deps('a'), status: 'in_progress' },
      { id: 'c', depends_on: deps('b') },
    )
    const { edges } = build(list)
    const ab = edgeOf(edges, 'a', 'b')
    expect(ab.style?.stroke).toBe('rgba(52,211,153,.55)')
    expect(ab.style?.strokeWidth).toBe(1.2)
    expect(ab.animated).toBe(true)
    expect(ab.type).toBe('smoothstep')
    const bc = edgeOf(edges, 'b', 'c')
    expect(bc.style?.stroke).toBe('rgba(148,163,184,.55)')
    expect(bc.style?.strokeWidth).toBe(1.2)
    expect(bc.animated).toBe(false)
    expect((bc.markerEnd as { color: string }).color).toBe('rgba(148,163,184,.55)')
  })

  it('edges into or out of a gate are amber, and green once the gate is done', () => {
    const list = tasks(
      { id: 'a', status: 'completed' },
      { id: 'g', kind: 'gate', approver: 'user', depends_on: deps('a') },
      { id: 'b', depends_on: deps('g') },
      { id: 'g2', kind: 'gate', approver: 'lead', status: 'approved' },
      { id: 'c', depends_on: deps('g2') },
    )
    const { edges } = build(list)
    // a is done, but the open gate end outranks the done source
    const ag = edgeOf(edges, 'a', 'g')
    expect(ag.style?.stroke).toBe('#fbbf24')
    expect(ag.style?.strokeWidth).toBe(1)
    expect(edgeOf(edges, 'g', 'b').style?.stroke).toBe('#fbbf24')
    const g2c = edgeOf(edges, 'g2', 'c')
    expect(g2c.style?.stroke).toBe('rgba(52,211,153,.55)')
    expect(g2c.style?.strokeWidth).toBe(1)
  })

  it('same-file edges are dashed orange and labelled with the file basename only in detail mode', () => {
    const list = tasks({ id: 'a' }, { id: 'b' })
    const conflicts: FileConflict[] = [{ from: 'a', to: 'b', file: 'src/deep/shared.ts' }]
    const crit: CriticalPath = { ids: ['a', 'b'], edges: new Set(['a>b']), days: 2 }
    const compact = build(list, { conflicts, crit }).edges.find((e) => e.id === 'file:a>b')
    expect(compact?.type).toBe('straight')
    expect(compact?.label).toBeUndefined()
    expect(compact?.style).toMatchObject({ stroke: '#fb923c', strokeWidth: 1.4, strokeDasharray: '6 4' })
    expect((compact?.markerEnd as { color: string }).color).toBe('#fb923c')
    const detail = build(list, { conflicts, mode: 'detail' }).edges.find((e) => e.id === 'file:a>b')
    expect(detail?.label).toBe('shared.ts')
  })

  it('nodes carry critical, ghost, noFiles, note and route', () => {
    const list = tasks(
      { id: 'grp', kind: 'group' },
      { id: 'in', parent_task_id: 'other' },
      { id: 'a', parent_task_id: 'grp', depends_on: deps('in'), files: '[]' },
      { id: 'f', parent_task_id: 'grp', files: JSON.stringify(['x.ts']) },
      { id: 'd', parent_task_id: 'grp', status: 'completed', files: '[]' },
      { id: 'g', parent_task_id: 'grp', kind: 'gate', approver: 'user' },
      { id: 'out', depends_on: deps('a'), executor: 'claude', model: 'claude-opus-5-5' },
    )
    const crit: CriticalPath = { ids: ['a'], edges: new Set(), days: 1 }
    const { nodes } = build(list, { crit, mode: 'detail', phaseGroup: 'grp' })
    const data = (id: string) => nodes.find((n) => n.id === id)?.data as TaskNodeData
    expect(data('a')).toMatchObject({ critical: true, ghost: null, noFiles: true, selected: false })
    expect(data('f').noFiles).toBe(false)
    expect(data('d').noFiles).toBe(false)
    const gateData = nodes.find((n) => n.id === 'g')?.data as GateNodeData
    expect(gateData.task.kind).toBe('gate')
    expect('noFiles' in gateData).toBe(false)
    expect(data('in')).toMatchObject({ ghost: 'input', critical: false })
    expect(data('out')).toMatchObject({ ghost: 'output', route: 'claude·opus-5-5' })
    expect(data('a').note).toBeNull()
  })

  it('marks the selected node', () => {
    const list = tasks({ id: 'a' }, { id: 'b' })
    const layout = layoutPlan(list, [worker()], { mode: 'compact' })
    const out = toFlow(layout, new Map(list.map((t) => [t.id, t])), NO_CRIT, [], 'compact', NOW, 'b')
    expect((out.nodes.find((n) => n.id === 'b')?.data as TaskNodeData).selected).toBe(true)
    expect((out.nodes.find((n) => n.id === 'a')?.data as TaskNodeData).selected).toBe(false)
  })

  it('marks critical and selected on a gate node', () => {
    const list = tasks({ id: 'g', kind: 'gate', approver: 'lead' }, { id: 'b', depends_on: deps('g') })
    const layout = layoutPlan(list, [worker()], { mode: 'compact' })
    const crit: CriticalPath = { ids: ['g', 'b'], edges: new Set(['g>b']), days: 1 }
    const out = toFlow(layout, new Map(list.map((t) => [t.id, t])), crit, [], 'compact', NOW, 'g')
    expect(out.nodes.find((n) => n.id === 'g')?.data).toMatchObject({ critical: true, selected: true, blocks: 1 })
    expect(out.nodes.find((n) => n.id === 'b')?.data).toMatchObject({ critical: true, selected: false })
  })

  it('does not draw a dependency edge between an input ghost and an output ghost', () => {
    const list = tasks(
      { id: 'grp', kind: 'group' },
      { id: 'in', parent_task_id: 'other' },
      { id: 'm', parent_task_id: 'grp', depends_on: deps('in') },
      { id: 'out', depends_on: deps('m', 'in') },
    )
    const { nodes, edges } = build(list, { phaseGroup: 'grp', mode: 'detail' })
    expect(nodes.filter((n) => n.id === 'in' || n.id === 'out')).toHaveLength(2)
    expect(edges.map((e) => `${e.source}>${e.target}`).sort()).toEqual(['in>m', 'm>out'])
  })

  it('still draws a same-file edge between two laid-out ghosts', () => {
    const list = tasks(
      { id: 'grp', kind: 'group' },
      { id: 'in', parent_task_id: 'other' },
      { id: 'm', parent_task_id: 'grp', depends_on: deps('in') },
      { id: 'out', depends_on: deps('m') },
    )
    const conflicts: FileConflict[] = [{ from: 'in', to: 'out', file: 'a/b.ts' }]
    const { edges } = build(list, { phaseGroup: 'grp', mode: 'detail', conflicts })
    expect(edges.find((e) => e.id === 'file:in>out')?.label).toBe('b.ts')
  })

  it('an edge between two gates is green only when every gate end is done', () => {
    const half = tasks(
      { id: 'g1', kind: 'gate', approver: 'user', status: 'approved' },
      { id: 'g2', kind: 'gate', approver: 'lead', depends_on: deps('g1') },
    )
    expect(edgeOf(build(half).edges, 'g1', 'g2').style?.stroke).toBe('#fbbf24')
    const both = tasks(
      { id: 'g1', kind: 'gate', approver: 'user', status: 'approved' },
      { id: 'g2', kind: 'gate', approver: 'lead', status: 'approved', depends_on: deps('g1') },
    )
    expect(edgeOf(build(both).edges, 'g1', 'g2').style?.stroke).toBe('rgba(52,211,153,.55)')
  })

  it('drops edges whose ends are not both laid out, including a ghost\'s own deps', () => {
    const list = tasks(
      { id: 'grp', kind: 'group' },
      { id: 'up' },
      { id: 'in', parent_task_id: 'other', depends_on: deps('up') },
      { id: 'm', parent_task_id: 'grp', depends_on: deps('in') },
      { id: 'out', depends_on: deps('m') },
    )
    const { edges } = build(list, { phaseGroup: 'grp', mode: 'detail' })
    const pairs = edges.map((e) => `${e.source}>${e.target}`).sort()
    expect(pairs).toEqual(['in>m', 'm>out'])
  })

  it('renders a dependency cycle without throwing', () => {
    const list = tasks(
      { id: 'A', depends_on: deps('B') },
      { id: 'B', depends_on: deps('A') },
      { id: 'C', depends_on: deps('A') },
    )
    const { depth, cyclic } = computeDepths(list)
    expect([...cyclic].sort()).toEqual(['A', 'B'])
    const out = build(list, { crit: criticalPath(list, cyclic), conflicts: fileConflicts(list, depth) })
    expect(out.nodes.filter((n) => n.type === 'task').map((n) => n.id).sort()).toEqual(['A', 'B', 'C'])
    expect(out.edges.map((e) => e.id).sort()).toEqual(['dep:A>B', 'dep:A>C', 'dep:B>A'])
  })

  it('draws a same-file edge computed from analysis', () => {
    const list = tasks(
      { id: 'a', files: JSON.stringify(['f.ts']) },
      { id: 'b', files: JSON.stringify(['f.ts']) },
    )
    const { depth, cyclic } = computeDepths(list)
    const out = build(list, { crit: criticalPath(list, cyclic), conflicts: fileConflicts(list, depth) })
    expect(out.edges.filter((e) => e.id.startsWith('file:'))).toHaveLength(1)
  })
})

describe('status tables', () => {
  it('has a colour and an English label for every state', () => {
    expect(STATUS_COLOR.done).toBe('#34d399')
    expect(STATUS_COLOR.needs_user).toBe('#fbbf24')
    expect(STATUS_COLOR.stopped).toBe('#4b5563')
    expect(STATUS_LABEL).toEqual({
      done: 'done', review: 'in review', needs_user: 'needs you', gate_lead: 'awaiting lead',
      escalated: 'escalated', running: 'running', waiting: 'waiting', ready: 'ready',
      blocked: 'blocked', stopped: 'stopped',
    })
  })
})
