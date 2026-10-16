import { describe, expect, it } from 'vitest'
import { assignLanes, computeDepths, layoutPlan, SIZES, selectPhase } from './layout'
import { toPlanTasks } from './model'
import type { PlanTask } from './model'
import { generatePlan, row, worker } from './test-fixtures'

const root = row({ id: 'root', kind: 'group' })

/** Plan tasks from compact specs; every row sits directly under the root unless it names a parent. */
function tasks(...specs: Array<Parameters<typeof row>[0]>): PlanTask[] {
  return toPlanTasks(root, [root, ...specs.map((s) => row({ parent_task_id: 'root', ...s }))])
}

function deps(...ids: string[]): string {
  return JSON.stringify(ids)
}

describe('computeDepths', () => {
  it('gives a chain 0,1,2 and a diamond\'s join the longest path', () => {
    const chain = computeDepths(tasks(
      { id: 'a' }, { id: 'b', depends_on: deps('a') }, { id: 'c', depends_on: deps('b') },
    ))
    expect([chain.depth.get('a'), chain.depth.get('b'), chain.depth.get('c')]).toEqual([0, 1, 2])
    const diamond = computeDepths(tasks(
      { id: 'a' }, { id: 'b', depends_on: deps('a') }, { id: 'c', depends_on: deps('b') },
      { id: 'd', depends_on: deps('a') }, { id: 'j', depends_on: deps('c', 'd') },
    ))
    expect(diamond.depth.get('j')).toBe(3)
    expect(diamond.cyclic.size).toBe(0)
  })

  it('terminates on a cycle and reports its members', () => {
    const { depth, cyclic } = computeDepths(tasks(
      { id: 'A', depends_on: deps('B') }, { id: 'B', depends_on: deps('A') }, { id: 'C', depends_on: deps('A') },
    ))
    for (const d of depth.values()) expect(Number.isInteger(d)).toBe(true)
    expect([...cyclic].sort()).toEqual(['A', 'B'])
    expect(depth.get('C') as number).toBeGreaterThan(depth.get('A') as number)
  })

  it('places a cycle after its non-cyclic deps', () => {
    const { depth } = computeDepths(tasks(
      { id: 'x' }, { id: 'y', depends_on: deps('x') },
      { id: 'A', depends_on: deps('B', 'y') }, { id: 'B', depends_on: deps('A') },
    ))
    expect(depth.get('A') as number).toBeGreaterThan(depth.get('y') as number)
  })
})

describe('assignLanes', () => {
  it('groups workers by hostname', () => {
    const ws = [worker({ agentId: 'w1', hostname: 'mac-1', os: 'darwin' }), worker({ agentId: 'w2', hostname: 'mac-1' })]
    const { lanes, laneOf } = assignLanes(tasks({ id: 'a', assigned_to_agent: 'w1' }, { id: 'b', assigned_to_agent: 'w2' }), ws)
    expect(lanes).toHaveLength(1)
    expect(lanes[0]).toMatchObject({ id: 'mac-1', label: 'mac-1', online: true, agentIds: ['w1', 'w2'] })
    expect(lanes[0]?.sub).toBe('darwin · w1, w2')
    expect(laneOf.get('a')).toBe('mac-1')
    expect(laneOf.get('b')).toBe('mac-1')
  })

  it('uses last_agent when nothing is assigned', () => {
    const { laneOf } = assignLanes(tasks({ id: 'a', last_agent: 'w1' }), [worker({ agentId: 'w1', hostname: 'h' })])
    expect(laneOf.get('a')).toBe('h')
  })

  it('falls back to the agent id when a worker has no hostname', () => {
    const { lanes } = assignLanes(tasks({ id: 'a', assigned_to_agent: 'w9' }), [worker({ agentId: 'w9' })])
    expect(lanes[0]).toMatchObject({ id: 'w9', label: 'w9', online: true })
  })

  it('gives a task held by an agent that is not online its own lane marked offline', () => {
    const { lanes, laneOf } = assignLanes(tasks({ id: 'a', assigned_to_agent: 'gone' }), [worker({ agentId: 'w1', hostname: 'h' })])
    expect(lanes).toHaveLength(1)
    expect(lanes[0]).toMatchObject({ id: 'gone', online: false, sub: 'offline' })
    expect(laneOf.get('a')).toBe('gone')
  })

  it('puts unassigned tasks in the queue lane, which is last', () => {
    const ws = [worker({ agentId: 'w1', hostname: 'zeta' }), worker({ agentId: 'w2', hostname: 'alpha' }), worker({ agentId: 'idle', hostname: 'unused' })]
    const { lanes } = assignLanes(tasks(
      { id: 'q' }, { id: 'off', assigned_to_agent: 'gone' },
      { id: 'z', assigned_to_agent: 'w1' }, { id: 'a', assigned_to_agent: 'w2' },
    ), ws)
    expect(lanes.map((l) => l.id)).toEqual(['alpha', 'zeta', 'gone', 'queue'])
    expect(lanes.map((l) => l.online)).toEqual([true, true, false, true])
  })

  it('sits a gate in the lane of its first dependent, else in the queue', () => {
    const ws = [worker({ agentId: 'w1', hostname: 'h1' }), worker({ agentId: 'w2', hostname: 'h2' })]
    const { laneOf } = assignLanes(tasks(
      { id: 'g', kind: 'gate', approver: 'lead', task_key: 'G' },
      { id: 'b', task_key: 'B', depends_on: deps('g'), assigned_to_agent: 'w2' },
      { id: 'a', task_key: 'A', depends_on: deps('g'), assigned_to_agent: 'w1' },
      { id: 'lonely', kind: 'gate', approver: 'user' },
    ), ws)
    expect(laneOf.get('g')).toBe('h1')
    expect(laneOf.get('lonely')).toBe('queue')
  })

  it('never makes cells of groups or the root', () => {
    const ts = toPlanTasks(root, [root, row({ id: 'grp', kind: 'group', parent_task_id: 'root' }), row({ id: 'a', parent_task_id: 'grp' })])
    const { laneOf } = assignLanes(ts, [])
    expect([...laneOf.keys()]).toEqual(['a'])
    const layout = layoutPlan(ts, [], { mode: 'compact' })
    expect(layout.cells.map((c) => c.id)).toEqual(['a'])
  })
})

