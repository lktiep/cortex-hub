import { describe, expect, it } from 'vitest'
import { criticalPath, fileConflicts } from './analysis'
import type { CriticalPath, FileConflict } from './analysis'
import { basename, GRAPH, layoutGraph } from './graph'
import { computeDepths, selectPhase } from './layout'
import { toPlanTasks } from './model'
import type { PlanTask } from './model'
import { generatePlan, row, worker } from './test-fixtures'

const root = row({ id: 'root', kind: 'group' })
const NOW = new Date('2026-10-16T12:00:00.000Z')
const NO_CRIT: CriticalPath = { ids: [], edges: new Set(), days: 0 }
const { W, H, COL_GAP, ROW_GAP, PAD, HEAD_H } = GRAPH

function tasks(...specs: Array<Parameters<typeof row>[0]>): PlanTask[] {
  return toPlanTasks(root, [root, ...specs.map((s) => row({ parent_task_id: 'root', ...s }))])
}

const deps = (...ids: string[]) => JSON.stringify(ids)

function build(
  list: PlanTask[],
  opts: { crit?: CriticalPath; conflicts?: FileConflict[]; phaseGroup?: string; workers?: ReturnType<typeof worker>[] } = {},
) {
  const phase = opts.phaseGroup ? selectPhase(list, opts.phaseGroup) : undefined
  return layoutGraph(list, opts.workers ?? [], {
    phase, critical: opts.crit ?? NO_CRIT, conflicts: opts.conflicts ?? [], now: NOW,
  })
}

const node = (out: ReturnType<typeof build>, id: string) => {
  const n = out.nodes.find((x) => x.id === id)
  if (!n) throw new Error(`no node ${id}`)
  return n
}

const edge = (out: ReturnType<typeof build>, from: string, to: string) => {
  const e = out.edges.find((x) => x.from === from && x.to === to)
  if (!e) throw new Error(`no edge ${from}>${to}`)
  return e
}

