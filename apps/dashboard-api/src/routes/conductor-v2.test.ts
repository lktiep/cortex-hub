// REST routes over the lifecycle, tree and dispatcher modules (plan A1 task 12),
// against the real registry with fake sockets; only the database is mocked.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { EngineInfo, SessionView, WorkerView } from '@cortex/shared-types'
import { createTestDb, fakeSocket, insertTask, type FakeSocket } from '../conductor/testing.js'

let testDb: Database.Database
vi.mock('../db/client.js', () => ({ get db() { return testDb } }))

import { Hono } from 'hono'
import { addConnection, resetRegistry, updateConnection } from '../conductor/registry.js'
import { isoSeconds, type TaskRow } from '../conductor/rows.js'
import { conductorRouter } from './conductor.js'

const app = new Hono()
app.route('/api/conductor', conductorRouter)

const CLAUDE: EngineInfo = { executor: 'claude', models: ['opus'], defaultModel: 'opus' }

/** Every field the routes answer with; each test reads the ones its route sends. */
interface Body {
  task?: TaskRow | null; tasks?: TaskRow[]; root?: TaskRow; workers?: WorkerView[]
  agents?: WorkerView[]; online?: number; sessions?: SessionView[]
  ids?: Record<string, string>; rootIds?: string[]; ready?: number
  error?: string; cycle?: string[]; message?: string; success?: boolean; id?: string
  assigned?: boolean; agentId?: string | null; delegated?: boolean; subtaskIds?: string[]
  delegation?: { agentId: string; caps: string[] }[]; requiredCapabilities?: string[]
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Body }> {
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json', ...headers } }
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body)
  const res = await app.request(`/api/conductor${path}`, init)
  const text = await res.text()
  try {
    return { status: res.status, body: JSON.parse(text) as Body }
  } catch {
    return { status: res.status, body: { error: text } }
  }
}

function connect(agentId: string, opts: { engines?: EngineInfo[]; projectId?: string | null; capabilities?: string[] } = {}): FakeSocket {
  const ws = fakeSocket()
  const r = addConnection({
    ws, agentId, apiKeyOwner: 'o1', apiKeyProjectId: null, hostname: `host-${agentId}`,
    ide: 'vscode', platform: 'darwin', capabilities: opts.capabilities ?? [],
  })
  if (!r.ok) throw new Error(r.reason)
  updateConnection(r.conn.connectionId, { protocol: 2, engines: opts.engines ?? [CLAUDE], projectId: opts.projectId ?? null, ready: true })
  return ws
}

function row(id: string): TaskRow {
  return testDb.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(id) as TaskRow
}

function count(): number {
  return (testDb.prepare('SELECT COUNT(*) AS n FROM conductor_tasks').get() as { n: number }).n
}

function logs(taskId: string, action: string): { agent_id: string | null; message: string | null }[] {
  return testDb.prepare('SELECT agent_id, message FROM conductor_task_logs WHERE task_id = ? AND action = ? ORDER BY id')
    .all(taskId, action) as { agent_id: string | null; message: string | null }[]
}

function sentOf(ws: FakeSocket, type: string): { type: string; taskId?: string; reason?: string }[] {
  return (ws.sent as { type: string; taskId?: string; reason?: string }[]).filter((m) => m.type === type)
}

function ctx(id: string): Record<string, unknown> {
  return JSON.parse(row(id).context) as Record<string, unknown>
}

function ids(tasks: TaskRow[] | undefined): string[] {
  return (tasks ?? []).map((t) => t.id).sort()
}