describe('selectPhase', () => {
  const ts = tasks(
    { id: 'g1', kind: 'group' },
    { id: 'in', task_key: 'in' },
    { id: 'm1', parent_task_id: 'g1', depends_on: deps('in') },
    { id: 'm2', parent_task_id: 'g1', depends_on: deps('m1') },
    { id: 'out', depends_on: deps('m2') },
    { id: 'far' },
  )

  it('returns members, input ghosts and output ghosts', () => {
    const p = selectPhase(ts, 'g1')
    expect([...p.members].sort()).toEqual(['m1', 'm2'])
    expect([...p.inputs]).toEqual(['in'])
    expect([...p.outputs]).toEqual(['out'])
    for (const id of [...p.inputs, ...p.outputs]) expect(p.members.has(id)).toBe(false)
  })

  it('does not count a task as both an input and an output', () => {
    const both = tasks(
      { id: 'g1', kind: 'group' },
      { id: 'x', depends_on: deps('m2') },
      { id: 'm1', parent_task_id: 'g1', depends_on: deps('x') },
      { id: 'm2', parent_task_id: 'g1' },
    )
    const p = selectPhase(both, 'g1')
    expect(p.inputs.has('x')).toBe(true)
    expect(p.outputs.has('x')).toBe(false)
  })
})

