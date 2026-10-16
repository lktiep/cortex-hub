import { describe, expect, it } from 'vitest'
import {
  deriveState, formatUntil, nodeNote, parseJson, resolveDeps, routeLabel, shortModel, toPlanTasks,
} from './model'
import type { PlanTask } from './model'
import { generatePlan, row } from './test-fixtures'

const root = row({ id: 'root', kind: 'group' })
const NOW = new Date('2026-10-16T12:00:00.000Z')

function plan(r: Parameters<typeof row>[0]): PlanTask {
  const t = toPlanTasks(root, [row({ ...r, parent_task_id: 'root' })])[0]
  if (!t) throw new Error('no task')
  return t
}

describe('toPlanTasks', () => {
  it('draws a standalone work root as a one-task plan', () => {
    const solo = row({ id: 'solo', task_key: 'S1', depends_on: '["elsewhere"]', parent_task_id: 'p' })
    const out = toPlanTasks(solo, [solo])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'solo', key: 'S1', parentId: null, groupId: null, externalDeps: 1, deps: [] })
    const legacy = row({ id: 'legacy-1' })
    expect(toPlanTasks(legacy, [])).toHaveLength(1)
    const gate = row({ id: 'g', kind: 'gate', approver: 'user' })
    expect(toPlanTasks(gate, [gate])[0]?.state).toBe('needs_user')
  })

  it('keeps an empty group root empty', () => {
    expect(toPlanTasks(root, [])).toEqual([])
    expect(toPlanTasks(root, [root])).toEqual([])
  })

  it('treats a legacy row as work with a key from the id', () => {
    const t = plan({ id: 'abcdef123456', depends_on: '[]' })
    expect(t.kind).toBe('work')
    expect(t.key).toBe('abcdef12')
    expect(t.deps).toEqual([])
    expect(t.files).toEqual([])
    expect(t.estimate).toBe(1)
    expect(t.route).toBeNull()
    expect(t.escalated).toBe(false)
    expect(t.reviews).toEqual([])
  })

  it('excludes the root and reads route, agent and reviews', () => {
    const reviews = [{ at: 'x', by: 'lead', verdict: 'reject', feedback: 'no' }]
    const out = toPlanTasks(root, [
      root,
      row({
        id: 'a', task_key: 'T1', executor: 'agy', model: 'm', effort: 'low', last_agent: 'w1',
        context: JSON.stringify({ reviews }), current_route: JSON.stringify({ executor: 'claude', model: 'opus', effort: null }),
      }),
    ])
    expect(out.map((t) => t.id)).toEqual(['a'])
    expect(out[0]?.key).toBe('T1')
    expect(out[0]?.primary).toEqual({ executor: 'agy', model: 'm', effort: 'low' })
    expect(out[0]?.route).toEqual({ executor: 'claude', model: 'opus', effort: null })
    expect(out[0]?.agent).toBe('w1')
    expect(out[0]?.reviews).toEqual(reviews)
  })

  it('ignores a reviews value that is not an array', () => {
    expect(plan({ id: 'a', context: '{"reviews":"x"}' }).reviews).toEqual([])
  })

  it('groupId is the nearest group ancestor', () => {
    const out = toPlanTasks(root, [
      row({ id: 'P', kind: 'group', parent_task_id: 'root' }),
      row({ id: 'P.1', kind: 'group', parent_task_id: 'P' }),
      row({ id: 'w', parent_task_id: 'P.1' }),
      row({ id: 'child', parent_task_id: 'w' }),
      row({ id: 'top', parent_task_id: 'root' }),
    ])
    const g = (id: string) => out.find((t) => t.id === id)?.groupId
    expect(g('w')).toBe('P.1')
    expect(g('child')).toBe('P.1')
    expect(g('P.1')).toBe('P')
    expect(g('P')).toBeNull()
    expect(g('top')).toBeNull()
  })

  it('survives a parent cycle', () => {
    const out = toPlanTasks(root, [row({ id: 'a', parent_task_id: 'b' }), row({ id: 'b', parent_task_id: 'a' })])
    expect(out.map((t) => t.groupId)).toEqual([null, null])
  })

  it('generatePlan has cross-group deps and no duplicated dep', () => {
    const rows = generatePlan(60)
    const out = toPlanTasks(rows[0] as (typeof rows)[number], rows)
    const byId = new Map(out.map((t) => [t.id, t]))
    let cross = 0
    for (const t of out) {
      expect(new Set(t.deps).size).toBe(t.deps.length)
      for (const d of t.deps) if (byId.get(d)?.groupId !== t.groupId) cross++
    }
    expect(cross).toBeGreaterThan(0)
  })

  it('keeps only well-formed reviews', () => {
    const good = { at: 'x', by: 'lead', verdict: 'approve', feedback: 'ok' }
    const t = plan({ id: 'a', context: JSON.stringify({ reviews: [good, null, 'x', { verdict: 'approve' }, 4] }) })
    expect(t.reviews).toEqual([good])
  })

  it('handles a generated plan', () => {
    const rows = generatePlan(60)
    const out = toPlanTasks(rows[0] as (typeof rows)[number], rows)
    expect(out).toHaveLength(63)
    expect(out.filter((t) => t.kind === 'gate').length).toBe(6)
  })
})

