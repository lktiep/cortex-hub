import { beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { EngineInfo, Executor, TaskAssignedMsg } from '@cortex/shared-types'
import { createTestDb, fakeSocket, insertTask, type FakeSocket } from './testing.js'

let testDb: Database.Database
vi.mock('../db/client.js', () => ({ get db() { return testDb } }))

import { dispatch, loadSelectionInput, pickForPull } from './dispatcher.js'
import { addConnection, resetRegistry, setStatus, updateConnection } from './registry.js'
import type { TaskRow } from './rows.js'

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0)
const NOW_ISO = '2026-10-16T12:00:00Z'
const IN_1H = '2026-10-16T13:00:00Z'
const IN_2H = '2026-10-16T14:00:00Z'
const IN_24H = '2026-10-17T12:00:00Z'
const CLAUDE: EngineInfo = { executor: 'claude', models: ['opus', 'sonnet'], defaultModel: 'opus' }

function connect(
  agentId: string, opts: { ws?: FakeSocket; ready?: boolean; connectedAt?: number; defaultExecutor?: Executor | null } = {},
): FakeSocket {
  const ws = opts.ws ?? fakeSocket()
  const r = addConnection({
    ws, agentId, apiKeyOwner: 'o1', apiKeyProjectId: null, hostname: `host-${agentId}`,
    ide: null, platform: null, capabilities: [],
  }, opts.connectedAt ?? NOW)
  if (!r.ok) throw new Error(r.reason)
  updateConnection(r.conn.connectionId, {
    protocol: 2, engines: [CLAUDE], defaultExecutor: opts.defaultExecutor ?? null, projectId: null, ready: opts.ready ?? true,
  })
  return ws
}

function row(id: string): TaskRow {
  return testDb.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(id) as TaskRow
}

function logs(taskId: string, action: string): { agent_id: string | null; message: string | null }[] {
  return testDb.prepare('SELECT agent_id, message FROM conductor_task_logs WHERE task_id = ? AND action = ? ORDER BY id')
    .all(taskId, action) as { agent_id: string | null; message: string | null }[]
}

function notifications(): { recipient: string; task_id: string; kind: string; message: string }[] {
  return testDb.prepare('SELECT recipient, task_id, kind, message FROM conductor_notifications ORDER BY id')
    .all() as { recipient: string; task_id: string; kind: string; message: string }[]
}

beforeEach(() => {
  testDb = createTestDb()
  resetRegistry(NOW)
})