describe('layoutPlan', () => {
  it('lays a legacy tree with no deps out in one column', () => {
    const legacy = tasks(...[1, 2, 3, 4, 5].map((i) => ({ id: `l${i}` })))
    const out = layoutPlan(legacy, [], { mode: 'compact' })
    expect(out.cells).toHaveLength(5)
    expect(out.cells.every((c) => c.col === 0)).toBe(true)
    expect(out.lanes.map((l) => l.id)).toEqual(['queue'])
    expect(out.columns.map((c) => c.label)).toEqual(['Step 1'])
  })

  it('uses the specified geometry', () => {
    const ts = tasks({ id: 'a', task_key: 'A' }, { id: 'b', task_key: 'B', depends_on: deps('a') }, { id: 'c', task_key: 'C' })
    const s = SIZES.compact
    const out = layoutPlan(ts, [], { mode: 'compact' })
    const cell = (id: string) => out.cells.find((c) => c.id === id)
    expect(cell('a')).toMatchObject({ col: 0, x: s.LABEL_W, y: SIZES.HEAD_H + 12, w: s.W, h: s.H })
    expect(cell('c')).toMatchObject({ col: 0, y: SIZES.HEAD_H + 12 + s.ROW_H })
    expect(cell('b')).toMatchObject({ col: 1, x: s.LABEL_W + s.COL_W, y: SIZES.HEAD_H + 12 })
    expect(out.lanes[0]).toMatchObject({ y: SIZES.HEAD_H, height: 2 * s.ROW_H + 24 })
    expect(out.width).toBe(s.LABEL_W + 2 * s.COL_W)
    expect(out.height).toBe(SIZES.HEAD_H + 2 * s.ROW_H + 24)
    expect(out.columns).toEqual([
      { col: 0, x: s.LABEL_W, label: 'Step 1' },
      { col: 1, x: s.LABEL_W + s.COL_W, label: 'Step 2' },
    ])
  })

  it('orders cells in a column by priority, then key', () => {
    const ts = tasks({ id: 'p', task_key: 'Z', priority: 0 }, { id: 'q', task_key: 'B', priority: 1 }, { id: 'r', task_key: 'A', priority: 1 })
    const out = layoutPlan(ts, [], { mode: 'compact' })
    expect([...out.cells].sort((a, b) => a.y - b.y).map((c) => c.id)).toEqual(['p', 'r', 'q'])
  })

  it('stacks lanes below each other', () => {
    const ws = [worker({ agentId: 'w1', hostname: 'h1' })]
    const ts = tasks({ id: 'a', assigned_to_agent: 'w1' }, { id: 'b' }, { id: 'c' })
    const out = layoutPlan(ts, ws, { mode: 'compact' })
    const [first, second] = out.lanes
    expect(first?.y).toBe(SIZES.HEAD_H)
    expect(second?.y).toBe(SIZES.HEAD_H + (first?.height ?? 0))
    expect(out.cells.find((c) => c.id === 'b')?.y).toBe((second?.y ?? 0) + 12)
  })

  it('puts inputs in column 0 and outputs in the last column in phase mode', () => {
    const ts = tasks(
      { id: 'g1', kind: 'group' },
      { id: 'in' },
      { id: 'm1', parent_task_id: 'g1', depends_on: deps('in') },
      { id: 'm2', parent_task_id: 'g1', depends_on: deps('m1') },
      { id: 'out', depends_on: deps('m2') },
      { id: 'far' },
    )
    const phase = selectPhase(ts, 'g1')
    const out = layoutPlan(ts, [], { mode: 'compact', phase })
    const col = (id: string) => out.cells.find((c) => c.id === id)
    expect(col('in')).toMatchObject({ col: 0, ghost: 'input' })
    expect(col('m1')).toMatchObject({ col: 1, ghost: null })
    expect(col('m2')).toMatchObject({ col: 2, ghost: null })
    expect(col('out')).toMatchObject({ col: 3, ghost: 'output' })
    expect(col('far')).toBeUndefined()
    expect(out.columns.map((c) => c.label)).toEqual(['Inputs', 'Step 1', 'Step 2', 'Unlocks next'])
    expect(col('m1')).toMatchObject({ w: SIZES.detail.W, h: SIZES.detail.H })
    expect(out.width).toBe(SIZES.detail.LABEL_W + 4 * SIZES.detail.COL_W)
  })

  it('starts members at column 0 when a phase has no inputs', () => {
    const ts = tasks({ id: 'g1', kind: 'group' }, { id: 'm1', parent_task_id: 'g1' }, { id: 'out', depends_on: deps('m1') })
    const out = layoutPlan(ts, [], { mode: 'detail', phase: selectPhase(ts, 'g1') })
    expect(out.cells.find((c) => c.id === 'm1')?.col).toBe(0)
    expect(out.columns.map((c) => c.label)).toEqual(['Step 1', 'Unlocks next'])
  })

  it('never overlaps two cells and sizes lanes by their fullest column', () => {
    const ts = toPlanTasks(root, generatePlan(150))
    const ws = [worker({ agentId: 'w1', hostname: 'h1' }), worker({ agentId: 'w2', hostname: 'h2' })]
    const withAgents = ts.map((t, i) => (i % 3 === 0 ? { ...t, agent: 'w1' } : i % 3 === 1 ? { ...t, agent: 'w2' } : t))
    const out = layoutPlan(withAgents, ws, { mode: 'compact' })
    expect(out.cells.length).toBe(withAgents.filter((t) => t.kind !== 'group').length)
    for (let i = 0; i < out.cells.length; i++) {
      for (let j = i + 1; j < out.cells.length; j++) {
        const a = out.cells[i]
        const b = out.cells[j]
        if (!a || !b) continue
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y
        expect(apart).toBe(true)
      }
    }
    let total = SIZES.HEAD_H
    for (const lane of out.lanes) {
      const perCol = new Map<number, number>()
      for (const c of out.cells) if (c.laneId === lane.id) perCol.set(c.col, (perCol.get(c.col) ?? 0) + 1)
      expect(lane.height).toBe(Math.max(...perCol.values()) * SIZES.compact.ROW_H + 24)
      expect(lane.y).toBe(total)
      total += lane.height
    }
    expect(out.height).toBe(total)
  })
})
