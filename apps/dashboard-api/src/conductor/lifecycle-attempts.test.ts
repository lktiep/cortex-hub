import { beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { EngineInfo, TaskAssignedMsg, TaskQuotaExhaustedMsg } from '@cortex/shared-types'
import { createTestDb, fakeSocket, insertTask, type FakeSocket } from './testing.js'

let testDb: Database.Database
vi.mock('../db/client.js', () => ({ get db() { return testDb } }))

import { dispatch } from './dispatcher.js'
import {
  acceptTask, cancelTask, completeTask, declineTask, failAttempt, quotaExhausted, recordProgress, returnTask,
} from './lifecycle.js'
import { addConnection, getByAgent, resetRegistry, setStatus, updateConnection } from './registry.js'
import { isoSeconds, type TaskRow } from './rows.js'

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0)
const HOUR = 3600_000
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const CLAUDE: EngineInfo = { executor: 'claude', models: ['opus', 'sonnet'], defaultModel: 'opus' }
const AGY: EngineInfo = { executor: 'agy', models: ['claude-sonnet-5-5-high', 'claude-sonnet-5-5-low'], defaultModel: null }

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

/** A task already running on `agentId`, owned by the `lead` key. */
function running(id: string, agentId: string, extra: Partial<TaskRow> = {}): TaskRow {
  return insertTask(testDb, {
    id, task_key: id.toUpperCase(), title: 'Fix login', api_key_owner: 'lead', status: 'in_progress',
    assigned_to_agent: agentId, assigned_at: isoSeconds(NOW), last_agent: agentId, attempt: 1,
    branch: `cx/${id}`, lease_expires_at: isoSeconds(NOW + 24 * HOUR), ...extra,
  })
}

function row(id: string): TaskRow {
  return testDb.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(id) as TaskRow
}

function context(id: string): Record<string, unknown> {
  return JSON.parse(row(id).context) as Record<string, unknown>
}

function logs(taskId: string, action: string): { agent_id: string | null; message: string | null }[] {
  return testDb.prepare('SELECT agent_id, message FROM conductor_task_logs WHERE task_id = ? AND action = ? ORDER BY id')
    .all(taskId, action) as { agent_id: string | null; message: string | null }[]
}

function notifications(): { recipient: string; task_id: string; kind: string; message: string }[] {
  return testDb.prepare('SELECT recipient, task_id, kind, message FROM conductor_notifications ORDER BY id')
    .all() as { recipient: string; task_id: string; kind: string; message: string }[]
}

function quotaRows(): { host: string; executor: string; model: string; exhausted_until: string; reason: string | null }[] {
  return testDb.prepare('SELECT host, executor, model, exhausted_until, reason FROM conductor_quota ORDER BY host, model')
    .all() as { host: string; executor: string; model: string; exhausted_until: string; reason: string | null }[]
}

function quotaMsg(taskId: string, extra: Partial<TaskQuotaExhaustedMsg> = {}): TaskQuotaExhaustedMsg {
  return {
    type: 'task.quota_exhausted', taskId, executor: 'claude', model: 'opus', raw: 'usage limit reached',
    handoff: { branch: `cx/${taskId}`, commit: 'abc123', note: 'tests written, implementation half done' },
    ...extra,
  }
}

beforeEach(() => {
  testDb = createTestDb()
  resetRegistry(NOW)
})