describe('dispatch', () => {
  it('assigns, sets lease and branch, and pushes task.assigned', () => {
    insertTask(testDb, { id: 't1', task_key: 'TT1', title: 'Fix login', executor: 'claude', model: 'opus' })
    const ws = connect('w1')

    const route = { executor: 'claude', model: 'opus', effort: null }
    expect(dispatch(NOW)).toEqual([{ taskId: 't1', agentId: 'w1', route }])

    const t = row('t1')
    expect(t).toMatchObject({
      status: 'assigned', assigned_to_agent: 'w1', assigned_at: NOW_ISO, attempt: 1,
      lease_expires_at: IN_24H, last_agent: 'w1', branch: 'cx/TT1-fix-login',
      wait_reason: null, wait_until: null,
    })
    expect(JSON.parse(t.current_route ?? 'null')).toEqual(route)
    expect(logs('t1', 'assigned')).toHaveLength(1)

    expect(ws.sent).toHaveLength(1)
    const msg = ws.sent[0] as TaskAssignedMsg
    expect(msg.type).toBe('task.assigned')
    expect(msg.taskId).toBe('t1')
    expect(msg.task).toMatchObject({
      id: 't1', branch: 'cx/TT1-fix-login', baseBranch: 'main', route, attempt: 1, leaseExpiresAt: IN_24H,
    })
  })

  it('keeps an existing branch', () => {
    insertTask(testDb, { id: 't1', title: 'Fix login', branch: 'feature/mine' })
    connect('w1')
    dispatch(NOW)
    expect(row('t1').branch).toBe('feature/mine')
  })

  it('dispatch is re-entrancy safe', () => {
    insertTask(testDb, { id: 't1', title: 'One' })
    insertTask(testDb, { id: 't2', title: 'Two' })
    const sockets = ['w1', 'w2'].map((id) => {
      const ws = fakeSocket()
      const send = ws.send
      ws.send = (data: string) => { send(data); dispatch(NOW) }
      return connect(id, { ws })
    })

    expect(dispatch(NOW)).toHaveLength(2)

    expect(logs('t1', 'assigned')).toHaveLength(1)
    expect(logs('t2', 'assigned')).toHaveLength(1)
    expect(new Set([row('t1').assigned_to_agent, row('t2').assigned_to_agent])).toEqual(new Set(['w1', 'w2']))
    for (const ws of sockets) expect(ws.sent).toHaveLength(1)
  })

  it('a call during a pass reruns after it instead of nesting', () => {
    insertTask(testDb, { id: 't1', title: 'One' })
    let statusDuringSend: string | undefined
    const ws = fakeSocket()
    const send = ws.send
    ws.send = (data: string) => {
      send(data)
      if (statusDuringSend !== undefined) return
      insertTask(testDb, { id: 't2', title: 'Two' })
      dispatch(NOW)
      statusDuringSend = row('t2').status
    }
    connect('w1', { ws, connectedAt: NOW - 1000 })
    connect('w2')

    const done = dispatch(NOW)

    expect(statusDuringSend).toBe('pending')
    expect(done.map((a) => [a.taskId, a.agentId])).toEqual([['t1', 'w1'], ['t2', 'w2']])
  })

  it('a worker with an active task is busy', () => {
    insertTask(testDb, { id: 't0', title: 'Running', status: 'in_progress', assigned_to_agent: 'w1' })
    insertTask(testDb, { id: 't1', title: 'Next' })
    const ws = connect('w1')

    expect(dispatch(NOW)).toEqual([])
    expect(ws.sent).toEqual([])
    expect(row('t1').status).toBe('pending')
  })

  it('a worker the registry reports busy is busy', () => {
    insertTask(testDb, { id: 't1', title: 'Next' })
    const ws = connect('w1')
    setStatus('w1', 'busy', NOW)

    expect(dispatch(NOW)).toEqual([])
    expect(ws.sent).toEqual([])
  })

  it('a task in review does not make its worker busy', () => {
    insertTask(testDb, { id: 't0', title: 'Waiting for review', status: 'review', assigned_to_agent: 'w1' })
    insertTask(testDb, { id: 't1', title: 'Next' })
    const ws = connect('w1')

    expect(dispatch(NOW).map((a) => a.taskId)).toEqual(['t1'])
    expect(ws.sent).toHaveLength(1)
  })

  it('send failure returns the task', () => {
    insertTask(testDb, { id: 't1', title: 'Fix login' })
    const ws = fakeSocket()
    let sends = 0
    ws.send = () => { sends++; throw new Error('socket broke') }
    connect('w1', { ws })

    expect(dispatch(NOW)).toEqual([])

    expect(sends).toBe(1)
    expect(row('t1')).toMatchObject({
      status: 'pending', assigned_to_agent: null, assigned_at: null, lease_expires_at: null,
    })
    expect(logs('t1', 'returned')).toEqual([{ agent_id: 'w1', message: 'send failed' }])
  })

  it('after a send failure another worker takes the task in the same call', () => {
    insertTask(testDb, { id: 't1', title: 'Fix login', executor: 'claude', model: 'opus' })
    const broken = fakeSocket()
    let sends = 0
    broken.send = () => { sends++; throw new Error('socket broke') }
    connect('w1', { ws: broken, connectedAt: NOW - 1000 })
    const ws2 = connect('w2')

    expect(dispatch(NOW)).toEqual([{ taskId: 't1', agentId: 'w2', route: { executor: 'claude', model: 'opus', effort: null } }])

    expect(sends).toBe(1)
    expect(ws2.sent).toHaveLength(1)
    expect(row('t1')).toMatchObject({ status: 'assigned', assigned_to_agent: 'w2', attempt: 2 })
  })

  it('closed sockets are not selected', () => {
    insertTask(testDb, { id: 't1', title: 'Fix login' })
    const ws = connect('w1')
    ws.readyState = 3

    expect(dispatch(NOW)).toEqual([])
    expect(ws.sent).toEqual([])
    expect(row('t1').status).toBe('pending')
    expect(logs('t1', 'assigned')).toEqual([])
  })

  it('capacity notifies once', () => {
    insertTask(testDb, {
      id: 't1', task_key: 'TT1', title: 'Fix login', api_key_owner: 'lead', executor: 'claude', model: 'opus', fallback: '[]',
    })
    connect('w1')
    testDb.prepare('INSERT INTO conductor_quota (host, executor, model, exhausted_until) VALUES (?, ?, ?, ?)')
      .run('host-w1', 'claude', 'opus', IN_1H)

    expect(dispatch(NOW)).toEqual([])
    expect(row('t1')).toMatchObject({ status: 'pending', wait_reason: 'capacity', wait_until: IN_1H })
    expect(notifications()).toEqual([{
      recipient: 'lead', task_id: 't1', kind: 'capacity',
      message: `TT1 "Fix login" is waiting for capacity: every route is out of quota until ${IN_1H}.`,
    }])

    dispatch(NOW)
    expect(notifications()).toHaveLength(1)
  })

  it('no_worker notifies once with the route chain', () => {
    insertTask(testDb, {
      id: 't1', task_key: 'TT1', title: 'Fix login', api_key_owner: 'lead', executor: 'agy', model: 'gemini-4-argon-low',
      fallback: '[{"executor":"claude","model":"opus"}]',
    })

    dispatch(NOW)
    dispatch(NOW)

    expect(row('t1').wait_reason).toBe('no_worker')
    expect(notifications()).toEqual([{
      recipient: 'lead', task_id: 't1', kind: 'no_worker',
      message: 'TT1 "Fix login" has no connected worker that can run it (agy/gemini-4-argon-low → claude/opus).',
    }])
  })

  it('a capacity wait whose reset time moves updates wait_until without a new notification', () => {
    insertTask(testDb, {
      id: 't1', task_key: 'TT1', title: 'Fix login', api_key_owner: 'lead', executor: 'claude', model: 'opus', fallback: '[]',
    })
    connect('w1')
    testDb.prepare('INSERT INTO conductor_quota (host, executor, model, exhausted_until) VALUES (?, ?, ?, ?)')
      .run('host-w1', 'claude', 'opus', IN_1H)

    dispatch(NOW)
    expect(row('t1')).toMatchObject({ wait_reason: 'capacity', wait_until: IN_1H })
    expect(notifications()).toHaveLength(1)

    testDb.prepare('UPDATE conductor_quota SET exhausted_until = ?').run(IN_2H)
    expect(dispatch(NOW)).toEqual([])

    expect(row('t1')).toMatchObject({ status: 'pending', wait_reason: 'capacity', wait_until: IN_2H })
    expect(notifications()).toHaveLength(1)
  })

  it('a wait moving from capacity to no_worker sends a second notification', () => {
    insertTask(testDb, {
      id: 't1', task_key: 'TT1', title: 'Fix login', api_key_owner: 'lead', executor: 'claude', model: 'opus', fallback: '[]',
    })
    const ws = connect('w1')
    testDb.prepare('INSERT INTO conductor_quota (host, executor, model, exhausted_until) VALUES (?, ?, ?, ?)')
      .run('host-w1', 'claude', 'opus', IN_1H)

    dispatch(NOW)
    expect(row('t1').wait_reason).toBe('capacity')

    ws.readyState = 3
    dispatch(NOW)

    expect(row('t1')).toMatchObject({ status: 'pending', wait_reason: 'no_worker', wait_until: null })
    expect(notifications().map((n) => [n.task_id, n.kind])).toEqual([['t1', 'capacity'], ['t1', 'no_worker']])
  })

  it('an empty pinned_agent counts as unpinned', () => {
    insertTask(testDb, { id: 't1', title: 'Fix login', pinned_agent: '' })
    const ws = connect('w1')

    expect(dispatch(NOW).map((a) => [a.taskId, a.agentId])).toEqual([['t1', 'w1']])
    expect(ws.sent).toHaveLength(1)
  })

  it('a lock wait is recorded without a notification', () => {
    insertTask(testDb, { id: 't0', title: 'Running', status: 'in_progress', assigned_to_agent: 'w9', files: '["src/a/"]' })
    insertTask(testDb, { id: 't1', title: 'Blocked', api_key_owner: 'lead', files: '["src/a/b.ts"]' })
    connect('w1')

    expect(dispatch(NOW)).toEqual([])
    expect(row('t1').wait_reason).toBe('lock')
    expect(notifications()).toEqual([])
  })
})

