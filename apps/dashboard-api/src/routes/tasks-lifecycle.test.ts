// The legacy /api/tasks router over the conductor lifecycle (plan A1 task 13),
// against the real registry with fake sockets; only the database is mocked.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { EngineInfo } from '@cortex/shared-types'
import { createTestDb, fakeSocket, insertTask, type FakeSocket } from '../conductor/testing.js'

let testDb: Database.Database
vi.mock('../db/client.js', () => ({ get db() { return testDb } }))

import { Hono } from 'hono'
import { addConnection, resetRegistry, updateConnection } from '../conductor/registry.js'
import type { TaskRow } from '../conductor/rows.js'
import { tasksRouter } from './tasks.js'

const app = new Hono()
app.route('/api/tasks', tasksRouter)

const CLAUDE: EngineInfo = { executor: 'claude', models: ['opus'], defaultModel: 'opus' }

interface Body { task?: TaskRow; error?: string; cycle?: string[]; success?: boolean; id?: string; status?: string }

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Body }> {
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json', ...headers } }
  if (body !== undefined) init.body = JSON.stringify(body)
  const res = await app.request(`/api/tasks${path}`, init)
  return { status: res.status, body: (await res.json()) as Body }
}

function connect(agentId: string): FakeSocket {
  const ws = fakeSocket()
  const r = addConnection({
    ws, agentId, apiKeyOwner: 'o1', apiKeyProjectId: null, hostname: `host-${agentId}`,
    ide: 'vscode', platform: 'darwin', capabilities: [],
  })
  if (!r.ok) throw new Error(r.reason)
  updateConnection(r.conn.connectionId, { protocol: 2, engines: [CLAUDE], projectId: null, ready: true })
  return ws
}

function row(id: string): TaskRow | undefined {
  return testDb.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(id) as TaskRow | undefined
}

function logCount(taskId: string, action: string): number {
  return (testDb.prepare('SELECT COUNT(*) AS n FROM conductor_task_logs WHERE task_id = ? AND action = ?').get(taskId, action) as { n: number }).n
}

function sentOf(ws: FakeSocket, type: string): { type: string; taskId?: string; reason?: string }[] {
  return (ws.sent as { type: string; taskId?: string; reason?: string }[]).filter((m) => m.type === type)
}

/** An in-progress task held by `agent`. */
function active(id: string, agent: string, extra: Partial<TaskRow> = {}): TaskRow {
  return insertTask(testDb, {
    id, status: 'in_progress', assigned_to_agent: agent, assigned_at: '2026-01-01T00:00:00Z', ...extra,
  })
}

beforeEach(() => {
  testDb = createTestDb()
  resetRegistry()
})

describe('POST /', () => {
  it('pins the assignee and dispatches to a connected idle worker', async () => {
    const ws = connect('w1')
    const res = await call('POST', '', { title: 'T', assignTo: 'w1', priority: 'high' }, { 'X-API-Key-Owner': 'lead' })
    expect(res.status).toBe(201)
    const id = res.body.task?.id ?? ''
    expect(sentOf(ws, 'task.assigned')).toHaveLength(1)
    const r = row(id)
    expect(r?.pinned_agent).toBe('w1')
    expect(r?.status).toBe('assigned')
    expect(r?.lease_expires_at).not.toBeNull()
    expect(r?.priority).toBe(3)
    expect(r?.api_key_owner).toBe('lead')
  })

  it('leaves a pinned task pending while its agent is offline', async () => {
    const res = await call('POST', '', { title: 'T', assignTo: 'ghost' })
    expect(res.status).toBe(201)
    expect(res.body.task?.status).toBe('pending')
    expect(res.body.task?.pinned_agent).toBe('ghost')
  })

  it('inserts blocked while a dependency is uncompleted, pending once all are completed', async () => {
    insertTask(testDb, { id: 'open', status: 'pending' })
    insertTask(testDb, { id: 'done', status: 'completed' })
    const blocked = await call('POST', '', { title: 'B', dependsOn: ['open', 'done'] })
    expect(blocked.body.task?.status).toBe('blocked')
    const ready = await call('POST', '', { title: 'R', dependsOn: ['done'] })
    expect(ready.body.task?.status).toBe('pending')
  })

  it('refuses an unknown priority label with 400', async () => {
    const res = await call('POST', '', { title: 'T', priority: 'urgent' })
    expect(res.status).toBe(400)
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM conductor_tasks').get()).toEqual({ n: 0 })
  })
})