describe('deriveState', () => {
  const cases: Array<[string, Parameters<typeof row>[0], string]> = [
    ['completed', { id: 'a', status: 'completed' }, 'done'],
    ['approved', { id: 'a', status: 'approved' }, 'done'],
    ['completed+escalated', { id: 'a', status: 'completed', escalated_at: 'x' }, 'done'],
    ['review', { id: 'a', status: 'review' }, 'review'],
    ['pending+escalated', { id: 'a', status: 'pending', escalated_at: 'x' }, 'escalated'],
    ['gate user', { id: 'a', kind: 'gate', approver: 'user' }, 'needs_user'],
    ['gate lead', { id: 'a', kind: 'gate', approver: 'lead' }, 'gate_lead'],
    ['gate pending, no approver', { id: 'a', kind: 'gate' }, 'needs_user'],
    ['gate pending, null approver', { id: 'a', kind: 'gate', approver: null }, 'needs_user'],
    ['gate blocked', { id: 'a', kind: 'gate', approver: 'user', status: 'blocked' }, 'blocked'],
    ['capacity', { id: 'a', wait_reason: 'capacity' }, 'waiting'],
    ['no_worker', { id: 'a', wait_reason: 'no_worker' }, 'waiting'],
    ['lock', { id: 'a', wait_reason: 'lock' }, 'waiting'],
    ['ready', { id: 'a' }, 'ready'],
    ...['assigned', 'accepted', 'in_progress', 'analyzing', 'synthesis', 'discussion', 'strategy_review'].map(
      (s): [string, Parameters<typeof row>[0], string] => [s, { id: 'a', status: s }, 'running'],
    ),
    ['blocked', { id: 'a', status: 'blocked' }, 'blocked'],
    ...['cancelled', 'failed', 'rejected'].map(
      (s): [string, Parameters<typeof row>[0], string] => [s, { id: 'a', status: s }, 'stopped'],
    ),
  ]
  it.each(cases)('maps %s', (_name, r, expected) => {
    expect(deriveState(row(r))).toBe(expected)
  })
})

describe('parsing', () => {
  it('malformed JSON columns parse to empty values', () => {
    const t = plan({ id: 'a', files: 'nope', context: '{', current_route: 'x', executor: 'codex', model: 'gpt-5', effort: null })
    expect(t.files).toEqual([])
    expect(t.estimate).toBe(1)
    expect(t.route).toEqual({ executor: 'codex', model: 'gpt-5', effort: null })
    expect(plan({ id: 'b', files: 'nope', context: '{', current_route: 'x' }).route).toBeNull()
  })

  it('estimate reads context.estimate and defaults to 1', () => {
    const est = (v: unknown) => plan({ id: 'a', context: JSON.stringify({ estimate: v }) }).estimate
    expect(est(2.5)).toBe(2.5)
    expect(est(0)).toBe(1)
    expect(est(-3)).toBe(1)
    expect(est('4')).toBe(1)
  })

  it('parseJson falls back on null, empty and bad input', () => {
    expect(parseJson(null, 7)).toBe(7)
    expect(parseJson(undefined, 7)).toBe(7)
    expect(parseJson('', 7)).toBe(7)
    expect(parseJson('{', 7)).toBe(7)
    expect(parseJson('[1]', [] as number[])).toEqual([1])
  })
})