describe('loadSelectionInput', () => {
  it('takes ready, open connections, marks busy workers and keeps only active quota', () => {
    insertTask(testDb, { id: 'dep', title: 'Done', status: 'completed' })
    insertTask(testDb, { id: 't1', title: 'Ready', depends_on: '["dep","other"]', required_capabilities: '["gpu"]', files: '["src/x.ts"]' })
    insertTask(testDb, { id: 'gate', title: 'Gate', kind: 'gate' })
    insertTask(testDb, { id: 'esc', title: 'Escalated', escalated_at: NOW_ISO })
    insertTask(testDb, { id: 'act', title: 'Active', status: 'accepted', assigned_to_agent: 'w2', files: '["src/y/"]' })
    connect('w1', { defaultExecutor: 'claude' })
    connect('w2')
    connect('w3', { ready: false })
    testDb.prepare('INSERT INTO conductor_quota (host, executor, model, exhausted_until) VALUES (?, ?, ?, ?), (?, ?, ?, ?)')
      .run('host-w1', 'claude', 'opus', IN_1H, 'host-w1', 'claude', 'sonnet', '2026-10-16T11:00:00Z')

    const input = loadSelectionInput(NOW)

    expect(input.now).toBe(NOW_ISO)
    expect(input.pending.map((t) => t.id)).toEqual(['t1'])
    expect(input.pending[0]).toMatchObject({
      dependsOn: ['dep', 'other'], requiredCapabilities: ['gpu'], files: ['src/x.ts'],
      routes: [{ executor: null, model: null, effort: null }, { executor: 'claude', model: 'opus', effort: null }],
    })
    expect([...input.completedIds]).toEqual(['dep'])
    expect(input.lockedFiles).toEqual([['src/y/']])
    expect(input.workers.map((w) => [w.agentId, w.host, w.busy])).toEqual([['w1', 'host-w1', false], ['w2', 'host-w2', true]])
    // the executor the worker runs a route without one on (review C-1)
    expect(input.workers.map((w) => w.defaultExecutor)).toEqual(['claude', null])
    expect(input.quota).toEqual([{ host: 'host-w1', executor: 'claude', model: 'opus', exhaustedUntil: IN_1H }])
  })
})