describe('PATCH /:id', () => {
  it('moves a review_required task to review on status completed', async () => {
    active('t1', 'w1', { review_required: 1 })
    const res = await call('PATCH', '/t1', { status: 'completed', result: { summary: 'done' } })
    expect(res.status).toBe(200)
    expect(row('t1')?.status).toBe('review')
  })

  it('keeps the stored result when completing without one', async () => {
    active('t1', 'w1', { result: JSON.stringify({ summary: 'kept' }) })
    const res = await call('PATCH', '/t1', { status: 'completed' })
    expect(res.status).toBe(200)
    expect(row('t1')?.status).toBe('completed')
    expect(row('t1')?.result).toContain('kept')
  })

  it.each(['assigned', 'pending'])('refuses status %s with 400 and writes nothing', async (status) => {
    insertTask(testDb, { id: 't1', status: 'pending', title: 'old' })
    const res = await call('PATCH', '/t1', { status, title: 'new' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('use /assign or the dispatcher')
    expect(row('t1')?.title).toBe('old')
  })

  it('refuses an unknown priority label with 400 and writes nothing', async () => {
    insertTask(testDb, { id: 't1', status: 'pending', title: 'old' })
    const res = await call('PATCH', '/t1', { priority: 'urgent', title: 'new' })
    expect(res.status).toBe(400)
    expect(row('t1')?.title).toBe('old')
  })

  it('refuses a rejection without feedback with 400', async () => {
    insertTask(testDb, { id: 't1', status: 'review' })
    expect((await call('PATCH', '/t1', { status: 'rejected' })).status).toBe(400)
    expect(row('t1')?.status).toBe('review')
  })

  it('rejects with feedback through the review path', async () => {
    insertTask(testDb, { id: 't1', status: 'review' })
    const res = await call('PATCH', '/t1', { status: 'rejected', feedback: 'redo it' })
    expect(res.status).toBe(200)
    expect(row('t1')?.status).toBe('pending')
    expect(row('t1')?.reject_count).toBe(1)
  })

  it('refuses a dependsOn cycle with 400 and the cycle', async () => {
    insertTask(testDb, { id: 'A', status: 'blocked', depends_on: JSON.stringify(['B']) })
    insertTask(testDb, { id: 'B', status: 'pending' })
    const res = await call('PATCH', '/B', { dependsOn: ['A'], title: 'changed' })
    expect(res.status).toBe(400)
    expect(res.body.cycle).toBeDefined()
    expect(row('B')?.title).toBe('B')
  })

  it('accepts then starts a task held by an assignee', async () => {
    insertTask(testDb, { id: 't1', status: 'assigned', assigned_to_agent: 'w1' })
    const res = await call('PATCH', '/t1', { status: 'in_progress' })
    expect(res.status).toBe(200)
    expect(row('t1')?.status).toBe('in_progress')
  })

  it('refuses accepted on a task with no assignee with 409', async () => {
    insertTask(testDb, { id: 't1', status: 'pending' })
    const res = await call('PATCH', '/t1', { status: 'accepted' })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('use /assign or the dispatcher')
  })

  it('cancels through the lifecycle', async () => {
    insertTask(testDb, { id: 't1', status: 'pending' })
    expect((await call('PATCH', '/t1', { status: 'cancelled' })).status).toBe(200)
    expect(row('t1')?.status).toBe('cancelled')
  })

  it('pins a new agent through assignedToAgent, revoking the old worker', async () => {
    const w1 = connect('w1')
    active('t1', 'w1')
    const res = await call('PATCH', '/t1', { assignedToAgent: 'w2' })
    expect(res.status).toBe(200)
    expect(sentOf(w1, 'task.revoked')).toHaveLength(1)
    expect(row('t1')?.pinned_agent).toBe('w2')
    expect(row('t1')?.status).toBe('pending')
  })

  it('updates plain fields', async () => {
    insertTask(testDb, { id: 't1', status: 'pending' })
    const res = await call('PATCH', '/t1', { title: 'N', priority: 'low', notifyOnComplete: ['x'] })
    expect(res.status).toBe(200)
    expect(row('t1')?.title).toBe('N')
    expect(row('t1')?.priority).toBe(8)
  })
})

describe('ruling paths', () => {
  it('cancels an active task through PATCH status, revoking the worker', async () => {
    const w1 = connect('w1')
    insertTask(testDb, { id: 't1', status: 'assigned', assigned_to_agent: 'w1' })
    expect((await call('PATCH', '/t1', { status: 'cancelled' })).status).toBe(200)
    expect(sentOf(w1, 'task.revoked')).toHaveLength(1)
    expect(row('t1')?.status).toBe('cancelled')
  })

  it('in_progress on an assigned row accepts it and logs progress', async () => {
    insertTask(testDb, { id: 't1', status: 'assigned', assigned_to_agent: 'w1' })
    expect((await call('PATCH', '/t1', { status: 'in_progress' })).status).toBe(200)
    expect(row('t1')?.status).toBe('in_progress')
    expect(row('t1')?.accepted_at).not.toBeNull()
    expect(logCount('t1', 'progress')).toBe(1)
  })

  it('in_progress on an accepted row does not re-accept', async () => {
    insertTask(testDb, { id: 't1', status: 'accepted', assigned_to_agent: 'w1', accepted_at: '2026-01-01T00:00:00Z' })
    expect((await call('PATCH', '/t1', { status: 'in_progress' })).status).toBe(200)
    expect(row('t1')?.status).toBe('in_progress')
    expect(row('t1')?.accepted_at).toBe('2026-01-01T00:00:00Z')
    expect(logCount('t1', 'progress')).toBe(1)
  })

  it.each(['in_progress', 'accepted'])('%s without an assignee is 409 and writes nothing', async (status) => {
    insertTask(testDb, { id: 't1', status: 'pending', title: 'old' })
    const res = await call('PATCH', '/t1', { status, title: 'changed' })
    expect(res.status).toBe(409)
    expect(row('t1')?.title).toBe('old')
    expect(row('t1')?.status).toBe('pending')
  })

  it('refuses an unsupported status with 400 and leaves the row', async () => {
    insertTask(testDb, { id: 't1', status: 'pending' })
    expect((await call('PATCH', '/t1', { status: 'blocked' })).status).toBe(400)
    expect(row('t1')?.status).toBe('pending')
  })

  it('rejection without feedback writes no other field', async () => {
    insertTask(testDb, { id: 't1', status: 'review', title: 'old' })
    expect((await call('PATCH', '/t1', { status: 'rejected', title: 'changed' })).status).toBe(400)
    expect(row('t1')?.title).toBe('old')
  })
})

describe('POST /:id/assign', () => {
  it('revokes an active task and pins the new agent', async () => {
    const w1 = connect('w1')
    const w2 = connect('w2')
    active('t1', 'w1')
    const res = await call('POST', '/t1/assign', { agentId: 'w2' })
    expect(res.status).toBe(200)
    expect(sentOf(w1, 'task.revoked')).toHaveLength(1)
    expect(row('t1')?.pinned_agent).toBe('w2')
    expect(row('t1')?.assigned_to_agent).toBe('w2')
    expect(sentOf(w2, 'task.assigned')).toHaveLength(1)
    expect(res.body.task?.assigned_to_agent).toBe('w2')
  })
})

describe('PATCH /:id/cancel', () => {
  it('revokes an active task', async () => {
    const w1 = connect('w1')
    active('t1', 'w1')
    const res = await call('PATCH', '/t1/cancel')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, id: 't1', status: 'cancelled' })
    expect(sentOf(w1, 'task.revoked')).toHaveLength(1)
    expect(row('t1')?.status).toBe('cancelled')
  })

  it('answers 404 for a missing task', async () => {
    expect((await call('PATCH', '/nope/cancel')).status).toBe(404)
  })
})

describe('DELETE /:id', () => {
  it('revokes an active task first, then deletes it', async () => {
    const w1 = connect('w1')
    active('t1', 'w1')
    const res = await call('DELETE', '/t1')
    expect(res.status).toBe(200)
    expect(sentOf(w1, 'task.revoked')).toHaveLength(1)
    expect(sentOf(w1, 'task.revoked')[0]?.reason).toBe('deleted')
    expect(row('t1')).toBeUndefined()
  })

  it('answers 404 for a missing task', async () => {
    expect((await call('DELETE', '/nope')).status).toBe(404)
  })
})