describe('layoutGraph geometry', () => {
  it('places columns by depth and rows from the top, with the specified sizes', () => {
    const out = build(tasks({ id: 'a', task_key: 'A' }, { id: 'b', task_key: 'B', depends_on: deps('a') }, { id: 'c', task_key: 'C' }))
    expect(node(out, 'a')).toMatchObject({ col: 0, row: 0, x: PAD, y: HEAD_H })
    expect(node(out, 'c')).toMatchObject({ col: 0, row: 1, x: PAD, y: HEAD_H + H + ROW_GAP })
    expect(node(out, 'b')).toMatchObject({ col: 1, row: 0, x: PAD + W + COL_GAP, y: HEAD_H })
    expect(out.columns).toEqual([
      { col: 0, x: PAD, label: 'Step 1' },
      { col: 1, x: PAD + W + COL_GAP, label: 'Step 2' },
    ])
    expect(out.width).toBe(PAD + W + COL_GAP + W + PAD + 44)
    expect(out.height).toBe(HEAD_H + 2 * H + ROW_GAP + PAD)
  })

  it('draws a dependency from the right middle of one node to the left middle of the next', () => {
    const out = build(tasks({ id: 'a' }, { id: 'b', depends_on: deps('a') }))
    const x1 = PAD + W
    const x2 = PAD + W + COL_GAP
    const y = HEAD_H + H / 2
    const mx = (x1 + x2) / 2
    expect(edge(out, 'a', 'b').d).toBe(`M${x1} ${y} C${mx} ${y} ${mx} ${y} ${x2} ${y}`)
  })

  it('orders the first column by machine lane, then priority, then key', () => {
    const ws = [worker({ agentId: 'w1', hostname: 'h1' })]
    const out = build(tasks(
      { id: 'p', task_key: 'Z', priority: 0 },
      { id: 'q', task_key: 'B', priority: 1 },
      { id: 'r', task_key: 'A', priority: 1 },
      { id: 'm', task_key: 'M', priority: 9, assigned_to_agent: 'w1' },
    ), { workers: ws })
    expect([...out.nodes].sort((a, b) => a.row - b.row).map((n) => n.id)).toEqual(['m', 'p', 'r', 'q'])
  })

  it('sits a later task near its dependencies, ahead of key order', () => {
    const out = build(tasks(
      { id: 'a', task_key: 'A' },
      { id: 'b', task_key: 'B' },
      { id: 'x', task_key: 'X', depends_on: deps('b') },
      { id: 'y', task_key: 'Z', depends_on: deps('a') },
    ))
    expect(node(out, 'y').row).toBe(0)
    expect(node(out, 'x').row).toBe(1)
  })

  it('puts a task with no placed dependency below the ones that have one', () => {
    const list = tasks(
      { id: 'g1', kind: 'group' },
      { id: 'in', task_key: 'IN' },
      { id: 'm1', task_key: 'M1', parent_task_id: 'g1', depends_on: deps('in') },
      { id: 'm0', task_key: 'A', parent_task_id: 'g1' },
    )
    const out = build(list, { phaseGroup: 'g1' })
    expect(node(out, 'm1')).toMatchObject({ col: 1, row: 0 })
    expect(node(out, 'm0')).toMatchObject({ col: 1, row: 1 })
  })

  it('keeps a lone dependent level with its dependency, and grows the height to fit', () => {
    const out = build(tasks(
      { id: 'a', task_key: 'A' },
      { id: 'b', task_key: 'B' },
      { id: 'c', task_key: 'C' },
      { id: 'd', task_key: 'D', depends_on: deps('c') },
    ))
    expect(node(out, 'd')).toMatchObject({ col: 1, row: 2, y: HEAD_H + 2 * (H + ROW_GAP) })
    expect(out.height).toBe(HEAD_H + 3 * H + 2 * ROW_GAP + PAD)
  })

  it('routes a long edge through the gap beside its source row instead of under a node in between', () => {
    const out = build(tasks(
      { id: 'a', task_key: 'A' },
      { id: 'b', task_key: 'B', depends_on: deps('a') },
      { id: 'c', task_key: 'C', depends_on: deps('a', 'b') },
    ))
    expect(node(out, 'b')).toMatchObject({ col: 1, row: 0 })
    expect(node(out, 'c')).toMatchObject({ col: 2, row: 0 })
    const x1 = PAD + W
    const x2 = PAD + 2 * (W + COL_GAP)
    const y = HEAD_H + H / 2
    const yc = HEAD_H + H + ROW_GAP / 2
    const g = COL_GAP / 2
    expect(edge(out, 'a', 'c').d).toBe(
      `M${x1} ${y} C${x1 + g} ${y} ${x1 + g} ${yc} ${x1 + COL_GAP} ${yc} L${x2 - COL_GAP} ${yc} C${x2 - g} ${yc} ${x2 - g} ${y} ${x2} ${y}`,
    )
  })

  it('keeps a long edge one curve when nothing sits in its way', () => {
    const out = build(tasks(
      { id: 'p', task_key: 'P' },
      { id: 'q', task_key: 'Q' },
      { id: 'r', task_key: 'R', depends_on: deps('p') },
      { id: 's', task_key: 'S', depends_on: deps('r') },
      { id: 't', task_key: 'T', depends_on: deps('s', 'q') },
    ))
    expect(node(out, 't')).toMatchObject({ col: 3, row: 1 })
    const x1 = PAD + W
    const x2 = PAD + 3 * (W + COL_GAP)
    const y = HEAD_H + H + ROW_GAP + H / 2
    const mx = (x1 + x2) / 2
    expect(edge(out, 'q', 't').d).toBe(`M${x1} ${y} C${mx} ${y} ${mx} ${y} ${x2} ${y}`)
  })

  it('never overlaps two nodes on a large plan', () => {
    const ws = [worker({ agentId: 'w1', hostname: 'h1' }), worker({ agentId: 'w2', hostname: 'h2' })]
    const ts = toPlanTasks(root, generatePlan(150))
    const withAgents = ts.map((t, i) => (i % 3 === 0 ? { ...t, agent: 'w1' } : i % 3 === 1 ? { ...t, agent: 'w2' } : t))
    const out = layoutGraph(withAgents, ws, { critical: NO_CRIT, conflicts: [], now: NOW })
    expect(out.nodes.length).toBe(withAgents.filter((t) => t.kind !== 'group').length)
    const seen = new Set(out.nodes.map((n) => `${n.x},${n.y}`))
    expect(seen.size).toBe(out.nodes.length)
    for (const n of out.nodes) {
      expect(n.x + W).toBeLessThanOrEqual(out.width)
      expect(n.y + H).toBeLessThanOrEqual(out.height)
    }
  })
})

