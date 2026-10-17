import { describe, expect, it } from 'vitest'
import { assignLanes, computeDepths, selectPhase } from './layout'
import { toPlanTasks } from './model'
import type { PlanTask } from './model'
import { row, worker } from './test-fixtures'

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

describe('computeDepths on cycles', () => {
  it('survives a 5,000-task ring and reports every member as cyclic', () => {
    const n = 5000
    const ring = tasks(...Array.from({ length: n }, (_, i) => ({ id: `r${i}`, depends_on: deps(`r${(i + 1) % n}`) })))
    const out = computeDepths(ring)
    expect(out.cyclic.size).toBe(n)
    expect(out.depth.size).toBe(n)
  })
})

describe('assignLanes', () => {
  it('groups workers by hostname', () => {
    const ws = [worker({ agentId: 'w1', hostname: 'mac-1', os: 'darwin' }), worker({ agentId: 'w2', hostname: 'mac-1' })]
    const { lanes, laneOf } = assignLanes(tasks({ id: 'a', assigned_to_agent: 'w1' }, { id: 'b', assigned_to_agent: 'w2' }), ws)
    expect(lanes).toHaveLength(1)
    expect(lanes[0]).toMatchObject({ id: 'host:mac-1', label: 'mac-1', online: true, agentIds: ['w1', 'w2'] })
    expect(lanes[0]?.sub).toBe('darwin · w1, w2')
    expect(laneOf.get('a')).toBe('host:mac-1')
    expect(laneOf.get('b')).toBe('host:mac-1')
  })

  it('uses last_agent when nothing is assigned', () => {
    const { laneOf } = assignLanes(tasks({ id: 'a', last_agent: 'w1' }), [worker({ agentId: 'w1', hostname: 'h' })])
    expect(laneOf.get('a')).toBe('host:h')
  })

  it('falls back to the agent id when a worker has no hostname', () => {
    const { lanes } = assignLanes(tasks({ id: 'a', assigned_to_agent: 'w9' }), [worker({ agentId: 'w9' })])
    expect(lanes[0]).toMatchObject({ id: 'host:w9', label: 'w9', online: true })
  })

  it('gives a task held by an agent that is not online its own lane marked offline', () => {
    const { lanes, laneOf } = assignLanes(tasks({ id: 'a', assigned_to_agent: 'gone' }), [worker({ agentId: 'w1', hostname: 'h' })])
    expect(lanes).toHaveLength(1)
    expect(lanes[0]).toMatchObject({ id: 'agent:gone', online: false, sub: 'offline' })
    expect(laneOf.get('a')).toBe('agent:gone')
  })

  it('keeps an offline agent named queue apart from the Queue lane', () => {
    const { lanes, laneOf } = assignLanes(tasks({ id: 'a', assigned_to_agent: 'queue' }, { id: 'b' }), [])
    expect(lanes.map((l) => l.id)).toEqual(['agent:queue', 'queue'])
    expect(new Set(lanes.map((l) => l.id)).size).toBe(2)
    expect(laneOf.get('a')).toBe('agent:queue')
    expect(laneOf.get('b')).toBe('queue')
  })

  it('gives an offline agent whose id equals an online hostname its own lane', () => {
    const ws = [worker({ agentId: 'w1', hostname: 'box' })]
    const { lanes, laneOf } = assignLanes(tasks({ id: 'a', assigned_to_agent: 'w1' }, { id: 'b', assigned_to_agent: 'box' }), ws)
    expect(lanes.map((l) => l.id)).toEqual(['host:box', 'agent:box'])
    expect(laneOf.get('a')).toBe('host:box')
    expect(laneOf.get('b')).toBe('agent:box')
  })

  it('puts unassigned tasks in the queue lane, which is last', () => {
    const ws = [worker({ agentId: 'w1', hostname: 'zeta' }), worker({ agentId: 'w2', hostname: 'alpha' }), worker({ agentId: 'idle', hostname: 'unused' })]
    const { lanes } = assignLanes(tasks(
      { id: 'q' }, { id: 'off', assigned_to_agent: 'gone' },
      { id: 'z', assigned_to_agent: 'w1' }, { id: 'a', assigned_to_agent: 'w2' },
    ), ws)
    expect(lanes.map((l) => l.id)).toEqual(['host:alpha', 'host:zeta', 'agent:gone', 'queue'])
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
    expect(laneOf.get('g')).toBe('host:h1')
    expect(laneOf.get('lonely')).toBe('queue')
  })

  it('never gives a lane to groups or the root', () => {
    const ts = toPlanTasks(root, [root, row({ id: 'grp', kind: 'group', parent_task_id: 'root' }), row({ id: 'a', parent_task_id: 'grp' })])
    const { laneOf } = assignLanes(ts, [])
    expect([...laneOf.keys()]).toEqual(['a'])
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