describe('pickForPull', () => {
  it('with taskId considers only that task', () => {
    insertTask(testDb, { id: 'first', priority: 1 })
    insertTask(testDb, { id: 'second', priority: 5 })
    insertTask(testDb, { id: 'pinned', pinned_agent: 'someone-else' })

    expect(pickForPull({ apiKeyOwner: 'o1', taskId: 'pinned' }, NOW)).toBeNull()
    expect(pickForPull({ apiKeyOwner: 'o1', taskId: 'second' }, NOW)?.id).toBe('second')
    expect(pickForPull({ apiKeyOwner: 'o1', taskId: 'second' }, NOW)).toBeNull()
    expect(row('first').status).toBe('pending')
  })

  it('returns the task pinned to the caller as accepted, never an executor-bound unpinned one', () => {
    insertTask(testDb, { id: 'agy', title: 'Agy work', executor: 'agy', priority: 1 })
    insertTask(testDb, { id: 'pin', task_key: 'P1', title: 'Pinned work', pinned_agent: 'claude-code', executor: 'claude', context: '{"note":"x"}' })

    const picked = pickForPull({ agentId: 'claude-code' }, NOW)

    expect(picked).toMatchObject({
      id: 'pin', status: 'accepted', assigned_to_agent: 'claude-code', assigned_at: NOW_ISO, accepted_at: NOW_ISO,
      attempt: 1, lease_expires_at: IN_24H, last_agent: 'claude-code', branch: 'cx/P1-pinned-work',
    })
    expect(JSON.parse(picked?.context ?? '{}')).toEqual({ note: 'x', pull: true })
    expect(logs('pin', 'accepted')).toHaveLength(1)

    expect(pickForPull({ agentId: 'claude-code' }, NOW)).toBeNull()
    expect(row('agy').status).toBe('pending')
  })

  it('takes an unpinned, executor-free task and skips declined, capability-bound, foreign-pinned, locked and blocked ones', () => {
    insertTask(testDb, { id: 'declined', title: 'D', priority: 1, context: '{"declined":["claude-code"]}' })
    insertTask(testDb, { id: 'caps', title: 'C', priority: 1, required_capabilities: '["gpu"]' })
    insertTask(testDb, { id: 'foreign', title: 'F', priority: 1, pinned_agent: 'w9' })
    insertTask(testDb, { id: 'held', title: 'H', status: 'review', files: '["src/"]' })
    insertTask(testDb, { id: 'locked', title: 'L', priority: 1, files: '["src/a.ts"]' })
    insertTask(testDb, { id: 'blocked', title: 'B', priority: 1, depends_on: '["held"]' })
    insertTask(testDb, { id: 'free', title: 'Free', priority: 5 })

    expect(pickForPull({ sessionAgent: 'claude-code' }, NOW)?.id).toBe('free')
    expect(pickForPull({}, NOW)).toBeNull()
  })

  it('with a projectId, takes only that project\'s tasks and project-less ones', () => {
    insertTask(testDb, { id: 'b', title: 'Project B work', project_id: 'proj-b', priority: 1 })
    insertTask(testDb, { id: 'a', title: 'Project A work', project_id: 'proj-a', priority: 2 })
    insertTask(testDb, { id: 'none', title: 'Project-less work', priority: 3 })

    expect(pickForPull({ agentId: 'claude-code', projectId: 'proj-a' }, NOW)?.id).toBe('a')
    expect(pickForPull({ agentId: 'claude-code', projectId: 'proj-a' }, NOW)?.id).toBe('none')
    expect(pickForPull({ agentId: 'claude-code', projectId: 'proj-a' }, NOW)).toBeNull()
    expect(row('b').status).toBe('pending')
  })

  it('without a projectId there is no project filter', () => {
    insertTask(testDb, { id: 'b', title: 'Project B work', project_id: 'proj-b' })

    expect(pickForPull({ agentId: 'claude-code' }, NOW)?.id).toBe('b')
  })

  it('a pin matches only an exact (normalized) caller id, never a substring', () => {
    insertTask(testDb, { id: 'pin', title: 'Pinned work', pinned_agent: 'claude-code' })

    expect(pickForPull({ sessionAgent: 'claude-code-2' }, NOW)).toBeNull()
    expect(pickForPull({ agentId: 'claude' }, NOW)).toBeNull()
    expect(row('pin').status).toBe('pending')

    expect(pickForPull({ agentId: 'other', apiKeyOwner: ' Claude-Code ' }, NOW)?.id).toBe('pin')
  })

  it('an empty pinned_agent counts as unpinned', () => {
    insertTask(testDb, { id: 't1', title: 'Free', pinned_agent: '' })

    expect(pickForPull({ agentId: 'claude-code' }, NOW)?.id).toBe('t1')
  })
})
