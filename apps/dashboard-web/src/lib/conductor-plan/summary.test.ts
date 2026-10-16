import { describe, expect, it } from 'vitest'
import { toPlanTasks } from './model'
import type { PlanTask } from './model'
import { agentsOnline, awaitingLead, formatDays, groupTabs, needsYou, progressPercent, progressCounts, progressSegments, routeTally, workerRows } from './summary'
import { row, session, worker } from './test-fixtures'
import type { ConductorTask } from '../api'

const root = row({ id: 'root', kind: 'group' })
const NOW = new Date('2026-10-16T12:00:00.000Z')

function plan(rows: Array<Partial<ConductorTask> & { id: string }>): PlanTask[] {
  return toPlanTasks(root, rows.map((r) => row({ parent_task_id: 'root', ...r })))
}

describe('progressCounts', () => {
  it('counts work tasks only and files escalated under blocked', () => {
    const tasks = plan([
      { id: 'a', status: 'completed' },
      { id: 'b', status: 'approved' },
      { id: 'c', status: 'review' },
      { id: 'd', status: 'in_progress' },
      { id: 'e', status: 'pending' },
      { id: 'f', status: 'pending', wait_reason: 'capacity' },
      { id: 'g', status: 'blocked' },
      { id: 'h', status: 'pending', escalated_at: '2026-10-16T01:00:00.000Z' },
      { id: 'i', status: 'cancelled' },
      { id: 'j', status: 'failed' },
      { id: 'gate', kind: 'gate', approver: 'user' },
      { id: 'grp', kind: 'group' },
    ])
    expect(progressCounts(tasks)).toEqual({
      done: 2, review: 1, running: 1, ready: 1, waiting: 1, blocked: 2, total: 8, stopped: 2,
    })
  })
})

describe('needsYou', () => {
  const tasks = plan([
    { id: 'esc', task_key: 'T9', status: 'pending', escalated_at: 'x', reject_count: 2 },
    { id: 'gate', task_key: 'T2', kind: 'gate', approver: 'user' },
    { id: 'nw', task_key: 'T1', wait_reason: 'no_worker', executor: 'agy', model: 'argon-low' },
    { id: 'lead', task_key: 'T0', kind: 'gate', approver: 'lead' },
    { id: 'rev', task_key: 'T00', status: 'review' },
    { id: 'c1', task_key: 'TT3', status: 'cancelled' },
    { id: 'f1', task_key: 'TT1', status: 'failed' },
    { id: 'okdep', task_key: 'TT0', status: 'completed' },
    { id: 'b1', task_key: 'B1', status: 'blocked', depends_on: '["okdep","c1"]' },
    { id: 'b2', task_key: 'B2', status: 'blocked', depends_on: '["c1","f1"]' },
    { id: 'b3', task_key: 'B3', status: 'blocked', depends_on: '["okdep"]' },
  ])

  it('lists escalations, user gates, no_worker tasks and dependents of a stopped task', () => {
    const out = needsYou(tasks, NOW)
    expect(out.map((n) => [n.key, n.kind, n.tone])).toEqual([
      ['B1', 'blocked_by_stopped', 'red'],
      ['B2', 'blocked_by_stopped', 'red'],
      ['T9', 'escalated', 'red'],
      ['T1', 'no_worker', 'amber'],
      ['T2', 'user_gate', 'amber'],
    ])
    const by = (k: string) => out.find((n) => n.key === k)
    expect(by('T9')?.detail).toBe('escalated · 2 rejections')
    expect(by('T1')?.detail).toBe('no worker for agy·argon-low')
    expect(by('T2')?.detail).toBe('awaiting your approval')
    expect(by('B1')?.detail).toBe('depends on cancelled TT3')
    expect(by('B1')).toMatchObject({ taskId: 'b1', title: 'b1' })
  })

  it('uses the stopped dependency with the smallest key and its real status', () => {
    const b2 = needsYou(tasks, NOW).find((n) => n.key === 'B2')
    expect(b2?.detail).toBe('depends on failed TT1')
    const solo = plan([
      { id: 'f', task_key: 'F', status: 'failed' },
      { id: 'b', task_key: 'B', status: 'blocked', depends_on: '["f"]' },
    ])
    expect(needsYou(solo, NOW)[0]?.detail).toBe('depends on failed F')
  })

  it('does not list a blocked task whose dependency id is unknown', () => {
    const out = needsYou(plan([{ id: 'b', status: 'blocked', depends_on: '["ghost"]' }]), NOW)
    expect(out).toEqual([])
  })

  it('leaves out lead gates and reviews', () => {
    const keys = needsYou(tasks, NOW).map((n) => n.key)
    expect(keys).not.toContain('T0')
    expect(keys).not.toContain('T00')
  })
})