describe('resolveDeps', () => {
  const build = (rows: Array<Parameters<typeof row>[0]>) =>
    toPlanTasks(root, rows.map((r) => row({ parent_task_id: 'root', ...r })))
  const deps = (out: PlanTask[], id: string) => out.find((t) => t.id === id)?.deps

  it('drops ids outside the tree and counts them as external', () => {
    const out = build([{ id: 'T1' }, { id: 'X', depends_on: '["T1","zzz"]' }])
    expect(deps(out, 'X')).toEqual(['T1'])
    expect(out.find((t) => t.id === 'X')?.externalDeps).toBe(1)
  })

  it('expands a dependency on a group to the group sinks', () => {
    const out = build([
      { id: 'G', kind: 'group' },
      { id: 'A', parent_task_id: 'G' },
      { id: 'B', parent_task_id: 'G', depends_on: '["A"]' },
      { id: 'C', depends_on: '["G"]' },
    ])
    expect(deps(out, 'C')).toEqual(['B'])
  })

  it('expands nested groups recursively and ignores empty groups', () => {
    const out = build([
      { id: 'G', kind: 'group' },
      { id: 'H', kind: 'group', parent_task_id: 'G' },
      { id: 'A', parent_task_id: 'H' },
      { id: 'E', kind: 'group' },
      { id: 'C', depends_on: '["G","E"]' },
    ])
    expect(deps(out, 'C')).toEqual(['A'])
    expect(out.find((t) => t.id === 'C')?.externalDeps).toBe(0)
  })

  it('treats a dependency on a sibling group inside a group as ordering', () => {
    const out = build([
      { id: 'G', kind: 'group' },
      { id: 'H', kind: 'group', parent_task_id: 'G' },
      { id: 'A', parent_task_id: 'H' },
      { id: 'B', parent_task_id: 'G', depends_on: '["H"]' },
      { id: 'C', depends_on: '["G"]' },
    ])
    expect(deps(out, 'B')).toEqual(['A'])
    expect(deps(out, 'C')).toEqual(['B'])
  })

  it('does not loop on cyclic or self dependencies', () => {
    const out = build([
      { id: 'G', kind: 'group', depends_on: '["G"]' },
      { id: 'A', parent_task_id: 'G', depends_on: '["A","C"]' },
      { id: 'C', depends_on: '["G"]' },
    ])
    expect(deps(out, 'A')).toEqual(['C'])
    expect(deps(out, 'C')).toEqual(['A'])
  })

  it('resolves a long chain of groups quickly', () => {
    const rows: Array<Parameters<typeof row>[0]> = []
    for (let k = 0; k < 20; k++) {
      rows.push({ id: `G${k}`, kind: 'group', depends_on: k ? JSON.stringify([`G${k - 1}`]) : '[]' })
      for (const l of ['a', 'b', 'c']) {
        rows.push({ id: `G${k}${l}`, parent_task_id: `G${k}`, depends_on: k ? JSON.stringify([`G${k - 1}`]) : '[]' })
      }
    }
    rows.push({ id: 'end', depends_on: '["G19"]' })
    const t0 = Date.now()
    const out = build(rows)
    expect(Date.now() - t0).toBeLessThan(500)
    expect(deps(out, 'end')).toEqual(['G19a', 'G19b', 'G19c'])
    expect(deps(out, 'G5b')).toEqual(['G4a', 'G4b', 'G4c'])
  })

  it('is exported for in-place use', () => {
    const out = build([{ id: 'A' }])
    resolveDeps(out)
    expect(deps(out, 'A')).toEqual([])
  })
})

