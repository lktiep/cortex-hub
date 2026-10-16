import { beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { EngineInfo, TaskAssignedMsg } from '@cortex/shared-types'
import { createTestDb, fakeSocket, insertTask, type FakeSocket } from './testing.js'

let testDb: Database.Database
vi.mock('../db/client.js', () => ({ get db() { return testDb } }))

import { dispatch } from './dispatcher.js'
import { cancelTask, completeTask, onCompleted, reviewTask } from './lifecycle.js'
import { addConnection, resetRegistry, updateConnection } from './registry.js'
import { isoSeconds, type TaskRow } from './rows.js'

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0)
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const CLAUDE: EngineInfo = { executor: 'claude', models: ['opus', 'sonnet'], defaultModel: 'opus' }

/** A connected worker; `inTx` records, per send, whether a db transaction was open. */
function connect(agentId: string): { ws: FakeSocket; inTx: boolean[] } {
  const ws = fakeSocket()
  const r = addConnection({
    ws, agentId, apiKeyOwner: 'o1', apiKeyProjectId: null, hostname: `host-${agentId}`,
    ide: null, platform: null, capabilities: [],
  }, NOW)
  if (!r.ok) throw new Error(r.reason)
  updateConnection(r.conn.connectionId, { protocol: 2, engines: [CLAUDE], projectId: null, ready: true })
  const inTx: boolean[] = []
  const send = ws.send.bind(ws)
  ws.send = (data: string) => { inTx.push(testDb.inTransaction); send(data) }
  return { ws, inTx }
}

function sent(ws: FakeSocket, type: string): Record<string, unknown>[] {
  return (ws.sent as Record<string, unknown>[]).filter((m) => m.type === type)
}

/** A task already running on `agentId`, owned by the `lead` key. */
function running(id: string, agentId: string, extra: Partial<TaskRow> = {}): TaskRow {
  return insertTask(testDb, {
    id, task_key: id.toUpperCase(), title: 'Fix login', api_key_owner: 'lead', status: 'in_progress',
    assigned_to_agent: agentId, assigned_at: isoSeconds(NOW), accepted_at: isoSeconds(NOW), last_agent: agentId,
    attempt: 1, branch: `cx/${id}`, lease_expires_at: isoSeconds(NOW + 24 * 3600_000), ...extra,
  })
}

/** A task its worker finished, waiting for the lead's verdict. */
function inReview(id: string, extra: Partial<TaskRow> = {}): TaskRow {
  return running(id, 'w1', { status: 'review', lease_expires_at: null, result: '{"summary":"done"}', ...extra })
}

function done(id: string, extra: Partial<TaskRow> = {}): TaskRow {
  return insertTask(testDb, {
    id, status: 'completed', completed_at: isoSeconds(NOW), completed_by: 'w1', api_key_owner: 'lead', ...extra,
  })
}

function row(id: string): TaskRow {
  return testDb.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(id) as TaskRow
}

function context(id: string): Record<string, unknown> {
  return JSON.parse(row(id).context) as Record<string, unknown>
}

function taskCount(): number {
  return (testDb.prepare('SELECT COUNT(*) AS n FROM conductor_tasks').get() as { n: number }).n
}

function logs(taskId: string, action?: string): { action: string; agent_id: string | null; message: string | null }[] {
  return testDb.prepare(
    'SELECT action, agent_id, message FROM conductor_task_logs WHERE task_id = ? AND (? IS NULL OR action = ?) ORDER BY id',
  ).all(taskId, action ?? null, action ?? null) as { action: string; agent_id: string | null; message: string | null }[]
}

function notifications(): { recipient: string; task_id: string; kind: string; message: string }[] {
  return testDb.prepare('SELECT recipient, task_id, kind, message FROM conductor_notifications ORDER BY id')
    .all() as { recipient: string; task_id: string; kind: string; message: string }[]
}

beforeEach(() => {
  testDb = createTestDb()
  resetRegistry(NOW)
})

