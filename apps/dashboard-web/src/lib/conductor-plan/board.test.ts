import { describe, expect, it } from 'vitest'
import { boardLanes, changedStates } from './board'
import { selectPhase } from './layout'
import { toPlanTasks } from './model'
import type { PlanState, PlanTask } from './model'
import { row, worker } from './test-fixtures'

const root = row({ id: 'root', kind: 'group' })
const NOW = new Date('2026-10-16T12:00:00.000Z')

function tasks(...specs: Array<Parameters<typeof row>[0]>): PlanTask[] {
  return toPlanTasks(root, [root, ...specs.map((s) => row({ parent_task_id: 'root', ...s }))])
}

const deps = (...ids: string[]) => JSON.stringify(ids)

const studio = worker({
  agentId: 'w-studio',
  hostname: 'studio',
  os: 'macos',
  engines: [
    { executor: 'codex', models: ['*'], defaultModel: null },
    { executor: 'claude', models: ['*'], defaultModel: null },
  ],
})
const mini = worker({
  agentId: 'w-mini',
  hostname: 'mini',
  os: 'linux',
  engines: [{ executor: 'agy', models: ['*'], defaultModel: null }],
})

describe('boardLanes', () => {
  it('orders lanes online hosts, offline agents, then the queue, and drops empty ones', () => {
    const list = tasks(
      { id: 'q' },
      { id: 's', assigned_to_agent: 'w-studio' },
      { id: 'o', assigned_to_agent: 'w-gone' },
      { id: 'm', assigned_to_agent: 'w-mini' },
    )
    const lanes = boardLanes(list, [studio, mini, worker({ agentId: 'idle', hostname: 'spare' })], { now: NOW })
    expect(lanes.map((l) => l.id)).toEqual(['host:mini', 'host:studio', 'agent:w-gone', 'queue'])
    expect(lanes.map((l) => [l.online, l.queue])).toEqual([[true, false], [true, false], [false, false], [true, true]])
  })

  it('lists the engines of the lane\'s workers, once each, sorted', () => {
    const list = tasks({ id: 's', assigned_to_agent: 'w-studio' })
    const studio2 = worker({ ...studio, agentId: 'w-studio-2', connectionId: 'c2' })
    const [lane] = boardLanes(list, [studio, studio2], { now: NOW })
    expect(lane?.engines).toEqual(['claude', 'codex'])
    expect(lane?.sub).toBe('macos · w-studio, w-studio-2')
  })

  it('marks a lane busy only while one of its tasks runs', () => {
    const idle = boardLanes(tasks({ id: 's', assigned_to_agent: 'w-studio', status: 'completed' }), [studio], { now: NOW })
    const busy = boardLanes(tasks({ id: 's', assigned_to_agent: 'w-studio', status: 'in_progress' }), [studio], { now: NOW })
    expect(idle[0]?.busy).toBe(false)
    expect(busy[0]?.busy).toBe(true)
  })

  it('orders chips by dependency depth, then priority, then key', () => {
    const list = tasks(
      { id: 'c', task_key: 'C', depends_on: deps('a') },
      { id: 'b', task_key: 'B', priority: 1 },
      { id: 'a', task_key: 'A', priority: 2 },
      { id: 'z', task_key: 'Z', priority: 1 },
    )
    const [queue] = boardLanes(list, [], { now: NOW })
    expect(queue?.chips.map((c) => c.key)).toEqual(['B', 'Z', 'A', 'C'])
  })

  it('maps attempt, route and note, and leaves attempt empty before dispatch', () => {
    const list = tasks(
      {
        id: 'r', task_key: 'R', status: 'in_progress', attempt: 2, assigned_to_agent: 'w-mini',
        executor: 'agy', model: 'gemini-4-argon-low', current_route: JSON.stringify({ executor: 'claude', model: 'claude-sonnet-5-5' }),
      },
      { id: 'n', task_key: 'N', attempt: 0 },
    )
    const lanes = boardLanes(list, [mini], { now: NOW })
    const chip = lanes[0]?.chips[0]
    expect(chip).toMatchObject({ key: 'R', attempt: 2, route: 'claude·sonnet-5-5', note: 'fallback from agy·argon-low', kind: 'work' })
    expect(lanes[1]?.chips[0]?.attempt).toBeNull()
  })

  it('names a gate\'s approver in place of a route and gives it no note', () => {
    const list = tasks({ id: 'g', task_key: 'G', kind: 'gate', approver: 'lead' })
    const chip = boardLanes(list, [], { now: NOW })[0]?.chips[0]
    expect(chip).toMatchObject({ kind: 'gate', route: 'gate · approver lead', note: null, state: 'gate_lead' })
  })

  it('flags chips that wait on a person', () => {
    const list = tasks(
      { id: 'u', kind: 'gate', approver: 'user' },
      { id: 'e', escalated_at: '2026-10-16T11:00:00.000Z' },
      { id: 'l', kind: 'gate', approver: 'lead' },
      { id: 'r', status: 'in_progress' },
    )
    const chips = boardLanes(list, [], { now: NOW }).flatMap((l) => l.chips)
    const flagged = chips.filter((c) => c.attention).map((c) => c.id).sort()
    expect(flagged).toEqual(['e', 'u'])
  })

  it('shows a phase with its inputs and outputs as ghosts', () => {
    const list = tasks(
      { id: 'g1', kind: 'group' },
      { id: 'g2', kind: 'group' },
      { id: 'in', task_key: 'IN' },
      { id: 'm1', task_key: 'M1', parent_task_id: 'g1', depends_on: deps('in') },
      { id: 'out', task_key: 'OUT', parent_task_id: 'g2', depends_on: deps('m1') },
      { id: 'other', task_key: 'OTHER', parent_task_id: 'g2' },
    )
    const phase = selectPhase(list, 'g1')
    const chips = boardLanes(list, [], { phase, now: NOW }).flatMap((l) => l.chips)
    expect(chips.map((c) => [c.key, c.ghost])).toEqual([['IN', 'input'], ['M1', null], ['OUT', 'output']])
  })

  it('never makes a chip of a group', () => {
    const list = tasks({ id: 'g1', kind: 'group' }, { id: 'a', parent_task_id: 'g1' })
    expect(boardLanes(list, [], { now: NOW }).flatMap((l) => l.chips).map((c) => c.id)).toEqual(['a'])
  })
})

describe('changedStates', () => {
  it('lists the tasks whose state moved since the last poll, not the new ones', () => {
    const list = tasks(
      { id: 'same', status: 'pending' },
      { id: 'moved', status: 'in_progress' },
      { id: 'new', status: 'pending' },
    )
    const before = new Map<string, PlanState>([['same', 'ready'], ['moved', 'ready'], ['gone', 'running']])
    expect(changedStates(before, list)).toEqual(['moved'])
  })

  it('reports nothing on the first poll', () => {
    expect(changedStates(new Map(), tasks({ id: 'a' }))).toEqual([])
  })
})