describe('labels', () => {
  it.each([
    ['gemini-4-argon-low', 'argon-low'],
    ['gemini-3.8-flash-high', 'flash-high'],
    ['claude-opus-5-5', 'opus-5-5'],
    ['opus', 'opus'],
    ['gpt-5-codex', 'gpt-5-codex'],
  ])('shortModel %s', (input, out) => {
    expect(shortModel(input)).toBe(out)
  })

  it('routeLabel joins executor and short model with a middle dot', () => {
    expect(routeLabel({ executor: 'agy', model: 'gemini-4-argon-low', effort: null })).toBe('agy·argon-low')
    expect(routeLabel({ executor: 'claude', model: null, effort: null })).toBe('claude')
    expect(routeLabel({ executor: null, model: 'opus', effort: null })).toBe('opus')
    expect(routeLabel({ executor: null, model: null, effort: null })).toBeNull()
    expect(routeLabel(null)).toBeNull()
  })

  it('formatUntil renders hours and minutes', () => {
    const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString()
    expect(formatUntil(at(125 * 60_000), NOW)).toBe('in 2h 5m')
    expect(formatUntil(at(40 * 60_000), NOW)).toBe('in 40m')
    expect(formatUntil(at(120 * 60_000), NOW)).toBe('in 2h')
    expect(formatUntil(at(10_000), NOW)).toBe('in 1m')
    expect(formatUntil(at(-1000), NOW)).toBe('now')
    expect(formatUntil('garbage', NOW)).toBe('now')
  })
})

describe('nodeNote', () => {
  const agy = { executor: 'agy', model: 'gemini-4-argon-low', effort: null } as const
  const base = { id: 'a', executor: agy.executor, model: agy.model }
  const note = (r: Partial<Parameters<typeof row>[0]>) => nodeNote(plan({ ...base, ...r }), NOW)

  it('explains why a task is not running', () => {
    const until = new Date(NOW.getTime() + 125 * 60_000).toISOString()
    expect(note({ wait_reason: 'capacity', wait_until: until })).toBe('quota · resets in 2h 5m')
    expect(note({ wait_reason: 'no_worker' })).toBe('no worker for agy·argon-low')
    expect(note({ wait_reason: 'lock' })).toBe('waiting on a file lock')
    expect(note({ escalated_at: 'x', reject_count: 2 })).toBe('escalated · 2 rejections')
    expect(note({ escalated_at: 'x', fail_count: 2 })).toBe('escalated · 2 failures')
    expect(note({ escalated_at: 'x', reject_count: 1 })).toBe('escalated · 1 rejection')
    expect(note({ escalated_at: 'x', reject_count: 1, fail_count: 3 })).toBe('escalated · 1 rejection')
    expect(note({ current_route: JSON.stringify({ executor: 'claude', model: 'opus', effort: null }) })).toBe(
      'fallback from agy·argon-low',
    )
    expect(note({})).toBeNull()
  })

  it('ignores a stale wait reason unless the task is waiting', () => {
    expect(note({ status: 'in_progress', wait_reason: 'lock' })).toBeNull()
    expect(note({ status: 'completed', wait_reason: 'capacity', wait_until: NOW.toISOString() })).toBeNull()
  })

  it('gives a done escalated task no note', () => {
    expect(note({ status: 'completed', escalated_at: 'x', reject_count: 2 })).toBeNull()
  })

  it('notes a fallback to another executor on the same model', () => {
    expect(note({ current_route: JSON.stringify({ executor: 'claude', model: agy.model, effort: null }) })).toBe(
      'fallback from agy·argon-low',
    )
  })

  it('orders escalated, then wait reason, then fallback', () => {
    const fb = JSON.stringify({ executor: 'claude', model: 'opus', effort: null })
    expect(note({ escalated_at: 'x', reject_count: 1, wait_reason: 'lock', current_route: fb })).toBe('escalated · 1 rejection')
    expect(note({ wait_reason: 'lock', current_route: fb })).toBe('waiting on a file lock')
  })
})
