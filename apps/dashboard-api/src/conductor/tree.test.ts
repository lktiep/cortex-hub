import { beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { EngineInfo, TreeCreateRequest, TreeTaskInput } from '@cortex/shared-types'
import { createTestDb, fakeSocket, insertTask, type FakeSocket } from './testing.js'

let testDb: Database.Database
vi.mock('../db/client.js', () => ({ get db() { return testDb } }))

import { rerouteTask } from './lifecycle.js'
import { addConnection, resetRegistry, updateConnection } from './registry.js'
import { isoSeconds, type TaskRow } from './rows.js'
import { createTree, findCycle, priorityValue } from './tree.js'

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0)
const CLAUDE: EngineInfo = { executor: 'claude', models: ['opus'], defaultModel: 'opus' }
const CODEX: EngineInfo = { executor: 'codex', models: ['*'], defaultModel: null }

function connect(agentId: string, engines: EngineInfo[] = [CLAUDE]): FakeSocket {
  const ws = fakeSocket()
  const r = addConnection({
    ws, agentId, apiKeyOwner: 'o1', apiKeyProjectId: null, hostname: `host-${agentId}`,
    ide: null, platform: null, capabilities: [],
  }, NOW)
  if (!r.ok) throw new Error(r.reason)
  updateConnection(r.conn.connectionId, { protocol: 2, engines, projectId: null, ready: true })
  return ws
}

function row(id: string): TaskRow {
  return testDb.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(id) as TaskRow
}

function byKey(key: string): TaskRow {
  return testDb.prepare('SELECT * FROM conductor_tasks WHERE task_key = ?').get(key) as TaskRow
}

function count(): number {
  return (testDb.prepare('SELECT COUNT(*) AS n FROM conductor_tasks').get() as { n: number }).n
}

function logs(taskId: string, action: string): { agent_id: string | null; message: string | null }[] {
  return testDb.prepare('SELECT agent_id, message FROM conductor_task_logs WHERE task_id = ? AND action = ? ORDER BY id')
    .all(taskId, action) as { agent_id: string | null; message: string | null }[]
}

function work(key: string, extra: Partial<TreeTaskInput> = {}): TreeTaskInput {
  return { key, title: `Task ${key}`, ...extra }
}

function tree(...tasks: TreeTaskInput[]): TreeCreateRequest {
  return { tasks }
}

function failure(req: TreeCreateRequest): { error: string; cycle?: string[] } {
  const r = createTree(req, 'owner')
  if (r.ok) throw new Error('expected createTree to fail')
  return r.err
}

function success(req: TreeCreateRequest, owner: string | null = 'owner') {
  const r = createTree(req, owner)
  if (!r.ok) throw new Error(r.err.error)
  return r.res
}

beforeEach(() => {
  testDb = createTestDb()
  resetRegistry()
})

describe('priorityValue', () => {
  it('maps labels, passes numbers and refuses unknown names', () => {
    expect(priorityValue('critical')).toBe(1)
    expect(priorityValue('high')).toBe(3)
    expect(priorityValue('medium')).toBe(5)
    expect(priorityValue('low')).toBe(8)
    expect(priorityValue(2)).toBe(2)
    expect(priorityValue(undefined)).toBe(5)
    expect(priorityValue('urgent')).toBeNull()
  })
})

describe('findCycle', () => {
  it('returns the cycle path, or null for an acyclic graph', () => {
    const edges = new Map([['A', ['B']], ['B', ['A']], ['C', []]])
    expect(findCycle(['A', 'B', 'C'], edges)).toEqual(['A', 'B', 'A'])
    expect(findCycle(['C'], edges)).toBeNull()
    expect(findCycle(['X'], new Map([['X', ['X']]]))).toEqual(['X', 'X'])
  })
})