beforeEach(() => {
  testDb = createTestDb()
  // Added by the runtime migrations in db/client.ts, not by schema.sql.
  testDb.exec(`
    ALTER TABLE session_handoffs ADD COLUMN api_key_name TEXT;
    ALTER TABLE session_handoffs ADD COLUMN hostname TEXT;
    ALTER TABLE session_handoffs ADD COLUMN os TEXT;
    ALTER TABLE session_handoffs ADD COLUMN ide TEXT;
    ALTER TABLE session_handoffs ADD COLUMN branch TEXT;
    ALTER TABLE session_handoffs ADD COLUMN capabilities TEXT DEFAULT '[]';
    ALTER TABLE session_handoffs ADD COLUMN role TEXT;
    ALTER TABLE session_handoffs ADD COLUMN last_activity TEXT;
    ALTER TABLE session_handoffs ADD COLUMN client_session_id TEXT;
  `)
  resetRegistry()
})

describe('POST /tree and GET /:id/tree', () => {
  it('creates a tree and returns its descendants and the workers serving its project', async () => {
    connect('w1', { projectId: 'p1' })
    connect('w2', { projectId: 'p2' })
    connect('w3', { projectId: null })
    insertTask(testDb, { id: 'other', status: 'completed' })

    const created = await call('POST', '/tree', {
      projectId: 'p1',
      tasks: [
        { key: 'G', title: 'Group', kind: 'group' },
        { key: 'A', title: 'A', parentKey: 'G' },
        { key: 'IN', title: 'Inner', kind: 'group', parentKey: 'G' },
        { key: 'LEAF', title: 'Leaf', parentKey: 'IN', dependsOn: ['A'] },
      ],
    }, { 'X-API-Key-Owner': 'lead' })
    expect(created.status).toBe(201)
    const keyIds = created.body.ids ?? {}
    expect(Object.keys(keyIds).sort()).toEqual(['A', 'G', 'IN', 'LEAF'])
    expect(created.body.rootIds).toEqual([keyIds.G])
    expect(created.body.ready).toBe(1)
    expect(row(keyIds.A ?? '').api_key_owner).toBe('lead')

    const tree = await call('GET', `/${keyIds.G}/tree`)
    expect(tree.status).toBe(200)
    expect(tree.body.root?.id).toBe(keyIds.G)
    expect(ids(tree.body.tasks)).toEqual([keyIds.A, keyIds.IN, keyIds.LEAF].sort())
    expect((tree.body.workers ?? []).map((w) => w.agentId).sort()).toEqual(['w1', 'w3'])
  })

  it('answers 404 for a missing root', async () => {
    expect((await call('GET', '/nope/tree')).status).toBe(404)
  })

  it('refuses a dependency cycle with 400 and the cycle, writing nothing', async () => {
    const res = await call('POST', '/tree', {
      tasks: [{ key: 'A', title: 'A', dependsOn: ['B'] }, { key: 'B', title: 'B', dependsOn: ['A'] }],
    })
    expect(res.status).toBe(400)
    expect(res.body.cycle).toEqual(['A', 'B', 'A'])
    expect(res.body.error).toContain('cycle')
    expect(count()).toBe(0)
  })

  it('refuses a body that is not an object', async () => {
    expect((await call('POST', '/tree', '[1]')).status).toBe(400)
    expect((await call('POST', '/tree', 'not json')).status).toBe(400)
  })
})