describe('accept and progress', () => {
  it('accept only by the assignee', () => {
    running('t1', 'w1', { status: 'assigned' })

    expect(acceptTask('t1', 'w2')).toMatchObject({ ok: false, status: 409 })
    expect(row('t1')).toMatchObject({ status: 'assigned', accepted_at: null })
    expect(logs('t1', 'ignored').map((l) => l.agent_id)).toEqual(['w2'])

    expect(acceptTask('t1', 'w1')).toMatchObject({ ok: true, task: { status: 'accepted' } })
    expect(row('t1').accepted_at).toMatch(ISO)
    expect(logs('t1', 'accepted')).toEqual([{ agent_id: 'w1', message: null }])
  })

  it('first progress moves accepted to in_progress and extends the lease once a minute', () => {
    running('t1', 'w1', { status: 'accepted', lease_expires_at: isoSeconds(NOW + 24 * HOUR - 120_000) })

    expect(recordProgress('t1', 'w1', 'reading the code', undefined, NOW).ok).toBe(true)
    expect(row('t1')).toMatchObject({ status: 'in_progress', lease_expires_at: isoSeconds(NOW + 24 * HOUR) })

    recordProgress('t1', 'w1', 'still reading', undefined, NOW + 30_000)
    expect(row('t1').lease_expires_at).toBe(isoSeconds(NOW + 24 * HOUR))

    recordProgress('t1', 'w1', 'writing the fix', 40, NOW + 61_000)
    expect(row('t1').lease_expires_at).toBe(isoSeconds(NOW + 61_000 + 24 * HOUR))

    expect(logs('t1', 'progress').map((l) => l.message)).toEqual(['reading the code', 'still reading', '[40%] writing the fix'])
    expect(logs('t1', 'in_progress')).toHaveLength(1)
  })

  it('progress keeps the last 50 rows', () => {
    running('t1', 'w1')

    for (let i = 0; i < 55; i++) recordProgress('t1', 'w1', `step ${i}`, undefined, NOW)

    expect(logs('t1', 'progress').map((l) => l.message)).toEqual(Array.from({ length: 50 }, (_, i) => `step ${i + 5}`))
  })
})

describe('completion', () => {
  it('completed with review_required goes to review and notifies the creator', () => {
    running('t1', 'w1', { review_required: 1 })
    insertTask(testDb, { id: 't2', title: 'Next' })
    connect('w1')
    setStatus('w1', 'busy', NOW)

    const result = { summary: 'fixed', prUrl: 'https://git.example/pr/7', testOutput: '12 passed' }
    expect(completeTask('t1', 'w1', 'completed', result)).toMatchObject({ ok: true, task: { status: 'review' } })

    expect(row('t1')).toMatchObject({ status: 'review', completed_at: null, lease_expires_at: null })
    expect(JSON.parse(row('t1').result ?? 'null')).toEqual(result)
    expect(notifications()).toEqual([{
      recipient: 'lead', task_id: 't1', kind: 'review_ready',
      message: 'T1 "Fix login" is ready for review — https://git.example/pr/7 (tests attached)',
    }])
    // the worker is free again and the dispatch pass hands it the next task
    expect(row('t2')).toMatchObject({ status: 'assigned', assigned_to_agent: 'w1' })
  })

  it('a worker reporting review goes to review without review_required, naming the branch', () => {
    running('t1', 'w1')

    expect(completeTask('t1', 'w1', 'review', { summary: 'needs a look' }).ok).toBe(true)

    expect(row('t1').status).toBe('review')
    expect(notifications().map((n) => n.message)).toEqual(['T1 "Fix login" is ready for review — cx/t1'])
  })

  it('completed without review completes', () => {
    running('t1', 'w1')
    connect('w1')
    setStatus('w1', 'busy', NOW)

    expect(completeTask('t1', 'w1', 'completed', { summary: 'done' })).toMatchObject({ ok: true, task: { status: 'completed' } })

    expect(row('t1')).toMatchObject({ status: 'completed', completed_by: 'w1', lease_expires_at: null })
    expect(row('t1').completed_at).toMatch(ISO)
    expect(JSON.parse(row('t1').result ?? 'null')).toEqual({ summary: 'done' })
    expect(logs('t1', 'completed')).toEqual([{ agent_id: 'w1', message: 'done' }])
    expect(notifications()).toEqual([])
    expect(getByAgent('w1')?.status).toBe('idle')
  })

  it('a duplicate task.complete is ignored', () => {
    running('t1', 'w1')
    connect('w1')
    expect(completeTask('t1', 'w1', 'completed', { summary: 'done' }).ok).toBe(true)
    const before = row('t1')

    expect(completeTask('t1', 'w1', 'completed', { summary: 'done again' })).toMatchObject({ ok: false, status: 409 })

    expect(row('t1')).toEqual(before)
    expect(logs('t1', 'ignored')).toHaveLength(1)
    expect(logs('t1', 'completed')).toHaveLength(1)
  })

  it('without an agent, completion skips the owner check and frees only an assignee it held', () => {
    running('t1', 'w1')
    insertTask(testDb, { id: 't2', title: 'Reviewed', status: 'review', assigned_to_agent: 'w2', api_key_owner: 'lead' })
    connect('w1')
    connect('w2')
    setStatus('w1', 'busy', NOW)
    setStatus('w2', 'busy', NOW)

    expect(completeTask('t1', null, 'completed', { summary: 'done by the lead' }).ok).toBe(true)
    expect(row('t1')).toMatchObject({ status: 'completed', completed_by: 'w1' })
    expect(getByAgent('w1')?.status).toBe('idle')

    // a task in review no longer holds its worker, so completing it leaves w2 alone
    expect(completeTask('t2', null, 'completed', { summary: 'approved' }).ok).toBe(true)
    expect(row('t2').status).toBe('completed')
    expect(getByAgent('w2')?.status).toBe('busy')

    expect(completeTask('t1', null, 'completed', { summary: 'again' })).toMatchObject({ ok: false, status: 409 })
  })

  it('without an agent, completing an active task revokes it from its worker first', () => {
    running('t1', 'w1')
    insertTask(testDb, { id: 't2', title: 'Reviewed', status: 'review', assigned_to_agent: 'w2', api_key_owner: 'lead' })
    const ws1 = connect('w1')
    const ws2 = connect('w2')
    setStatus('w1', 'busy', NOW)

    expect(completeTask('t1', null, 'completed', { summary: 'done by the lead' }).ok).toBe(true)
    expect(completeTask('t2', null, 'completed', { summary: 'approved' }).ok).toBe(true)

    expect(ws1.sent).toEqual([{ type: 'task.revoked', taskId: 't1', reason: 'completed' }])
    // a task in review is no longer running anywhere, so there is nothing to revoke
    expect(ws2.sent).toEqual([])
    expect(getByAgent('w1')?.status).toBe('idle')
  })
})