describe('completion chain', () => {
  it('completion unblocks a dependent only when all its deps are done', () => {
    running('a', 'w1')
    running('b', 'w2')
    insertTask(testDb, { id: 'x', status: 'cancelled' })
    insertTask(testDb, { id: 'c', status: 'blocked', depends_on: '["a","b"]' })
    insertTask(testDb, { id: 'd', status: 'blocked', depends_on: '["a","x"]' })

    expect(completeTask('a', 'w1', 'completed', { summary: 'a done' }).ok).toBe(true)
    expect(row('c').status).toBe('blocked')

    expect(completeTask('b', 'w2', 'completed', { summary: 'b done' }).ok).toBe(true)
    expect(row('c').status).toBe('pending')
    expect(logs('c', 'unblocked')).toEqual([
      { action: 'unblocked', agent_id: null, message: 'All dependencies met after b completed' },
    ])
    // a cancelled dependency never counts as done
    expect(row('d').status).toBe('blocked')
  })

  it('a gate with completed deps becomes pending and notifies gate_ready', () => {
    running('a', 'w1')
    insertTask(testDb, {
      id: 'g', task_key: 'G1', title: 'Check the API', kind: 'gate', approver: 'lead', status: 'blocked',
      depends_on: '["a"]', api_key_owner: 'lead',
    })
    connect('w1')

    expect(completeTask('a', 'w1', 'completed', { summary: 'done' }).ok).toBe(true)

    // a gate is never dispatched, even with a worker free
    expect(row('g')).toMatchObject({ status: 'pending', assigned_to_agent: null })
    expect(logs('g', 'unblocked')).toHaveLength(1)
    expect(notifications()).toEqual([{
      recipient: 'lead', task_id: 'g', kind: 'gate_ready',
      message: 'G1 "Check the API" is waiting for your approval (cortex_task_review).',
    }])
  })

  it('group completes when its children complete and unblocks its dependents', () => {
    insertTask(testDb, { id: 'g', kind: 'group', status: 'pending', api_key_owner: 'lead' })
    running('a', 'w1', { parent_task_id: 'g' })
    running('b', 'w2', { parent_task_id: 'g' })
    insertTask(testDb, { id: 'x', status: 'cancelled', parent_task_id: 'g' })
    insertTask(testDb, { id: 'c', status: 'blocked', depends_on: '["g"]' })

    expect(completeTask('a', 'w1', 'completed', { summary: 'a done' }).ok).toBe(true)
    expect(row('g').status).toBe('pending')
    expect(row('c').status).toBe('blocked')

    expect(completeTask('b', 'w2', 'completed', { summary: 'b done' }).ok).toBe(true)
    expect(row('g').status).toBe('completed')
    expect(row('g').completed_at).toMatch(ISO)
    expect(logs('g', 'completed')).toHaveLength(1)
    expect(row('c').status).toBe('pending')
    expect(logs('c', 'unblocked').map((l) => l.message)).toEqual(['All dependencies met after g completed'])
  })

  it('group with all children cancelled is cancelled', () => {
    insertTask(testDb, { id: 'outer', kind: 'group', status: 'pending' })
    insertTask(testDb, { id: 'y', status: 'completed', parent_task_id: 'outer' })
    insertTask(testDb, { id: 'g', kind: 'group', status: 'pending', parent_task_id: 'outer' })
    insertTask(testDb, { id: 'a', parent_task_id: 'g' })
    insertTask(testDb, { id: 'b', parent_task_id: 'g' })
    insertTask(testDb, { id: 'd', status: 'blocked', depends_on: '["g"]' })

    expect(cancelTask('a', 'lead').ok).toBe(true)
    expect(row('g').status).toBe('pending')

    expect(cancelTask('b', 'lead').ok).toBe(true)
    expect(row('g').status).toBe('cancelled')
    expect(logs('g', 'cancelled')).toHaveLength(1)
    // dependents of a cancelled task stay blocked
    expect(row('d').status).toBe('blocked')
    // the outer group's only other child is completed, so it completes
    expect(row('outer').status).toBe('completed')
  })

  it('legacy parent with an assignee enters synthesis', () => {
    insertTask(testDb, {
      id: 'p', title: 'Ship v2', status: 'in_progress', assigned_to_agent: 'lead-1', context: '{"plan":"x"}',
    })
    running('a', 'w1', { parent_task_id: 'p' })
    done('b', { parent_task_id: 'p', result: '{"summary":"b done"}' })
    const lead = connect('lead-1')

    expect(completeTask('a', 'w1', 'completed', { summary: 'a done' }).ok).toBe(true)

    expect(row('p').status).toBe('synthesis')
    expect(context('p')).toEqual({
      plan: 'x',
      phase: 'synthesis',
      subtaskResults: [
        { id: 'a', title: 'Fix login', status: 'completed', assignedTo: 'w1', completedBy: 'w1', result: { summary: 'a done' } },
        { id: 'b', title: 'b', status: 'completed', assignedTo: null, completedBy: 'w1', result: { summary: 'b done' } },
      ],
    })
    expect(logs('p', 'synthesis_ready').map((l) => l.message)).toEqual(['All 2 subtasks completed. Awaiting Lead Agent synthesis.'])
    expect(sent(lead.ws, 'task.assigned')).toEqual([{
      type: 'task.assigned', taskId: 'p', title: 'Ship v2',
      description: 'All 2 subtasks completed. Please synthesize results and submit final summary.',
      timestamp: expect.any(String),
    }])
    // pushed after the commit
    expect(lead.inTx).toEqual([false])
  })

  it('legacy parent without an assignee auto-completes and runs the chain for itself', () => {
    insertTask(testDb, { id: 'p', status: 'in_progress' })
    running('a', 'w1', { parent_task_id: 'p' })
    insertTask(testDb, { id: 'd', status: 'blocked', depends_on: '["p"]' })

    expect(completeTask('a', 'w1', 'completed', { summary: 'a done' }).ok).toBe(true)

    expect(row('p').status).toBe('completed')
    expect(row('p').completed_at).toMatch(ISO)
    expect(JSON.parse(row('p').result ?? 'null')).toMatchObject({ autoCompleted: true, subtaskResults: [{ id: 'a' }] })
    expect(logs('p', 'auto_completed').map((l) => l.message)).toEqual(['All 1 subtasks completed'])
    expect(row('d').status).toBe('pending')
  })

  it('onCompleted notifies notify_on_complete after the commit, records who got it, then dispatches', () => {
    done('a', {
      title: 'Build', completed_by: 'w9', result: '{"summary":"ok"}', notify_on_complete: '["w2","w3"]', notified_agents: '["w0"]',
    })
    insertTask(testDb, { id: 'c', status: 'blocked', depends_on: '["a"]' })
    const w2 = connect('w2')

    expect(() => testDb.transaction(() => onCompleted(row('a')))()).toThrow('must not run inside a db transaction')
    expect(row('c').status).toBe('blocked')

    onCompleted(row('a'))

    expect(sent(w2.ws, 'task.completed')).toEqual([{
      type: 'task.completed', taskId: 'a', title: 'Build', result: { summary: 'ok' }, completedBy: 'w9',
      timestamp: expect.any(String),
    }])
    // w3 is not connected, so only w2 is recorded
    expect(JSON.parse(row('a').notified_agents)).toEqual(['w0', 'w2'])
    // the dependent was unblocked and the dispatch pass handed it to the idle worker
    expect(row('c')).toMatchObject({ status: 'assigned', assigned_to_agent: 'w2' })
    expect(sent(w2.ws, 'task.assigned').map((m) => m.taskId)).toEqual(['c'])
    expect(w2.inTx.every((open) => !open)).toBe(true)
  })
})