describe('layoutGraph cycles and phases', () => {
  it('lays out an A<->B cycle with loops, and its dependent one column on', () => {
    const list = tasks({ id: 'A', depends_on: deps('B') }, { id: 'B', depends_on: deps('A') }, { id: 'C', depends_on: deps('A') })
    const { depth, cyclic } = computeDepths(list)
    const out = build(list, { crit: criticalPath(list, cyclic), conflicts: fileConflicts(list, depth) })
    expect([...out.cyclic].sort()).toEqual(['A', 'B'])
    expect(out.nodes.map((n) => n.id).sort()).toEqual(['A', 'B', 'C'])
    expect(node(out, 'C').col).toBe(1)
    expect(out.edges.map((e) => e.id).sort()).toEqual(['dep:A>B', 'dep:A>C', 'dep:B>A'])
    // Within one column the edge leaves and enters on the right side.
    expect(edge(out, 'A', 'B').d.startsWith(`M${PAD + W} `)).toBe(true)
    expect(edge(out, 'A', 'B').d.endsWith(` ${PAD + W} ${node(out, 'B').y + H / 2 + 8}`)).toBe(true)
  })

  it('puts inputs in column 0 and outputs in the last column', () => {
    const list = tasks(
      { id: 'g1', kind: 'group' },
      { id: 'in' },
      { id: 'm1', parent_task_id: 'g1', depends_on: deps('in') },
      { id: 'm2', parent_task_id: 'g1', depends_on: deps('m1') },
      { id: 'out', depends_on: deps('m2') },
      { id: 'far' },
    )
    const out = build(list, { phaseGroup: 'g1' })
    expect(node(out, 'in')).toMatchObject({ col: 0, ghost: 'input' })
    expect(node(out, 'm1')).toMatchObject({ col: 1, ghost: null })
    expect(node(out, 'm2')).toMatchObject({ col: 2, ghost: null })
    expect(node(out, 'out')).toMatchObject({ col: 3, ghost: 'output' })
    expect(out.nodes.find((n) => n.id === 'far')).toBeUndefined()
    expect(out.columns.map((c) => c.label)).toEqual(['Inputs', 'Step 1', 'Step 2', 'Unlocks next'])
  })

  it('puts inputs in column 0 and outputs in column 1 for a phase with no members', () => {
    const list = tasks({ id: 'g1', kind: 'group' }, { id: 'in' }, { id: 'out' })
    const phase = { groupId: 'g1', members: new Set<string>(), inputs: new Set(['in']), outputs: new Set(['out']) }
    const out = layoutGraph(list, [], { phase, critical: NO_CRIT, conflicts: [], now: NOW })
    expect(node(out, 'in')).toMatchObject({ col: 0, ghost: 'input' })
    expect(node(out, 'out')).toMatchObject({ col: 1, ghost: 'output' })
    expect(out.columns.map((c) => c.label)).toEqual(['Inputs', 'Unlocks next'])
  })

  it('starts members at column 0 when a phase has no inputs', () => {
    const list = tasks({ id: 'g1', kind: 'group' }, { id: 'm1', parent_task_id: 'g1' }, { id: 'out', depends_on: deps('m1') })
    const out = build(list, { phaseGroup: 'g1' })
    expect(node(out, 'm1').col).toBe(0)
    expect(out.columns.map((c) => c.label)).toEqual(['Step 1', 'Unlocks next'])
  })

  it('draws nothing for an empty plan', () => {
    const out = build(tasks())
    expect(out).toMatchObject({ nodes: [], edges: [], shares: [], columns: [], width: PAD * 2, height: HEAD_H + PAD })
  })
})

describe('layoutGraph edges', () => {
  it('a critical edge wins, even into a gate or from a done task', () => {
    const list = tasks(
      { id: 'a', status: 'completed' },
      { id: 'g', kind: 'gate', approver: 'user', depends_on: deps('a') },
      { id: 'b', depends_on: deps('g') },
    )
    const crit: CriticalPath = { ids: ['a', 'g', 'b'], edges: new Set(['a>g', 'g>b']), days: 3 }
    const out = build(list, { crit })
    expect(edge(out, 'a', 'g').kind).toBe('critical')
    expect(edge(out, 'g', 'b').kind).toBe('critical')
    expect(out.nodes.every((n) => n.critical)).toBe(true)
  })

  it('an edge from a done task is done, and an edge into a running task is animated', () => {
    const out = build(tasks(
      { id: 'a', status: 'completed' },
      { id: 'b', depends_on: deps('a'), status: 'in_progress' },
      { id: 'c', depends_on: deps('b') },
    ))
    expect(edge(out, 'a', 'b')).toMatchObject({ kind: 'done', animated: true })
    expect(edge(out, 'b', 'c')).toMatchObject({ kind: 'default', animated: false })
  })

  it('edges into or out of an open gate are gate edges, and done once every gate end is done', () => {
    const out = build(tasks(
      { id: 'a', status: 'completed' },
      { id: 'g', kind: 'gate', approver: 'user', depends_on: deps('a') },
      { id: 'b', depends_on: deps('g') },
      { id: 'g2', kind: 'gate', approver: 'lead', status: 'approved' },
      { id: 'c', depends_on: deps('g2') },
      { id: 'g3', kind: 'gate', approver: 'lead', depends_on: deps('g2') },
    ))
    expect(edge(out, 'a', 'g').kind).toBe('gate')
    expect(edge(out, 'g', 'b').kind).toBe('gate')
    expect(edge(out, 'g2', 'c').kind).toBe('done')
    expect(edge(out, 'g2', 'g3').kind).toBe('gate')
  })

  it('drops an edge between two ghosts and edges whose ends are not shown', () => {
    const list = tasks(
      { id: 'grp', kind: 'group' },
      { id: 'up' },
      { id: 'in', parent_task_id: 'other', depends_on: deps('up') },
      { id: 'm', parent_task_id: 'grp', depends_on: deps('in') },
      { id: 'out', depends_on: deps('m', 'in') },
    )
    const out = build(list, { phaseGroup: 'grp' })
    expect(out.edges.map((e) => e.id).sort()).toEqual(['dep:in>m', 'dep:m>out'])
  })
})