describe('failures and returns', () => {
  it('failed twice escalates', () => {
    insertTask(testDb, { id: 't1', task_key: 'T1', title: 'Fix login', api_key_owner: 'lead' })
    const ws = connect('w1')
    dispatch(NOW)

    expect(completeTask('t1', 'w1', 'failed', { summary: 'tests red', error: '3 tests failed' }).ok).toBe(true)
    // the first failure returns the task and the same worker gets it straight back
    expect(row('t1')).toMatchObject({ status: 'assigned', assigned_to_agent: 'w1', fail_count: 1, attempt: 2, escalated_at: null })
    expect(notifications()).toEqual([])

    expect(failAttempt('t1', 'w1', 'lint failed').ok).toBe(true)

    expect(row('t1')).toMatchObject({
      status: 'pending', assigned_to_agent: null, lease_expires_at: null, fail_count: 2, attempt: 2,
      branch: 'cx/T1-fix-login', last_agent: 'w1',
    })
    expect(row('t1').escalated_at).toMatch(ISO)
    expect(notifications()).toEqual([{
      recipient: 'lead', task_id: 't1', kind: 'escalated',
      message: 'T1 "Fix login" needs you: 2 failures — last: lint failed. Clear with cortex_task_route clearEscalation.',
    }])
    expect(logs('t1', 'returned').map((l) => l.message)).toEqual(['failed: 3 tests failed', 'failed: lint failed'])

    expect(dispatch(NOW)).toEqual([])
    expect(ws.sent).toHaveLength(2)
    expect(row('t1').status).toBe('pending')
  })

  it('escalates once: a third failure sends no second notification and keeps escalated_at', () => {
    running('t1', 'w1')
    const rerun = (): void => {
      testDb.prepare("UPDATE conductor_tasks SET status = 'in_progress', assigned_to_agent = 'w1' WHERE id = 't1'").run()
    }
    failAttempt('t1', 'w1', 'one')
    rerun()
    failAttempt('t1', 'w1', 'two')
    expect(notifications().filter((n) => n.kind === 'escalated')).toHaveLength(1)
    // backdated, so a rewrite within the same second would show
    testDb.prepare("UPDATE conductor_tasks SET escalated_at = ? WHERE id = 't1'").run(isoSeconds(NOW - HOUR))
    rerun()

    expect(failAttempt('t1', 'w1', 'three').ok).toBe(true)

    expect(row('t1')).toMatchObject({ status: 'pending', fail_count: 3, escalated_at: isoSeconds(NOW - HOUR) })
    expect(notifications().filter((n) => n.kind === 'escalated')).toHaveLength(1)
    expect(logs('t1', 'escalated')).toHaveLength(1)
  })

  it('returnTask needs an active task and keeps branch, last_agent, attempt and fail_count', () => {
    running('t1', 'w1', { attempt: 3, fail_count: 1, accepted_at: isoSeconds(NOW) })

    expect(returnTask('t1', 'rerouted').ok).toBe(true)
    // the next attempt is accepted afresh
    expect(row('t1').accepted_at).toBeNull()

    expect(row('t1')).toMatchObject({
      status: 'pending', assigned_to_agent: null, assigned_at: null, lease_expires_at: null,
      branch: 'cx/t1', last_agent: 'w1', attempt: 3, fail_count: 1,
    })
    expect(logs('t1', 'returned')).toEqual([{ agent_id: 'w1', message: 'rerouted' }])

    expect(returnTask('t1', 'again')).toMatchObject({ ok: false, status: 409 })
    expect(logs('t1', 'returned')).toHaveLength(1)
    expect(returnTask('missing', 'x')).toMatchObject({ ok: false, status: 404 })
  })

  it('outcomes from a worker that does not hold the task are ignored', () => {
    running('t1', 'w1')
    connect('w2')
    const before = row('t1')

    expect(failAttempt('t1', 'w2', 'boom')).toMatchObject({ ok: false, status: 409 })
    expect(completeTask('t1', 'w2', 'completed', { summary: 'not mine' })).toMatchObject({ ok: false, status: 409 })
    expect(quotaExhausted('t1', 'w2', quotaMsg('t1'), NOW)).toMatchObject({ ok: false, status: 409 })
    expect(declineTask('t1', 'w2', 'no')).toMatchObject({ ok: false, status: 409 })
    expect(recordProgress('t1', 'w2', 'hi', undefined, NOW)).toMatchObject({ ok: false, status: 409 })

    expect(row('t1')).toEqual(before)
    expect(logs('t1', 'ignored')).toHaveLength(5)
    expect(quotaRows()).toEqual([])
  })
})