describe('review of a work task', () => {
  it('approve completes and dispatches the dependent', () => {
    inReview('t')
    insertTask(testDb, { id: 'c', status: 'blocked', depends_on: '["t"]' })
    const w1 = connect('w1')

    expect(reviewTask('t', { verdict: 'approve' }, 'dashboard')).toMatchObject({ ok: true, task: { status: 'completed' } })

    expect(row('t')).toMatchObject({ status: 'completed', completed_by: 'dashboard' })
    expect(row('t').completed_at).toMatch(ISO)
    expect(logs('t', 'approved')).toEqual([{ action: 'approved', agent_id: 'dashboard', message: null }])
    expect(row('c')).toMatchObject({ status: 'assigned', assigned_to_agent: 'w1' })
    expect(sent(w1.ws, 'task.assigned').map((m) => m.taskId)).toEqual(['c'])
  })

  it('reject returns the same task with feedback on the same branch', () => {
    inReview('t', { branch: 'cx/T-fix-login' })
    const before = taskCount()

    expect(reviewTask('t', { verdict: 'reject', feedback: 'empty input crashes', by: 'lead' }, 'mcp').ok).toBe(true)

    expect(row('t')).toMatchObject({
      status: 'pending', assigned_to_agent: null, assigned_at: null, accepted_at: null, lease_expires_at: null,
      branch: 'cx/T-fix-login', last_agent: 'w1', attempt: 1, reject_count: 1, escalated_at: null,
    })
    expect(context('t').reviews).toEqual([
      { at: expect.stringMatching(ISO), by: 'lead', verdict: 'reject', feedback: 'empty input crashes' },
    ])
    expect(taskCount()).toBe(before)
    expect(logs('t', 'rejected')).toEqual([{ action: 'rejected', agent_id: 'lead', message: 'empty input crashes' }])
    expect(notifications().filter((n) => n.kind === 'escalated')).toEqual([])

    // the next attempt continues on the same branch with the feedback attached
    const w1 = connect('w1')
    dispatch(NOW)
    const [assigned] = sent(w1.ws, 'task.assigned') as unknown as TaskAssignedMsg[]
    expect(assigned?.task).toMatchObject({ id: 't', branch: 'cx/T-fix-login', reviews: [{ feedback: 'empty input crashes' }] })
  })

  it('second rejection escalates', () => {
    const earlier = { at: isoSeconds(NOW), by: 'lead', verdict: 'reject', feedback: 'missing tests' }
    inReview('t', { reject_count: 1, context: JSON.stringify({ reviews: [earlier] }) })
    connect('w1')

    expect(reviewTask('t', { verdict: 'reject', feedback: 'still broken' }, 'mcp').ok).toBe(true)

    expect(row('t')).toMatchObject({ status: 'pending', reject_count: 2, assigned_to_agent: null })
    expect(row('t').escalated_at).toMatch(ISO)
    expect(context('t').reviews).toEqual([earlier, { at: expect.stringMatching(ISO), by: 'mcp', verdict: 'reject', feedback: 'still broken' }])
    expect(logs('t', 'escalated')).toEqual([{ action: 'escalated', agent_id: 'mcp', message: '2 rejections' }])
    expect(notifications()).toEqual([{
      recipient: 'lead', task_id: 't', kind: 'escalated',
      message: 'T "Fix login" needs you: 2 rejections — last: still broken. Clear with cortex_task_route clearEscalation.',
    }])

    // the lead is told once
    testDb.prepare("UPDATE conductor_tasks SET status = 'review' WHERE id = 't'").run()
    expect(reviewTask('t', { verdict: 'reject', feedback: 'again' }, 'dashboard').ok).toBe(true)
    expect(row('t').reject_count).toBe(3)
    expect(notifications()).toHaveLength(1)
  })

  it('review on a pending work task is 409', () => {
    insertTask(testDb, { id: 't', status: 'pending' })
    insertTask(testDb, { id: 'g', kind: 'group', status: 'pending' })
    const before = row('t')

    expect(reviewTask('t', { verdict: 'approve' }, 'dashboard')).toMatchObject({ ok: false, status: 409 })
    expect(row('t')).toEqual(before)
    expect(logs('t', 'ignored')).toHaveLength(1)

    expect(reviewTask('g', { verdict: 'approve' }, 'dashboard')).toMatchObject({ ok: false, status: 409 })
    expect(row('g').status).toBe('pending')
  })

  it('review of an unknown task is 404', () => {
    expect(reviewTask('nope', { verdict: 'approve' }, 'mcp')).toMatchObject({ ok: false, status: 404 })
  })
})