describe('layoutGraph shared files', () => {
  it('runs vertically between neighbours in one column, either way round, labelled with the basename', () => {
    const list = tasks({ id: 'a', task_key: 'A' }, { id: 'b', task_key: 'B' })
    const x = PAD + W / 2
    const down = build(list, { conflicts: [{ from: 'a', to: 'b', file: 'src/deep/shared.ts' }] })
    expect(down.shares[0]).toMatchObject({ id: 'file:a>b', file: 'shared.ts', d: `M${x} ${HEAD_H + H} L${x} ${HEAD_H + H + ROW_GAP}` })
    const up = build(list, { conflicts: [{ from: 'b', to: 'a', file: 'x.ts' }] })
    expect(up.shares[0]?.d).toBe(`M${x} ${HEAD_H + H + ROW_GAP} L${x} ${HEAD_H + H}`)
  })

  it('arcs beside the column when the two are not neighbours', () => {
    const list = tasks({ id: 'a', task_key: 'A' }, { id: 'b', task_key: 'B' }, { id: 'c', task_key: 'C' })
    const out = build(list, { conflicts: [{ from: 'a', to: 'c', file: 'x.ts' }] })
    expect(out.shares[0]?.d.startsWith(`M${PAD + W} ${HEAD_H + H / 2} C${PAD + W + 56} `)).toBe(true)
  })

  it('curves across columns from the earlier task to the later one', () => {
    const list = tasks({ id: 'a' }, { id: 'c', depends_on: deps('a') }, { id: 'b', depends_on: deps('c') })
    const out = build(list, { conflicts: [{ from: 'b', to: 'a', file: 'x.ts' }] })
    const d = out.shares[0]?.d ?? ''
    // From b (column 2, left side) back to a (column 0, right side).
    expect(d.startsWith(`M${PAD + 2 * (W + COL_GAP)} `)).toBe(true)
    expect(d.endsWith(` ${PAD + W} ${HEAD_H + H / 2 + 12}`)).toBe(true)
  })

  it('still draws a shared file between two ghosts', () => {
    const list = tasks(
      { id: 'grp', kind: 'group' },
      { id: 'in', parent_task_id: 'other' },
      { id: 'm', parent_task_id: 'grp', depends_on: deps('in') },
      { id: 'out', depends_on: deps('m') },
    )
    const out = build(list, { phaseGroup: 'grp', conflicts: [{ from: 'in', to: 'out', file: 'a/b.ts' }] })
    expect(out.shares.map((s) => s.file)).toEqual(['b.ts'])
  })

  it('finds a shared file from analysis', () => {
    const list = tasks({ id: 'a', files: JSON.stringify(['f.ts']) }, { id: 'b', files: JSON.stringify(['f.ts']) })
    const { depth, cyclic } = computeDepths(list)
    const out = build(list, { crit: criticalPath(list, cyclic), conflicts: fileConflicts(list, depth) })
    expect(out.shares).toHaveLength(1)
  })

  it('basename keeps the last path segment', () => {
    expect(basename('api/billing/')).toBe('billing')
    expect(basename('x.ts')).toBe('x.ts')
  })
})

describe('layoutGraph nodes', () => {
  it('carry ghost, critical, route and note like the board chips', () => {
    const list = tasks(
      { id: 'grp', kind: 'group' },
      { id: 'in', parent_task_id: 'other' },
      { id: 'a', parent_task_id: 'grp', depends_on: deps('in') },
      { id: 'g', parent_task_id: 'grp', kind: 'gate', approver: 'user' },
      { id: 'out', depends_on: deps('a'), executor: 'claude', model: 'claude-opus-5-5' },
    )
    const crit: CriticalPath = { ids: ['a'], edges: new Set(), days: 1 }
    const out = build(list, { crit, phaseGroup: 'grp' })
    expect(node(out, 'a')).toMatchObject({ critical: true, ghost: null, note: null, kind: 'work' })
    expect(node(out, 'in')).toMatchObject({ ghost: 'input', critical: false })
    expect(node(out, 'out')).toMatchObject({ ghost: 'output', route: 'claude·opus-5-5' })
    expect(node(out, 'g')).toMatchObject({ kind: 'gate', route: 'gate · approver user', attention: true })
  })
})