describe('POST /', () => {
  it('maps priority labels and refuses an unknown one', async () => {
    const ok = await call('POST', '', { title: 'T', priority: 'high' })
    expect(ok.status).toBe(201)
    expect(ok.body.task?.priority).toBe(3)

    const bad = await call('POST', '', { title: 'U', priority: 'urgent' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toContain('urgent')
    expect(count()).toBe(1)
  })

  it('pins assignTo without pushing when the worker is offline', async () => {
    const res = await call('POST', '', { title: 'T', assignTo: 'w1' })
    expect(res.status).toBe(201)
    const task = row(res.body.task?.id ?? '')
    expect(task.pinned_agent).toBe('w1')
    expect(task.assigned_to_agent).toBeNull()
    expect(task.status).toBe('pending')
  })

  it('pins assignedTo and sends nothing while the pinned worker is busy', async () => {
    const w1 = connect('w1')
    insertTask(testDb, { id: 'busy', status: 'in_progress', assigned_to_agent: 'w1' })
    const res = await call('POST', '', { title: 'T', assignedTo: 'w1' })
    const task = row(res.body.task?.id ?? '')
    expect(task.pinned_agent).toBe('w1')
    expect(task.status).toBe('pending')
    expect(w1.sent).toHaveLength(0)
  })

  it('a pinned task reaches its idle worker through dispatch, and no other worker', async () => {
    const w1 = connect('w1')
    const w2 = connect('w2')
    const res = await call('POST', '', { title: 'T', assignedTo: 'w1' })
    const id = res.body.task?.id ?? ''
    expect(res.body.task?.status).toBe('assigned')
    expect(res.body.task?.assigned_to_agent).toBe('w1')
    expect(sentOf(w1, 'task.assigned').map((m) => m.taskId)).toEqual([id])
    expect(sentOf(w2, 'task.assigned')).toHaveLength(0)
  })

  it('sets api_key_owner from the header and stores the route fields', async () => {
    const res = await call('POST', '', {
      title: 'T', executor: 'codex', model: 'gpt-5', effort: 'high', fallback: [{ executor: 'claude', model: null }],
      files: ['./src/a.ts'], branch: 'cx/t', reviewRequired: true, kind: 'work',
    }, { 'X-API-Key-Owner': 'lead' })
    expect(res.status).toBe(201)
    const task = row(res.body.task?.id ?? '')
    expect(task.api_key_owner).toBe('lead')
    expect(task.created_by_agent).toBe('lead')
    expect(task.executor).toBe('codex')
    expect(task.model).toBe('gpt-5')
    expect(task.effort).toBe('high')
    expect(JSON.parse(task.fallback ?? 'null')).toEqual([{ executor: 'claude', model: null }])
    expect(JSON.parse(task.files)).toEqual(['src/a.ts'])
    expect(task.branch).toBe('cx/t')
    expect(task.review_required).toBe(1)
    expect(task.kind).toBe('work')
    expect(logs(task.id, 'created')).toHaveLength(1)
  })

  it('a gate defaults to the user approver; a task without the header has no owner', async () => {
    const res = await call('POST', '', { title: 'Gate', kind: 'gate' })
    const task = row(res.body.task?.id ?? '')
    expect(task.kind).toBe('gate')
    expect(task.approver).toBe('user')
    expect(task.api_key_owner).toBeNull()
  })

  it('refuses a bad kind, executor, fallback, file glob or list', async () => {
    for (const body of [
      { title: 'T', kind: 'epic' },
      { title: 'T', executor: 'vim' },
      { title: 'T', fallback: [{ executor: 'vim', model: null }] },
      { title: 'T', files: ['src/*.ts'] },
      { title: 'T', dependsOn: 'x' },
    ]) {
      const res = await call('POST', '', body)
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    expect(count()).toBe(0)
  })

  it('blocks a task whose dependency is not complete', async () => {
    insertTask(testDb, { id: 'dep', status: 'pending' })
    const res = await call('POST', '', { title: 'T', dependsOn: ['dep'] })
    expect(res.body.task?.status).toBe('blocked')
  })
})

describe('PUT /:id', () => {
  it('rejected returns the same task to pending with the feedback and creates no row', async () => {
    insertTask(testDb, { id: 't1', status: 'review', assigned_to_agent: 'w1', result: '{"summary":"x"}' })
    const res = await call('PUT', '/t1', { status: 'rejected', message: 'fix the tests' })
    expect(res.status).toBe(200)
    expect(res.body.task?.status).toBe('pending')
    expect(row('t1').reject_count).toBe(1)
    expect(count()).toBe(1)
    expect((ctx('t1').reviews as { feedback: string }[])[0]?.feedback).toBe('fix the tests')
  })

  it('rejected without a message is refused and changes nothing', async () => {
    insertTask(testDb, { id: 't1', status: 'review', assigned_to_agent: 'w1' })
    for (const body of [{ status: 'rejected' }, { status: 'rejected', message: '' }]) {
      const res = await call('PUT', '/t1', body)
      expect(res.status).toBe(400)
    }
    expect(row('t1').status).toBe('review')
  })

  it('approved completes a task in review', async () => {
    insertTask(testDb, { id: 't1', status: 'review', assigned_to_agent: 'w1' })
    const res = await call('PUT', '/t1', { status: 'approved' })
    expect(res.status).toBe(200)
    expect(res.body.task?.status).toBe('completed')
  })

  it('approved on a user gate from an API key is refused', async () => {
    insertTask(testDb, { id: 'g', kind: 'gate', approver: 'user', status: 'pending' })
    const res = await call('PUT', '/g', { status: 'approved' }, { 'X-API-Key-Owner': 'lead' })
    expect(res.status).toBe(403)
    expect(row('g').status).toBe('pending')
  })

  it('logs the message on every update', async () => {
    insertTask(testDb, { id: 't1', status: 'pending' })
    const res = await call('PUT', '/t1', { context: { note: 1 }, message: 'looked at it' })
    expect(res.status).toBe(200)
    expect(logs('t1', 'message').map((l) => l.message)).toEqual(['looked at it'])
    expect(ctx('t1').note).toBe(1)
  })

  it('completed goes through the lifecycle and wraps a string result', async () => {
    insertTask(testDb, { id: 't1', status: 'in_progress', assigned_to_agent: 'w1' })
    const res = await call('PUT', '/t1', { status: 'completed', result: 'done', message: 'wrapping up' })
    expect(res.status).toBe(200)
    expect(res.body.task?.status).toBe('completed')
    expect(JSON.parse(row('t1').result ?? 'null')).toEqual({ summary: 'done' })
    expect(logs('t1', 'message').map((l) => l.message)).toEqual(['wrapping up'])
  })

  it('an object result without a summary gets an empty one; a number becomes the summary', async () => {
    insertTask(testDb, { id: 't1', status: 'in_progress', assigned_to_agent: 'w1' })
    await call('PUT', '/t1', { status: 'review', result: { prUrl: 'https://x/pr/1' } })
    expect(row('t1').status).toBe('review')
    expect(JSON.parse(row('t1').result ?? 'null')).toEqual({ prUrl: 'https://x/pr/1', summary: '' })

    insertTask(testDb, { id: 't2', status: 'accepted', assigned_to_agent: 'w1' })
    await call('PUT', '/t2', { status: 'completed', result: 42 })
    expect(JSON.parse(row('t2').result ?? 'null')).toEqual({ summary: '42' })
  })

  it('failed counts a failure and returns the task to pending', async () => {
    insertTask(testDb, { id: 't1', status: 'in_progress', assigned_to_agent: 'w1' })
    const res = await call('PUT', '/t1', { status: 'failed', result: { summary: 'broke', error: 'boom' } })
    expect(res.status).toBe(200)
    expect(row('t1').status).toBe('pending')
    expect(row('t1').fail_count).toBe(1)
  })

  it('maps a lifecycle refusal to its status', async () => {
    insertTask(testDb, { id: 't1', status: 'pending' })
    const res = await call('PUT', '/t1', { status: 'completed', result: 'x' })
    expect(res.status).toBe(409)
    expect(res.body.error).toBeDefined()
    expect((await call('PUT', '/missing', { status: 'completed' })).status).toBe(404)
  })

  it('in_progress on an assigned task accepts it and records the progress as its assignee', async () => {
    insertTask(testDb, { id: 't1', status: 'assigned', assigned_to_agent: 'w1' })
    const res = await call('PUT', '/t1', { status: 'in_progress', message: 'halfway' })
    expect(res.status).toBe(200)
    expect(res.body.task?.status).toBe('in_progress')
    expect(logs('t1', 'accepted').map((l) => l.agent_id)).toEqual(['w1'])
    expect(logs('t1', 'progress')).toEqual([{ agent_id: 'w1', message: 'halfway' }])
  })

  it('accepted from pull mode marks context.pull; a connected assignee does not', async () => {
    insertTask(testDb, { id: 't1', status: 'assigned', assigned_to_agent: 'offline' })
    const res = await call('PUT', '/t1', { status: 'accepted' })
    expect(res.body.task?.status).toBe('accepted')
    expect(ctx('t1').pull).toBe(true)

    connect('w1')
    insertTask(testDb, { id: 't2', status: 'assigned', assigned_to_agent: 'w1' })
    await call('PUT', '/t2', { status: 'accepted' })
    expect(row('t2').status).toBe('accepted')
    expect(ctx('t2').pull).toBeUndefined()
  })

  it('keeps the strategy_review guard', async () => {
    insertTask(testDb, { id: 't1', status: 'strategy_review' })
    expect((await call('PUT', '/t1', { status: 'completed' })).status).toBe(403)
  })

  it('refuses a context that is not an object and merges one that is', async () => {
    insertTask(testDb, { id: 't1', status: 'pending', context: '{"keep":1}' })
    expect((await call('PUT', '/t1', { context: 'abc' })).status).toBe(400)
    expect((await call('PUT', '/t1', { context: ['x'] })).status).toBe(400)
    expect(ctx('t1')).toEqual({ keep: 1 })
    expect((await call('PUT', '/t1', { context: { more: 2 } })).status).toBe(200)
    expect(ctx('t1')).toEqual({ keep: 1, more: 2 })
  })
})

describe('GET /', () => {
  beforeEach(() => {
    insertTask(testDb, { id: 'a', project_id: 'p1', assigned_to_agent: 'w1' })
    insertTask(testDb, { id: 'b', project_id: 'p1' })
    insertTask(testDb, { id: 'c', project_id: 'p2', assigned_to_agent: 'w1' })
    insertTask(testDb, { id: 'd', project_id: 'p1', assigned_to_agent: 'w2' })
    insertTask(testDb, { id: 'a1', project_id: 'p1', parent_task_id: 'a' })
    insertTask(testDb, { id: 'a2', project_id: 'p1', parent_task_id: 'a1' })
  })

  it('filters by assigned_to and projectId', async () => {
    const res = await call('GET', '?assigned_to=w1&projectId=p1')
    expect(ids(res.body.tasks)).toEqual(['a', 'a1', 'a2', 'b'])
    expect(ids((await call('GET', '?projectId=p2')).body.tasks)).toEqual(['c'])
  })

  it('root returns the whole subtree, the root included', async () => {
    expect(ids((await call('GET', '?root=a')).body.tasks)).toEqual(['a', 'a1', 'a2'])
    expect(ids((await call('GET', '?root=a1')).body.tasks)).toEqual(['a1', 'a2'])
  })

  it('parent_task_id=none returns only top-level tasks', async () => {
    expect(ids((await call('GET', '?parent_task_id=none')).body.tasks)).toEqual(['a', 'b', 'c', 'd'])
    expect(ids((await call('GET', '?parent_task_id=a')).body.tasks)).toEqual(['a1'])
  })
})

describe('POST /:id/cancel', () => {
  it('revokes an active task from its worker', async () => {
    const w1 = connect('w1')
    insertTask(testDb, { id: 't1', status: 'in_progress', assigned_to_agent: 'w1' })
    const res = await call('POST', '/t1/cancel', { reason: 'not needed' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, id: 't1' })
    expect(row('t1').status).toBe('cancelled')
    expect(sentOf(w1, 'task.revoked')).toEqual([{ type: 'task.revoked', taskId: 't1', reason: 'cancelled' }])
    expect(logs('t1', 'message').map((l) => l.message)).toEqual(['not needed'])
  })

  it('cancels without a body', async () => {
    insertTask(testDb, { id: 't1', status: 'pending' })
    const res = await app.request('/api/conductor/t1/cancel', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(row('t1').status).toBe('cancelled')
  })

  it('answers 409 for a finished task and 404 for a missing one', async () => {
    insertTask(testDb, { id: 't1', status: 'completed' })
    expect((await call('POST', '/t1/cancel', {})).status).toBe(409)
    expect(row('t1').status).toBe('completed')
    expect((await call('POST', '/nope/cancel', {})).status).toBe(404)
  })
})

describe('POST /:id/review', () => {
  it('a user gate is refused with an API key and approved without one', async () => {
    insertTask(testDb, { id: 'g', kind: 'gate', approver: 'user', status: 'pending' })
    const refused = await call('POST', '/g/review', { verdict: 'approve' }, { 'X-API-Key-Owner': 'lead' })
    expect(refused.status).toBe(403)
    expect(row('g').status).toBe('pending')

    const approved = await call('POST', '/g/review', { verdict: 'approve' })
    expect(approved.status).toBe(200)
    expect(approved.body.task?.status).toBe('completed')
    expect(logs('g', 'approved').map((l) => l.agent_id)).toEqual(['dashboard'])
  })

  it('records the API key owner as the reviewer', async () => {
    insertTask(testDb, { id: 't1', status: 'review', assigned_to_agent: 'w1' })
    const res = await call('POST', '/t1/review', { verdict: 'reject', feedback: 'no' }, { 'X-API-Key-Owner': 'lead' })
    expect(res.status).toBe(200)
    expect(res.body.task?.status).toBe('pending')
    expect(logs('t1', 'rejected')).toEqual([{ agent_id: 'lead', message: 'no' }])
  })

  it('refuses a bad verdict, a task not in review and a missing task', async () => {
    insertTask(testDb, { id: 't1', status: 'pending' })
    expect((await call('POST', '/t1/review', { verdict: 'maybe' })).status).toBe(400)
    expect((await call('POST', '/t1/review', { verdict: 'approve' })).status).toBe(409)
    expect((await call('POST', '/nope/review', { verdict: 'approve' })).status).toBe(404)
  })
})

describe('POST /:id/route', () => {
  it('reroutes a task', async () => {
    insertTask(testDb, { id: 't1', status: 'pending' })
    const res = await call('POST', '/t1/route', { executor: 'codex', priority: 'high' })
    expect(res.status).toBe(200)
    expect(res.body.task?.executor).toBe('codex')
    expect(res.body.task?.priority).toBe(3)
  })

  it('refuses a cycle with 400 and the cycle; 404 and 409 otherwise', async () => {
    insertTask(testDb, { id: 'a', status: 'blocked', depends_on: '["b"]' })
    insertTask(testDb, { id: 'b', status: 'pending' })
    const res = await call('POST', '/b/route', { dependsOn: ['a'] })
    expect(res.status).toBe(400)
    expect(res.body.cycle).toEqual(['b', 'a', 'b'])
    expect((await call('POST', '/nope/route', { priority: 1 })).status).toBe(404)
    insertTask(testDb, { id: 'done', status: 'completed' })
    expect((await call('POST', '/done/route', { priority: 1 })).status).toBe(409)
    expect((await call('POST', '/b/route', '[]')).status).toBe(400)
  })
})

describe('GET /agents', () => {
  it('returns workers with engines and quota, and active sessions newest first', async () => {
    connect('w1', { projectId: 'p1' })
    const until = isoSeconds(Date.now() + 3600_000)
    testDb.prepare('INSERT INTO conductor_quota (host, executor, model, exhausted_until, reason) VALUES (?, ?, ?, ?, ?)')
      .run('host-w1', 'claude', '*', until, 'limit')
    const session = testDb.prepare(`
      INSERT INTO session_handoffs (id, from_agent, project, task_summary, context, status, project_id, api_key_name, hostname, ide, branch, last_activity, created_at)
      VALUES (?, ?, 'repo', 'summary', '{}', ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    session.run('s-old', 'claude-code', 'active', 'p1', 'key-a', 'mac', 'vscode', 'main', '2026-10-16T10:00:00Z', '2026-10-16T09:00:00Z')
    session.run('s-new', 'codex', 'active', null, null, null, null, null, null, '2026-10-16T11:00:00Z')
    session.run('s-done', 'claude-code', 'completed', 'p1', 'key-a', 'mac', 'vscode', 'main', '2026-10-16T12:00:00Z', '2026-10-16T12:00:00Z')

    const res = await call('GET', '/agents')
    expect(res.status).toBe(200)
    expect(res.body.online).toBe(1)
    const worker = res.body.agents?.[0]
    expect(worker?.agentId).toBe('w1')
    expect(worker?.engines).toEqual([CLAUDE])
    expect(worker?.quota).toEqual([{ executor: 'claude', model: '*', exhaustedUntil: until, reason: 'limit' }])
    expect(res.body.sessions).toEqual([
      { sessionId: 's-new', agentId: 'codex', hostname: null, ide: null, branch: null, projectId: null, apiKeyName: null, lastActivity: '2026-10-16T11:00:00Z' },
      { sessionId: 's-old', agentId: 'claude-code', hostname: 'mac', ide: 'vscode', branch: 'main', projectId: 'p1', apiKeyName: 'key-a', lastActivity: '2026-10-16T10:00:00Z' },
    ])
  })
})

describe('POST /pickup', () => {
  it('returns a task pinned to the caller as accepted', async () => {
    insertTask(testDb, { id: 't1', status: 'pending', pinned_agent: 'me' })
    const res = await call('POST', '/pickup', { agentId: 'me' })
    expect(res.status).toBe(200)
    expect(res.body.task?.id).toBe('t1')
    expect(res.body.task?.status).toBe('accepted')
    expect(res.body.task?.assigned_to_agent).toBe('me')
    expect(ctx('t1').pull).toBe(true)
  })

  it('honours projectId and answers null when nothing fits', async () => {
    insertTask(testDb, { id: 't1', status: 'pending', project_id: 'p2' })
    const res = await call('POST', '/pickup', { agentId: 'me', projectId: 'p1' })
    expect(res.body.task).toBeNull()
    expect(res.body.message).toBeDefined()
    expect(row('t1').status).toBe('pending')
  })

  it('needs an identity', async () => {
    expect((await call('POST', '/pickup', {})).status).toBe(400)
  })
})

describe('POST /auto-assign', () => {
  it('an active task answers from the row without a write', async () => {
    insertTask(testDb, { id: 't1', status: 'in_progress', assigned_to_agent: 'w1' })
    const res = await call('POST', '/auto-assign', { taskId: 't1', requiredCapabilities: ['x'] })
    expect(res.status).toBe(200)
    expect(res.body.assigned).toBe(true)
    expect(res.body.agentId).toBe('w1')
    expect(row('t1').required_capabilities).toBe('[]')
    expect(row('t1').status).toBe('in_progress')
  })

  it('a blocked task stores the capabilities and is not routed', async () => {
    connect('w1', { capabilities: ['x'] })
    insertTask(testDb, { id: 't1', status: 'blocked' })
    const res = await call('POST', '/auto-assign', { taskId: 't1', requiredCapabilities: ['x'] })
    expect(res.body.assigned).toBe(false)
    expect(row('t1').required_capabilities).toBe('["x"]')
    expect(row('t1').status).toBe('blocked')
    expect(count()).toBe(1)
  })

  it('a finished task answers 409', async () => {
    insertTask(testDb, { id: 't1', status: 'completed' })
    expect((await call('POST', '/auto-assign', { taskId: 't1' })).status).toBe(409)
  })

  it('stores the capabilities before answering that no agent is online', async () => {
    insertTask(testDb, { id: 't1', status: 'pending' })
    const res = await call('POST', '/auto-assign', { taskId: 't1', requiredCapabilities: ['x'] })
    expect(res.body).toMatchObject({ error: 'No agents online', assigned: false })
    expect(row('t1').required_capabilities).toBe('["x"]')
  })

  it('stores the capabilities before answering that some cannot be covered', async () => {
    connect('w1', { capabilities: ['a'] })
    insertTask(testDb, { id: 't1', status: 'pending' })
    const res = await call('POST', '/auto-assign', { taskId: 't1', requiredCapabilities: ['a', 'z'] })
    expect(res.body.error).toContain('Missing: z')
    expect(res.body.assigned).toBe(false)
    expect(row('t1').required_capabilities).toBe('["a","z"]')
    expect(row('t1').status).toBe('pending')
  })

  it('a single capable agent gets the task through dispatch, without a pin', async () => {
    const w1 = connect('w1', { capabilities: ['x'] })
    insertTask(testDb, { id: 't1', status: 'pending' })
    const res = await call('POST', '/auto-assign', { taskId: 't1', requiredCapabilities: ['x'] })
    expect(res.body.assigned).toBe(true)
    expect(res.body.agentId).toBe('w1')
    expect(row('t1').pinned_agent).toBeNull()
    expect(sentOf(w1, 'task.assigned').map((m) => m.taskId)).toEqual(['t1'])
  })

  it('splits across agents: the parent becomes a pending group and the pinned subtasks are dispatched', async () => {
    const w1 = connect('w1', { capabilities: ['a'] })
    const w2 = connect('w2', { capabilities: ['b'] })
    insertTask(testDb, { id: 't1', status: 'pending', context: '{"keep":true}', project_id: null })
    const res = await call('POST', '/auto-assign', { taskId: 't1', requiredCapabilities: ['a', 'b'] })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ assigned: false, delegated: true })
    expect(res.body.delegation?.map((d) => d.agentId).sort()).toEqual(['w1', 'w2'])

    const parent = row('t1')
    expect(parent.kind).toBe('group')
    expect(parent.status).toBe('pending')
    const parentCtx = ctx('t1')
    expect(parentCtx.keep).toBe(true)
    expect(parentCtx.subtaskIds).toEqual(res.body.subtaskIds)

    const subs = (res.body.subtaskIds ?? []).map(row)
    expect(subs).toHaveLength(2)
    for (const sub of subs) {
      expect(sub.parent_task_id).toBe('t1')
      expect(sub.title.startsWith('[Delegated]')).toBe(true)
      expect(sub.assigned_to_agent).toBe(sub.pinned_agent)
      expect(sub.status).toBe('assigned')
    }
    const byAgent = new Map(subs.map((s) => [s.pinned_agent, s.id]))
    expect(sentOf(w1, 'task.assigned').map((m) => m.taskId)).toEqual([byAgent.get('w1')])
    expect(sentOf(w2, 'task.assigned').map((m) => m.taskId)).toEqual([byAgent.get('w2')])
  })

  it('delegated subtasks stay pending and unassigned while their agents are busy', async () => {
    connect('w1', { capabilities: ['a'] })
    connect('w2', { capabilities: ['b'] })
    insertTask(testDb, { id: 'busy1', status: 'in_progress', assigned_to_agent: 'w1' })
    insertTask(testDb, { id: 'busy2', status: 'in_progress', assigned_to_agent: 'w2' })
    insertTask(testDb, { id: 't1', status: 'pending' })
    const res = await call('POST', '/auto-assign', { taskId: 't1', requiredCapabilities: ['a', 'b'] })
    for (const sub of (res.body.subtaskIds ?? []).map(row)) {
      expect(sub.status).toBe('pending')
      expect(sub.assigned_to_agent).toBeNull()
      expect(sub.assigned_at).toBeNull()
      expect(JSON.parse(sub.required_capabilities)).toEqual([sub.pinned_agent === 'w1' ? 'a' : 'b'])
    }
  })
})