describe('awaitingLead', () => {
  it('lists review tasks and lead gates, sorted by key, with violet tone', () => {
    const reviews = [
      { at: 'a', by: 'lead', verdict: 'reject', feedback: 'first' },
      { at: 'b', by: 'lead', verdict: 'reject', feedback: 'latest' },
    ]
    const tasks = plan([
      { id: 'r2', task_key: 'R2', status: 'review', context: JSON.stringify({ reviews }) },
      { id: 'r1', task_key: 'R1', status: 'review' },
      { id: 'g', task_key: 'G1', kind: 'gate', approver: 'lead' },
      { id: 'u', task_key: 'U1', kind: 'gate', approver: 'user' },
    ])
    const out = awaitingLead(tasks)
    expect(out.map((n) => [n.key, n.kind, n.tone, n.detail])).toEqual([
      ['G1', 'lead_gate', 'violet', 'awaiting lead approval'],
      ['R1', 'review', 'violet', 'awaiting review'],
      ['R2', 'review', 'violet', 'latest'],
    ])
  })
})

describe('routeTally', () => {
  it('counts completed work tasks per executor·model', () => {
    const route = (executor: string, model: string) => JSON.stringify({ executor, model, effort: null })
    const tasks = plan([
      { id: 'a', status: 'completed', current_route: route('claude', 'opus') },
      { id: 'b', status: 'completed', current_route: route('agy', 'argon-low') },
      { id: 'c', status: 'completed', current_route: route('agy', 'argon-low') },
      { id: 'd', status: 'completed' },
      { id: 'e', status: 'in_progress', current_route: route('claude', 'opus') },
      { id: 'g', kind: 'gate', approver: 'lead', status: 'approved' },
    ])
    expect(routeTally(tasks)).toEqual([
      { label: 'agy·argon-low', count: 2 },
      { label: 'claude·opus', count: 1 },
      { label: 'unrouted', count: 1 },
    ])
  })
})

describe('legacy rows', () => {
  it('a row with no kind counts as a work task', () => {
    const legacy = plan([{ id: 'l1', status: 'completed' }, { id: 'l2' }].map((r) => ({ ...r, kind: undefined })))
    expect(progressCounts(legacy)).toMatchObject({ done: 1, ready: 1, total: 2 })
    expect(routeTally(legacy)).toEqual([{ label: 'unrouted', count: 1 }])
  })
})

describe('formatting helpers', () => {
  it('progressPercent rounds done over total and is 0 for an empty plan', () => {
    const base = { review: 0, running: 0, ready: 0, waiting: 0, blocked: 0, stopped: 0 }
    expect(progressPercent({ ...base, done: 1, total: 3 })).toBe(33)
    expect(progressPercent({ ...base, done: 2, total: 3 })).toBe(67)
    expect(progressPercent({ ...base, done: 0, total: 0 })).toBe(0)
  })
  it('formatDays keeps one decimal and drops a trailing .0', () => {
    expect(formatDays(2)).toBe('2')
    expect(formatDays(2.25)).toBe('2.3')
    expect(formatDays(0.04)).toBe('0')
  })
})

describe('routeTally ties', () => {
  it('orders equal counts by label whatever the input order', () => {
    const route = (executor: string) => JSON.stringify({ executor, model: null, effort: null })
    const mk = (order: string[]) => plan(order.map((e, i) => ({ id: `t${i}`, status: 'completed', current_route: route(e) })))
    const want = [{ label: 'agy', count: 1 }, { label: 'claude', count: 1 }, { label: 'codex', count: 1 }]
    expect(routeTally(mk(['codex', 'claude', 'agy']))).toEqual(want)
    expect(routeTally(mk(['agy', 'claude', 'codex']))).toEqual(want)
  })
})

describe('workerRows quota boundary', () => {
  const q = (exhaustedUntil: string) => worker({ agentId: 'w', quota: [{ executor: 'claude', model: 'opus', exhaustedUntil, reason: null }] })
  it('drops a quota that ends exactly now and keeps one that ends a millisecond later', () => {
    expect(workerRows([q(NOW.toISOString())], [], NOW)[0]?.quota).toEqual([])
    expect(workerRows([q(new Date(NOW.getTime() + 1).toISOString())], [], NOW)[0]?.quota).toHaveLength(1)
  })
})