describe('quota', () => {
  it('quota exhaustion records host scope, stores the handoff and returns the task without a failure', () => {
    running('t1', 'w1', { executor: 'agy', model: 'claude-sonnet-5-5-high', fallback: '[]' })
    connect('w1', [AGY])
    const msg = quotaMsg('t1', {
      executor: 'agy', model: 'claude-sonnet-5-5-high', modelScope: 'claude-sonnet-5-5-*', raw: 'x'.repeat(600),
    })

    expect(quotaExhausted('t1', 'w1', msg, NOW).ok).toBe(true)

    expect(quotaRows()).toEqual([{
      host: 'host-w1', executor: 'agy', model: 'claude-sonnet-5-5-*', exhausted_until: isoSeconds(NOW + HOUR), reason: 'x'.repeat(500),
    }])
    expect(row('t1')).toMatchObject({
      status: 'pending', assigned_to_agent: null, fail_count: 0, attempt: 1, branch: 'cx/t1', last_agent: 'w1',
      // that machine is out of quota for the only route, so the task waits for capacity
      wait_reason: 'capacity', wait_until: isoSeconds(NOW + HOUR),
    })
    expect(context('t1').handoff).toEqual(msg.handoff)
    expect(logs('t1', 'returned')).toEqual([{ agent_id: 'w1', message: 'quota exhausted: agy/claude-sonnet-5-5-*' }])

    // another machine takes it, with the handoff
    const ws2 = connect('w2', [AGY])
    expect(dispatch(NOW).map((a) => a.agentId)).toEqual(['w2'])
    expect((ws2.sent[0] as TaskAssignedMsg).task.handoff).toEqual(msg.handoff)
  })

  it('quota keeps the later reset', () => {
    testDb.prepare('INSERT INTO conductor_quota (host, executor, model, exhausted_until, reason, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('host-w1', 'claude', 'opus', isoSeconds(NOW + 3 * HOUR), 'old', isoSeconds(NOW - HOUR))
    running('t1', 'w1')
    running('t2', 'w1')
    connect('w1')
    const updatedAt = (): unknown => testDb.prepare('SELECT updated_at FROM conductor_quota').pluck().get()

    // an earlier reset changes nothing: the reason and time stay those of the kept reset
    quotaExhausted('t1', 'w1', quotaMsg('t1', { resetAt: isoSeconds(NOW + HOUR), raw: 'earlier' }), NOW)
    expect(quotaRows()).toMatchObject([{ exhausted_until: isoSeconds(NOW + 3 * HOUR), reason: 'old' }])
    expect(updatedAt()).toBe(isoSeconds(NOW - HOUR))

    // a later reset replaces it, stored to the second
    quotaExhausted('t2', 'w1', quotaMsg('t2', { resetAt: new Date(NOW + 5 * HOUR).toISOString(), raw: 'later' }), NOW)
    expect(quotaRows()).toMatchObject([{ exhausted_until: isoSeconds(NOW + 5 * HOUR), reason: 'later' }])
    expect(updatedAt()).toBe(isoSeconds(NOW))
  })

  it('without a live connection the host is unknown: no quota row, but the handoff is kept and the task returned', () => {
    running('t1', 'w1')

    expect(quotaExhausted('t1', 'w1', quotaMsg('t1'), NOW).ok).toBe(true)

    expect(quotaRows()).toEqual([])
    expect(row('t1')).toMatchObject({ status: 'pending', fail_count: 0 })
    expect(context('t1').handoff).toEqual(quotaMsg('t1').handoff)
  })
})

describe('decline', () => {
  it('decline busy marks the worker busy and does not record a decline', () => {
    insertTask(testDb, { id: 't1', title: 'Fix login' })
    const ws = connect('w1')
    dispatch(NOW)

    expect(declineTask('t1', 'w1', 'busy').ok).toBe(true)

    expect(getByAgent('w1')?.status).toBe('busy')
    expect(row('t1')).toMatchObject({ status: 'pending', assigned_to_agent: null, attempt: 1 })
    expect(context('t1').declined).toBeUndefined()
    expect(ws.sent).toHaveLength(1)
  })

  it('decline other records the worker in context.declined', () => {
    insertTask(testDb, { id: 't1', title: 'Fix login', context: '{"note":"x"}' })
    const ws = connect('w1')
    dispatch(NOW)

    expect(declineTask('t1', 'w1', 'no gpu here').ok).toBe(true)

    expect(context('t1')).toEqual({ note: 'x', declined: ['w1'] })
    expect(getByAgent('w1')?.status).toBe('idle')
    expect(row('t1')).toMatchObject({ status: 'pending', assigned_to_agent: null, wait_reason: 'no_worker' })
    expect(logs('t1', 'returned')).toEqual([{ agent_id: 'w1', message: 'declined: no gpu here' }])
    expect(ws.sent).toHaveLength(1)
  })
})

describe('cancel', () => {
  it('cancel revokes an active task', () => {
    running('t1', 'w1')
    const ws = connect('w1')
    setStatus('w1', 'busy', NOW)

    expect(cancelTask('t1', 'lead')).toMatchObject({ ok: true, task: { status: 'cancelled' } })

    expect(ws.sent).toEqual([{ type: 'task.revoked', taskId: 't1', reason: 'cancelled' }])
    expect(row('t1')).toMatchObject({ status: 'cancelled', lease_expires_at: null })
    expect(logs('t1', 'cancelled')).toEqual([{ agent_id: 'lead', message: 'was in_progress' }])
    expect(getByAgent('w1')?.status).toBe('idle')
  })

  it('cancel of a pending or review task sends no revoke; a finished task cannot be cancelled', () => {
    insertTask(testDb, { id: 'p', title: 'Pending' })
    insertTask(testDb, { id: 'r', title: 'In review', status: 'review', assigned_to_agent: 'w1' })
    insertTask(testDb, { id: 'c', title: 'Done', status: 'completed' })
    insertTask(testDb, { id: 'f', title: 'Failed', status: 'failed' })
    const ws = connect('w1')
    setStatus('w1', 'busy', NOW)

    expect(cancelTask('p', null).ok).toBe(true)
    expect(cancelTask('r', 'lead').ok).toBe(true)
    expect([row('p').status, row('r').status]).toEqual(['cancelled', 'cancelled'])
    expect(ws.sent).toEqual([])
    expect(getByAgent('w1')?.status).toBe('busy')

    expect(cancelTask('c', 'lead')).toMatchObject({ ok: false, status: 409 })
    expect(cancelTask('f', 'lead')).toMatchObject({ ok: false, status: 409 })
    expect(cancelTask('p', 'lead')).toMatchObject({ ok: false, status: 409 })
    expect(cancelTask('missing', 'lead')).toMatchObject({ ok: false, status: 404 })
    expect([row('c').status, row('f').status]).toEqual(['completed', 'failed'])
  })
})

describe('attempt fence', () => {
  it('a stale-attempt failure is ignored', () => {
    insertTask(testDb, { id: 't1', task_key: 'T1', title: 'Fix login', api_key_owner: 'lead' })
    connect('w1')
    dispatch(NOW)
    expect(failAttempt('t1', 'w1', 'tests red', 1).ok).toBe(true)
    // the same worker got attempt 2 straight back
    expect(row('t1')).toMatchObject({ status: 'assigned', assigned_to_agent: 'w1', attempt: 2, fail_count: 1 })
    const before = row('t1')

    // a re-sent failure of attempt 1, after a reconnect
    expect(failAttempt('t1', 'w1', 'x', 1)).toMatchObject({ ok: false, status: 409 })

    expect(row('t1')).toEqual(before)
    expect(row('t1')).toMatchObject({ status: 'assigned', fail_count: 1, escalated_at: null })
    expect(notifications()).toEqual([])
    expect(logs('t1', 'ignored')).toEqual([{ agent_id: 'w1', message: 'fail ignored: attempt 1 is stale, the task is on attempt 2' }])
  })

  it('a stale-attempt quota report is ignored', () => {
    running('t1', 'w1', { attempt: 2 })
    connect('w1')
    const before = row('t1')

    expect(quotaExhausted('t1', 'w1', quotaMsg('t1', { attempt: 1 }), NOW)).toMatchObject({ ok: false, status: 409 })

    expect(row('t1')).toEqual(before)
    expect(quotaRows()).toEqual([])
    expect(logs('t1', 'ignored')).toHaveLength(1)
  })

  it('a stale-attempt decline is ignored', () => {
    running('t1', 'w1', { attempt: 2 })
    connect('w1')
    setStatus('w1', 'busy', NOW)
    const before = row('t1')

    expect(declineTask('t1', 'w1', 'no gpu here', 1)).toMatchObject({ ok: false, status: 409 })

    expect(row('t1')).toEqual(before)
    expect(getByAgent('w1')?.status).toBe('busy')
    expect(logs('t1', 'ignored')).toHaveLength(1)
  })

  it('a stale-attempt completion is ignored, completed or failed', () => {
    running('t1', 'w1', { attempt: 2 })
    connect('w1')
    const before = row('t1')

    expect(completeTask('t1', 'w1', 'completed', { summary: 'done' }, 1)).toMatchObject({ ok: false, status: 409 })
    expect(completeTask('t1', 'w1', 'failed', { summary: 'red', error: 'boom' }, 1)).toMatchObject({ ok: false, status: 409 })

    expect(row('t1')).toEqual(before)
    expect(logs('t1', 'ignored').map((l) => l.message)).toEqual([
      'complete ignored: attempt 1 is stale, the task is on attempt 2',
      'fail ignored: attempt 1 is stale, the task is on attempt 2',
    ])
  })

  it('a matching attempt still works', () => {
    for (const id of ['a', 'b', 'c', 'd']) running(id, 'w1', { attempt: 2 })
    connect('w1')

    expect(failAttempt('a', 'w1', 'red', 2).ok).toBe(true)
    expect(quotaExhausted('b', 'w1', quotaMsg('b', { attempt: 2 }), NOW).ok).toBe(true)
    expect(declineTask('c', 'w1', 'no gpu here', 2).ok).toBe(true)
    expect(completeTask('d', 'w1', 'completed', { summary: 'done' }, 2).ok).toBe(true)

    expect(row('a').fail_count).toBe(1)
    expect(quotaRows()).toHaveLength(1)
    expect(context('c').declined).toEqual(['w1'])
    expect(row('d').status).toBe('completed')
    expect(testDb.prepare("SELECT COUNT(*) FROM conductor_task_logs WHERE action = 'ignored'").pluck().get()).toBe(0)
  })
})

describe('transactions', () => {
  it('a lifecycle step refuses to run inside an open transaction, before anything is sent', () => {
    running('t1', 'w1')
    const ws = connect('w1')
    const message = 'lifecycle: must not run inside a db transaction'

    expect(() => testDb.transaction(() => failAttempt('t1', 'w1', 'x'))()).toThrow(message)
    expect(() => testDb.transaction(() => completeTask('t1', null, 'completed', { summary: 'done' }))()).toThrow(message)
    expect(() => testDb.transaction(() => cancelTask('t1', 'lead'))()).toThrow(message)

    expect(row('t1')).toMatchObject({ status: 'in_progress', fail_count: 0 })
    expect(ws.sent).toEqual([])
  })
})