describe('createTree', () => {
  it('creates a tree with keys, groups and gates', () => {
    const res = success(tree(
      work('G', { kind: 'group', dependsOn: ['A'] }),
      work('A'),
      work('B', { parentKey: 'G' }),
      work('C', { parentKey: 'G' }),
      work('GATE', { kind: 'gate', dependsOn: ['A'] }),
    ))
    expect(Object.keys(res.ids).sort()).toEqual(['A', 'B', 'C', 'G', 'GATE'])
    expect(res.ready).toBe(1)
    expect(res.rootIds.sort()).toEqual([res.ids.A, res.ids.G, res.ids.GATE].sort())
    expect(JSON.parse(byKey('B').depends_on)).toEqual([res.ids.A])
    expect(JSON.parse(byKey('C').depends_on)).toEqual([res.ids.A])
    expect(byKey('B').status).toBe('blocked')
    expect(byKey('B').parent_task_id).toBe(res.ids.G)
    expect(byKey('G').status).toBe('pending')
    expect(byKey('A').status).toBe('pending')
    expect(byKey('A').review_required).toBe(1)
    const gate = byKey('GATE')
    expect(gate.status).toBe('blocked')
    expect(gate.approver).toBe('user')
    expect(gate.kind).toBe('gate')
  })

  it('accumulates a nested group dependsOn into every descendant, without duplicates', () => {
    const res = success(tree(
      work('X'), work('Y'),
      work('OUT', { kind: 'group', dependsOn: ['X'] }),
      work('IN', { kind: 'group', parentKey: 'OUT', dependsOn: ['Y', 'X'] }),
      work('LEAF', { parentKey: 'IN', dependsOn: ['X'] }),
    ))
    expect(JSON.parse(byKey('LEAF').depends_on).sort()).toEqual([res.ids.X, res.ids.Y].sort())
    expect(JSON.parse(byKey('IN').depends_on).sort()).toEqual([res.ids.X, res.ids.Y].sort())
  })

  it('rejects a dependency cycle and names it', () => {
    const err = failure(tree(work('A', { dependsOn: ['B'] }), work('B', { dependsOn: ['A'] })))
    expect(err.cycle).toEqual(['A', 'B', 'A'])
    expect(err.error).toContain('A')
    expect(count()).toBe(0)
  })

  it('a task depending on its own group is a cycle', () => {
    const err = failure(tree(work('G', { kind: 'group' }), work('A', { parentKey: 'G', dependsOn: ['G'] })))
    expect(err.cycle).toBeDefined()
    expect(err.cycle).toContain('G')
    expect(err.cycle).toContain('A')
    expect(count()).toBe(0)
  })

  it('rejects unknown dependsOn, duplicate key, parentKey to a non-group, bad executor and a glob in files', () => {
    expect(failure(tree(work('A', { dependsOn: ['nope'] }))).error).toContain('nope')
    expect(failure(tree(work('A'), work('A'))).error).toContain('A')
    expect(failure(tree(work('A'), work('B', { parentKey: 'A' }))).error).toContain('B')
    expect(failure(tree(work('A', { executor: 'vim' as never }))).error).toContain('A')
    expect(failure(tree(work('A', { fallback: [{ executor: 'vim' as never, model: null, effort: null }] }))).error).toContain('A')
    expect(failure(tree(work('A', { files: ['src/**/*.ts'] }))).error).toContain('A')
    expect(failure(tree(work('A', { approver: 'lead' }))).error).toContain('A')
    expect(failure(tree(work('A', { priority: 'urgent' as never }))).error).toContain('A')
    expect(failure(tree(work(''))).error).toMatch(/key/)
    expect(count()).toBe(0)
  })

  it('refuses malformed fallback, dependsOn and files with an error and writes nothing', () => {
    expect(failure(tree(work('A', { fallback: [null] as never }))).error).toContain('A')
    expect(failure(tree(work('A', { fallback: 'x' as never }))).error).toContain('A')
    expect(failure(tree(work('A'), work('B', { dependsOn: 'A' as never }))).error).toContain('B')
    expect(failure(tree(work('A', { dependsOn: [3] as never }))).error).toContain('A')
    expect(failure(tree(work('A', { files: 'a.ts' as never }))).error).toContain('A')
    expect(failure({ tasks: 'x' as never }).error).toMatch(/tasks/)
    expect(count()).toBe(0)
  })

  it('refuses a missing or non-string title or key with an error and writes nothing', () => {
    expect(failure(tree({ key: 'A' } as never)).error).toMatch(/^A: .*title/)
    expect(failure(tree(work('A'), work('B', { title: 5 as never }))).error).toMatch(/^B: .*title/)
    expect(failure(tree(work('A', { title: '' }))).error).toMatch(/title/)
    expect(failure(tree({ title: 'T' } as never)).error).toMatch(/key/)
    expect(failure(tree(work(5 as never))).error).toMatch(/key/)
    expect(count()).toBe(0)
  })

  it('maps priority labels and normalizes files', () => {
    success(tree(work('A', { priority: 'high', files: ['./src//a.ts'] }), work('B', { priority: 2 }), work('C')))
    expect(byKey('A').priority).toBe(3)
    expect(JSON.parse(byKey('A').files)).toEqual(['src/a.ts'])
    expect(byKey('B').priority).toBe(2)
    expect(byKey('C').priority).toBe(5)
  })

  it('sets api_key_owner from the caller and starts a task pending once its dependency is completed', () => {
    insertTask(testDb, { id: 'done1', status: 'completed' })
    insertTask(testDb, { id: 'open1', status: 'pending' })
    const res = success(tree(work('A', { dependsOn: ['done1'] }), work('B', { dependsOn: ['open1'] })), 'key-7')
    expect(byKey('A').api_key_owner).toBe('key-7')
    expect(byKey('A').created_by_agent).toBe('key-7')
    expect(byKey('A').status).toBe('pending')
    expect(byKey('B').status).toBe('blocked')
    expect(res.ready).toBe(1)
  })

  it('attaches under parentId, inherits its project and refuses a key already in that tree', () => {
    insertTask(testDb, { id: 'root', kind: 'group', task_key: 'ROOT', project_id: 'p1' })
    insertTask(testDb, { id: 'kid', parent_task_id: 'root', task_key: 'KID', project_id: 'p1' })
    const res = success({ parentId: 'root', tasks: [work('NEW')] })
    expect(byKey('NEW').parent_task_id).toBe('root')
    expect(byKey('NEW').project_id).toBe('p1')
    expect(res.rootIds).toEqual([res.ids.NEW])
    const err = failure({ parentId: 'root', tasks: [work('KID')] })
    expect(err.error).toContain('KID')
    expect(failure({ parentId: 'missing', tasks: [work('Z')] }).error).toContain('missing')
    expect(count()).toBe(3)
  })

  it('dispatches the new ready work', () => {
    const ws = connect('w1')
    success(tree(work('A')))
    expect((ws.sent as { type: string }[]).some((m) => m.type === 'task.assigned')).toBe(true)
    expect(byKey('A').status).toBe('assigned')
  })
})