describe('review of a gate', () => {
  it('lead approves a lead gate over MCP', () => {
    done('a')
    insertTask(testDb, { id: 'g', kind: 'gate', approver: 'lead', status: 'pending', depends_on: '["a"]', api_key_owner: 'lead' })
    insertTask(testDb, { id: 'd', status: 'blocked', depends_on: '["g"]' })

    expect(reviewTask('g', { verdict: 'approve' }, 'mcp').ok).toBe(true)

    expect(row('g')).toMatchObject({ status: 'completed', completed_by: 'mcp' })
    expect(row('g').completed_at).toMatch(ISO)
    expect(logs('g', 'approved')).toHaveLength(1)
    expect(row('d').status).toBe('pending')
  })

  it('user gate refused over MCP and approved from the dashboard', () => {
    done('a')
    insertTask(testDb, { id: 'g', kind: 'gate', approver: 'user', status: 'pending', depends_on: '["a"]', api_key_owner: 'lead' })
    const before = row('g')

    expect(reviewTask('g', { verdict: 'approve', by: 'lead' }, 'mcp'))
      .toEqual({ ok: false, status: 403, error: 'user gates are approved in the dashboard' })
    expect(row('g')).toEqual(before)
    expect(logs('g')).toEqual([])

    expect(reviewTask('g', { verdict: 'approve' }, 'dashboard').ok).toBe(true)
    expect(row('g')).toMatchObject({ status: 'completed', completed_by: 'dashboard' })
  })

  it('gate rejection returns its work dependencies and re-blocks the gate', () => {
    done('a', { branch: 'cx/a', last_agent: 'w1', attempt: 1, title: 'Build API' })
    done('b', { branch: 'cx/b', last_agent: 'w2', attempt: 2, reject_count: 1, title: 'Build UI' })
    done('h', { kind: 'group' })
    insertTask(testDb, {
      id: 'g', kind: 'gate', approver: 'lead', status: 'pending', depends_on: '["a","b","h"]', api_key_owner: 'lead',
    })

    expect(reviewTask('g', { verdict: 'reject', feedback: 'wrong API shape', by: 'lead' }, 'mcp')).toMatchObject({
      ok: true, task: { status: 'blocked' },
    })

    expect(row('g').status).toBe('blocked')
    expect(logs('g', 'rejected')).toEqual([{ action: 'rejected', agent_id: 'lead', message: 'wrong API shape' }])
    const review = { at: expect.stringMatching(ISO), by: 'lead', verdict: 'reject', feedback: 'wrong API shape' }
    expect(row('a')).toMatchObject({
      status: 'pending', completed_at: null, completed_by: null, reject_count: 1, escalated_at: null,
      branch: 'cx/a', last_agent: 'w1', attempt: 1,
    })
    expect(context('a').reviews).toEqual([review])
    expect(row('b')).toMatchObject({ status: 'pending', reject_count: 2, branch: 'cx/b', last_agent: 'w2' })
    expect(row('b').escalated_at).toMatch(ISO)
    expect(context('b').reviews).toEqual([review])
    // only work dependencies go back
    expect(row('h').status).toBe('completed')
    expect(notifications().filter((n) => n.kind === 'escalated').map((n) => n.task_id)).toEqual(['b'])
  })
})