describe('workerRows', () => {
  const tasks = plan([{ id: 'cur', task_key: 'T4', title: 'Do it' }])

  it('shows the current task by key and only quota rows still in the future', () => {
    const rows = workerRows([
      worker({
        agentId: 'w1', hostname: 'host-b', os: 'darwin', status: 'busy', currentTaskId: 'cur',
        engines: [
          { executor: 'claude', models: [], defaultModel: null },
          { executor: 'agy', models: [], defaultModel: null },
        ],
        quota: [
          { executor: 'agy', model: 'argon-low', exhaustedUntil: '2026-10-16T13:00:00.000Z', reason: 'q' },
          { executor: 'claude', model: 'opus', exhaustedUntil: '2026-10-16T11:00:00.000Z', reason: 'q' },
        ],
      }),
    ], tasks, NOW)
    expect(rows).toEqual([{
      agentId: 'w1', hostname: 'host-b', os: 'darwin', status: 'busy',
      currentTask: { id: 'cur', key: 'T4', title: 'Do it' },
      engines: 'claude, agy',
      quota: [{ label: 'agy·argon-low', until: '2026-10-16T13:00:00.000Z' }],
    }])
  })

  it('shows the raw id with a null title for a task outside this tree', () => {
    const [r] = workerRows([worker({ currentTaskId: 'elsewhere' })], tasks, NOW)
    expect(r?.currentTask).toEqual({ id: 'elsewhere', key: 'elsewhere', title: null })
  })

  it('has null currentTask when idle, falls back to agentId and sorts', () => {
    const rows = workerRows([
      worker({ agentId: 'z' }),
      worker({ agentId: 'b', hostname: 'same' }),
      worker({ agentId: 'a', hostname: 'same' }),
    ], tasks, NOW)
    expect(rows.map((r) => [r.hostname, r.agentId])).toEqual([['same', 'a'], ['same', 'b'], ['z', 'z']])
    expect(rows[0]?.currentTask).toBeNull()
  })
})

describe('progressSegments', () => {
  const zero = { done: 0, review: 0, running: 0, ready: 0, waiting: 0, blocked: 0, total: 0, stopped: 0 }

  it('drops empty buckets and its percentages sum to 100', () => {
    const segs = progressSegments({ ...zero, done: 3, review: 1, ready: 2, blocked: 4, total: 10 })
    expect(segs.map((s) => s.bucket)).toEqual(['done', 'review', 'ready', 'blocked'])
    expect(segs.map((s) => s.count)).toEqual([3, 1, 2, 4])
    expect(segs.reduce((a, s) => a + s.percent, 0)).toBeCloseTo(100, 2)
    expect(segs[0]?.color).toBe('#34d399')
    expect(segs[3]?.color).toBe('#6b7280')
  })

  it('of an empty plan is []', () => {
    expect(progressSegments(zero)).toEqual([])
  })
})

describe('groupTabs', () => {
  it('lists groups in key order with work-task counts and summed estimates', () => {
    const tasks = plan([
      { id: 'p2', kind: 'group', task_key: 'P2', title: 'Second' },
      { id: 'p1', kind: 'group', task_key: 'P1', title: 'First' },
      { id: 'p3', kind: 'group', title: 'No key', task_key: null },
      { id: 'a', parent_task_id: 'p1', context: '{"estimate":2}' },
      { id: 'b', parent_task_id: 'p1', context: '{"estimate":0.5}' },
      { id: 'g', parent_task_id: 'p1', kind: 'gate', approver: 'user' },
      { id: 'c', parent_task_id: 'p2' },
    ])
    expect(groupTabs(tasks)).toEqual([
      { id: 'p1', label: 'P1', count: 2, days: 2.5 },
      { id: 'p2', label: 'P2', count: 1, days: 1 },
      { id: 'p3', label: 'No key', count: 0, days: 0 },
    ])
  })

  it('gives [] for a legacy tree without groups', () => {
    expect(groupTabs(plan([{ id: 'a' }, { id: 'b' }]))).toEqual([])
  })
})

describe('agentsOnline', () => {
  it('lists two sessions of one agent as two rows and counts the agent once', () => {
    const r = agentsOnline([], [session({ sessionId: 's1', agentId: 'a' }), session({ sessionId: 's2', agentId: 'a' })])
    expect(r.sessions.map((x) => x.sessionId)).toEqual(['s1', 's2'])
    expect(r.total).toBe(1)
  })

  it('counts an agent that is both a worker and a session once', () => {
    const r = agentsOnline([worker({ agentId: 'a' })], [session({ agentId: 'a' }), session({ sessionId: 's2', agentId: 'b' })])
    expect(r.workers.map((w) => w.agentId)).toEqual(['a'])
    expect(r.sessions.map((s) => s.agentId)).toEqual(['b'])
    expect(r.total).toBe(2)
  })

  it('with no workers lists all sessions', () => {
    const r = agentsOnline([], [session({ agentId: 'a' }), session({ sessionId: 's2', agentId: 'b' })])
    expect(r.sessions).toHaveLength(2)
    expect(r.total).toBe(2)
  })

  it('tolerates a missing sessions array', () => {
    const r = agentsOnline([worker({ agentId: 'a' })], undefined)
    expect(r.sessions).toEqual([])
    expect(r.total).toBe(1)
  })
})