describe('rerouteTask', () => {
  it('revokes an active task and returns it pending on the new route', () => {
    const ws = connect('w1')
    insertTask(testDb, {
      id: 't1', task_key: 'T1', status: 'in_progress', assigned_to_agent: 'w1', attempt: 1,
      assigned_at: isoSeconds(NOW), accepted_at: isoSeconds(NOW), api_key_owner: 'o1',
    })
    const r = rerouteTask('t1', { executor: 'codex', fallback: [] }, 'lead')
    expect(r.ok).toBe(true)
    const revokes = (ws.sent as { type: string; taskId?: string; reason?: string }[]).filter((m) => m.type === 'task.revoked')
    expect(revokes).toEqual([{ type: 'task.revoked', taskId: 't1', reason: 'rerouted' }])
    const t = row('t1')
    expect(t.status).toBe('pending')
    expect(t.executor).toBe('codex')
    expect(t.assigned_to_agent).toBeNull()
    expect(logs('t1', 'rerouted')).toEqual([{ agent_id: 'lead', message: '{"executor":"codex","fallback":[]}' }])
    expect(logs('t1', 'returned')).toHaveLength(1)
  })

  it('is assigned again on the new route when a matching worker is idle, and never on the old one first', () => {
    const w1 = connect('w1')
    const w2 = connect('w2', [CODEX])
    insertTask(testDb, {
      id: 't1', task_key: 'T1', status: 'in_progress', assigned_to_agent: 'w1', attempt: 1,
      assigned_at: isoSeconds(NOW), accepted_at: isoSeconds(NOW), api_key_owner: 'o1', executor: 'claude',
    })
    expect(rerouteTask('t1', { executor: 'codex' }, null).ok).toBe(true)
    expect(row('t1').status).toBe('assigned')
    expect(row('t1').assigned_to_agent).toBe('w2')
    expect((w1.sent as { type: string }[]).filter((m) => m.type === 'task.assigned')).toHaveLength(0)
    expect((w2.sent as { type: string }[]).filter((m) => m.type === 'task.assigned')).toHaveLength(1)
  })

  it('answers 404 for an unknown task and 409 for a finished one', () => {
    insertTask(testDb, { id: 'd1', status: 'completed' })
    expect(rerouteTask('nope', {}, null)).toMatchObject({ ok: false, status: 404 })
    expect(rerouteTask('d1', { executor: 'codex' }, null)).toMatchObject({ ok: false, status: 409 })
    expect(row('d1').executor).toBeNull()
  })

  it('refuses bad values with 400 before writing anything', () => {
    insertTask(testDb, { id: 't1', status: 'pending' })
    const bad = [
      { executor: 'vim' }, { fallback: [{ executor: 'vim', model: null, effort: null }] }, { priority: 'urgent' },
      { files: ['a/*.ts'] }, { dependsOn: ['ghost'] }, { dependsOn: ['t1'] },
    ]
    for (const patch of bad) {
      expect(rerouteTask('t1', patch as never, null)).toMatchObject({ ok: false, status: 400 })
    }
    expect(row('t1').executor).toBeNull()
    expect(logs('t1', 'rerouted')).toHaveLength(0)
  })

  it("rerouting a group's dependsOn is refused", () => {
    const ws = connect('w1')
    insertTask(testDb, { id: 'g', task_key: 'G', kind: 'group', status: 'pending' })
    insertTask(testDb, { id: 'k', task_key: 'K', parent_task_id: 'g', status: 'in_progress', assigned_to_agent: 'w1', attempt: 1 })
    const r = rerouteTask('g', { dependsOn: ['k'] }, null)
    expect(r).toMatchObject({ ok: false, status: 400, error: "a group's dependencies are set on its tasks" })
    expect(row('g').depends_on).toBe('[]')
    expect(row('g').status).toBe('pending')
    expect(logs('g', 'rerouted')).toHaveLength(0)
    expect((ws.sent as { type: string }[]).filter((m) => m.type === 'task.revoked')).toHaveLength(0)
    expect(row('k').status).toBe('in_progress')
  })

  it('refuses malformed fallback, dependsOn and files with 400 and changes nothing', () => {
    insertTask(testDb, { id: 't1', status: 'pending' })
    insertTask(testDb, { id: 'o', status: 'pending' })
    for (const patch of [{ fallback: [null] }, { fallback: ['x'] }, { fallback: {} }, { dependsOn: 'o' }, { dependsOn: [1] }, { files: 'a.ts' }, { files: [null] }]) {
      expect(rerouteTask('t1', patch as never, null)).toMatchObject({ ok: false, status: 400 })
    }
    expect(row('t1').fallback).toBeNull()
    expect(row('t1').depends_on).toBe('[]')
    expect(logs('t1', 'rerouted')).toHaveLength(0)
  })

  it('refuses a dependsOn cycle with 400 and names it', () => {
    insertTask(testDb, { id: 'a', task_key: 'A', status: 'pending' })
    insertTask(testDb, { id: 'b', task_key: 'B', status: 'blocked', depends_on: '["a"]' })
    const r = rerouteTask('a', { dependsOn: ['b'] }, null)
    expect(r).toMatchObject({ ok: false, status: 400, cycle: ['A', 'B', 'A'] })
    expect(row('a').depends_on).toBe('[]')
  })

  it('detects a cycle through a group parent', () => {
    insertTask(testDb, { id: 'g', task_key: 'G', kind: 'group', status: 'pending' })
    insertTask(testDb, { id: 'k', task_key: 'K', parent_task_id: 'g', status: 'pending' })
    expect(rerouteTask('k', { dependsOn: ['g'] }, null)).toMatchObject({ ok: false, status: 400 })
  })

  it('adds an incomplete dependency and the task becomes blocked, then pending again without it', () => {
    insertTask(testDb, { id: 'dep', status: 'pending' })
    insertTask(testDb, { id: 't1', status: 'pending' })
    expect(rerouteTask('t1', { dependsOn: ['dep'] }, null).ok).toBe(true)
    expect(row('t1').status).toBe('blocked')
    expect(JSON.parse(row('t1').depends_on)).toEqual(['dep'])
    expect(rerouteTask('t1', { dependsOn: [] }, null).ok).toBe(true)
    expect(row('t1').status).toBe('pending')
  })

  it('tells the lead when a reroute makes a gate pending', () => {
    insertTask(testDb, { id: 'g1', task_key: 'G1', kind: 'gate', approver: 'lead', status: 'blocked', depends_on: '["x"]', api_key_owner: 'lead' })
    insertTask(testDb, { id: 'x', status: 'pending' })
    expect(rerouteTask('g1', { dependsOn: [] }, null).ok).toBe(true)
    expect(row('g1').status).toBe('pending')
    const n = testDb.prepare("SELECT kind FROM conductor_notifications WHERE task_id = 'g1'").all()
    expect(n).toEqual([{ kind: 'gate_ready' }])
  })

  it('clearEscalation resets the counters and dispatches', () => {
    const ws = connect('w1')
    insertTask(testDb, {
      id: 't1', task_key: 'T1', status: 'pending', escalated_at: isoSeconds(NOW), fail_count: 2, reject_count: 2, api_key_owner: 'o1',
    })
    expect(rerouteTask('t1', { clearEscalation: true }, null).ok).toBe(true)
    const t = row('t1')
    expect(t.escalated_at).toBeNull()
    expect(t.fail_count).toBe(0)
    expect(t.reject_count).toBe(0)
    expect(t.status).toBe('assigned')
    expect((ws.sent as { type: string }[]).filter((m) => m.type === 'task.assigned')).toHaveLength(1)
  })

  it('stores null to clear a route field and the fallback as JSON', () => {
    insertTask(testDb, { id: 't1', status: 'pending', executor: 'claude', model: 'opus' })
    const fb = [{ executor: 'codex' as const, model: null, effort: null }]
    expect(rerouteTask('t1', { executor: null, model: null, fallback: fb, priority: 'low', files: ['./a.ts'], pinnedAgent: 'w9' }, null).ok).toBe(true)
    const t = row('t1')
    expect(t.executor).toBeNull()
    expect(t.model).toBeNull()
    expect(JSON.parse(t.fallback ?? 'null')).toEqual(fb)
    expect(t.priority).toBe(8)
    expect(JSON.parse(t.files)).toEqual(['a.ts'])
    expect(t.pinned_agent).toBe('w9')
  })
})
