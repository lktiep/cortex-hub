import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { EngineInfo } from '@cortex/shared-types'
import { createTestDb, fakeSocket, insertTask, type FakeSocket } from './testing.js'

let testDb: Database.Database
vi.mock('../db/client.js', () => ({ get db() { return testDb } }))

import { addConnection, removeConnection, resetRegistry, updateConnection } from './registry.js'
import { isoSeconds, type TaskRow } from './rows.js'
import { runSchedulerTick, scheduleConductor } from './scheduler.js'

const START = Date.UTC(2026, 9, 16, 12, 0, 0)
const MIN = 60_000
const HOUR = 3600_000
const CLAUDE: EngineInfo = { executor: 'claude', models: ['opus', 'sonnet'], defaultModel: 'opus' }
const NOTHING = { leasesBackfilled: 0, reclaimed: [], quotaDeleted: 0 }

function connect(agentId: string, ready = true): { ws: FakeSocket; connectionId: string } {
  const ws = fakeSocket()
  const r = addConnection({
    ws, agentId, apiKeyOwner: 'o1', apiKeyProjectId: null, hostname: `host-${agentId}`,
    ide: null, platform: null, capabilities: [],
  }, START)
  if (!r.ok) throw new Error(r.reason)
  updateConnection(r.conn.connectionId, { protocol: 2, engines: [CLAUDE], projectId: null, ready })
  return { ws, connectionId: r.conn.connectionId }
}

/** A task running on `agentId` (null: an active row without an assignee), its lease 24 h from START. */
function running(id: string, agentId: string | null, extra: Partial<TaskRow> = {}): TaskRow {
  return insertTask(testDb, {
    id, title: 'Fix login', api_key_owner: 'lead', status: 'in_progress', assigned_to_agent: agentId,
    assigned_at: isoSeconds(START), last_agent: agentId, attempt: 1, lease_expires_at: isoSeconds(START + 24 * HOUR),
    ...extra,
  })
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

function quotaRows(): { host: string; model: string }[] {
  return testDb.prepare('SELECT host, model FROM conductor_quota ORDER BY host').all() as { host: string; model: string }[]
}

beforeEach(() => {
  testDb = createTestDb()
  resetRegistry(START)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('runSchedulerTick', () => {
  it('expired lease is revoked and counted', () => {
    running('t1', 'w1', { lease_expires_at: isoSeconds(START + HOUR) })
    // open but not yet registered: it hears the revoke, and the dispatch pass cannot hand t1 straight back
    const { ws } = connect('w1', false)

    expect(runSchedulerTick(START + HOUR - 1000)).toEqual(NOTHING)
    expect(row('t1').status).toBe('in_progress')

    expect(runSchedulerTick(START + HOUR)).toEqual({ ...NOTHING, reclaimed: ['t1'] })

    expect(ws.sent).toEqual([{ type: 'task.revoked', taskId: 't1', reason: 'lease expired' }])
    expect(row('t1')).toMatchObject({
      status: 'pending', assigned_to_agent: null, lease_expires_at: null, fail_count: 1, attempt: 1, last_agent: 'w1',
    })
    expect(logs('t1', 'returned')).toEqual([{ agent_id: 'w1', message: 'failed: lease expired' }])
  })

  it('offline worker loses its task after 30 min', () => {
    running('t1', 'w1')
    running('t2', 'w2')
    // the 30 min count from the disconnect, not from the registry's start
    removeConnection(connect('w1').connectionId, START + 10 * MIN)
    // a connected worker is never offline, however quiet
    connect('w2')

    expect(runSchedulerTick(START + 31 * MIN)).toEqual(NOTHING)
    expect(row('t1').status).toBe('in_progress')

    expect(runSchedulerTick(START + 41 * MIN)).toEqual({ ...NOTHING, reclaimed: ['t1'] })

    expect(row('t1')).toMatchObject({ status: 'pending', assigned_to_agent: null, fail_count: 1 })
    expect(logs('t1', 'returned')).toEqual([{ agent_id: 'w1', message: 'failed: worker offline' }])
    expect(row('t2')).toMatchObject({ status: 'in_progress', assigned_to_agent: 'w2', fail_count: 0 })
  })

  it('pull tasks are not reclaimed as offline', () => {
    // as pickForPull leaves it: the caller has no worker connection
    running('t1', 'lead-agent', { status: 'accepted', context: JSON.stringify({ pull: true }) })

    expect(runSchedulerTick(START + 31 * MIN)).toEqual(NOTHING)
    expect(row('t1')).toMatchObject({ status: 'accepted', assigned_to_agent: 'lead-agent', fail_count: 0 })

    // its lease still applies
    expect(runSchedulerTick(START + 24 * HOUR)).toEqual({ ...NOTHING, reclaimed: ['t1'] })
    expect(row('t1')).toMatchObject({ status: 'pending', fail_count: 1 })
  })

  it('an active task without an assignee is reclaimed only by its lease', () => {
    running('t1', null, { status: 'assigned' })

    expect(runSchedulerTick(START + 31 * MIN)).toEqual(NOTHING)
    expect(row('t1').status).toBe('assigned')

    expect(runSchedulerTick(START + 24 * HOUR)).toEqual({ ...NOTHING, reclaimed: ['t1'] })
    expect(row('t1')).toMatchObject({ status: 'pending', fail_count: 1 })
    expect(logs('t1', 'returned')).toEqual([{ agent_id: null, message: 'failed: lease expired' }])
  })

  it('restart: backfills leases and waits the full offline window', () => {
    const T = START + 2 * HOUR
    resetRegistry(T)
    running('t1', 'w1', { lease_expires_at: null })
    // only active tasks hold a lease
    insertTask(testDb, { id: 'p', title: 'Pending' })
    insertTask(testDb, { id: 'r', title: 'In review', status: 'review', assigned_to_agent: 'w1' })

    expect(runSchedulerTick(T + MIN)).toEqual({ ...NOTHING, leasesBackfilled: 1 })
    expect(row('t1')).toMatchObject({ status: 'in_progress', lease_expires_at: isoSeconds(T + MIN + 24 * HOUR) })
    expect([row('p').lease_expires_at, row('r').lease_expires_at]).toEqual([null, null])

    expect(runSchedulerTick(T + 31 * MIN)).toEqual({ ...NOTHING, reclaimed: ['t1'] })
    expect(row('t1')).toMatchObject({ status: 'pending', fail_count: 1 })
    expect(logs('t1', 'returned')).toEqual([{ agent_id: 'w1', message: 'failed: worker offline' }])
  })

  it('a task reclaimed for its lease is not reclaimed again as offline', () => {
    running('t1', 'w1', { lease_expires_at: isoSeconds(START + HOUR) })

    expect(runSchedulerTick(START + HOUR)).toEqual({ ...NOTHING, reclaimed: ['t1'] })
    expect(row('t1')).toMatchObject({ status: 'pending', fail_count: 1 })
    expect(logs('t1', 'returned').map((l) => l.message)).toEqual(['failed: lease expired'])
  })

  it('a second reclaim escalates once', () => {
    running('t1', 'w1', { task_key: 'T1', lease_expires_at: isoSeconds(START + HOUR) })
    const { ws } = connect('w1')

    // the first reclaim's dispatch pass hands t1 straight back to w1, with a new lease
    expect(runSchedulerTick(START + HOUR)).toEqual({ ...NOTHING, reclaimed: ['t1'] })
    expect(row('t1')).toMatchObject({
      status: 'assigned', assigned_to_agent: 'w1', attempt: 2, fail_count: 1, escalated_at: null,
      lease_expires_at: isoSeconds(START + 25 * HOUR),
    })

    expect(runSchedulerTick(START + 25 * HOUR)).toEqual({ ...NOTHING, reclaimed: ['t1'] })

    // escalated, so the dispatch pass leaves it pending
    expect(row('t1')).toMatchObject({ status: 'pending', assigned_to_agent: null, attempt: 2, fail_count: 2 })
    expect(row('t1').escalated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(logs('t1', 'escalated')).toEqual([{ agent_id: 'w1', message: '2 failures' }])
    expect(notifications()).toEqual([{
      recipient: 'lead', task_id: 't1', kind: 'escalated',
      message: 'T1 "Fix login" needs you: 2 failures — last: lease expired. Clear with cortex_task_route clearEscalation.',
    }])
    expect(ws.sent.map((m) => (m as { type: string }).type)).toEqual(['task.revoked', 'task.assigned', 'task.revoked'])

    // nothing left to reclaim, so nothing more is counted or sent
    expect(runSchedulerTick(START + 26 * HOUR)).toEqual(NOTHING)
    expect(row('t1').fail_count).toBe(2)
    expect(notifications()).toHaveLength(1)
  })

  it('expired quota rows are deleted and the waiting task dispatches', () => {
    insertTask(testDb, { id: 't1', title: 'Fix login', executor: 'claude', model: 'opus', fallback: '[]' })
    const { ws } = connect('w1')
    testDb.prepare('INSERT INTO conductor_quota (host, executor, model, exhausted_until) VALUES (?, ?, ?, ?), (?, ?, ?, ?)')
      .run('host-w1', 'claude', 'opus', isoSeconds(START + HOUR), 'host-w9', 'claude', 'sonnet', isoSeconds(START + 2 * HOUR))

    expect(runSchedulerTick(START + HOUR - 1000)).toEqual(NOTHING)
    expect(row('t1')).toMatchObject({ status: 'pending', wait_reason: 'capacity', wait_until: isoSeconds(START + HOUR) })

    expect(runSchedulerTick(START + HOUR)).toEqual({ ...NOTHING, quotaDeleted: 1 })

    expect(quotaRows()).toEqual([{ host: 'host-w9', model: 'sonnet' }])
    expect(row('t1')).toMatchObject({
      status: 'assigned', assigned_to_agent: 'w1', wait_reason: null, lease_expires_at: isoSeconds(START + 25 * HOUR),
    })
    expect(ws.sent).toMatchObject([{ type: 'task.assigned', taskId: 't1' }])
  })

  it('a reclaim that throws is logged and the tick goes on', () => {
    running('bad', 'w1', { lease_expires_at: isoSeconds(START) })
    running('good', 'w2', { lease_expires_at: isoSeconds(START) })
    testDb.exec("CREATE TRIGGER fail_bad BEFORE UPDATE ON conductor_tasks WHEN OLD.id = 'bad' BEGIN SELECT RAISE(ABORT, 'boom'); END")
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    expect(runSchedulerTick(START + MIN)).toEqual({ ...NOTHING, reclaimed: ['good'] })

    expect(row('bad')).toMatchObject({ status: 'in_progress', fail_count: 0 })
    expect(row('good')).toMatchObject({ status: 'pending', fail_count: 1 })
    expect(error).toHaveBeenCalledTimes(1)
    expect(error.mock.calls[0]?.[0]).toContain('bad')
  })
})

describe('scheduleConductor', () => {
  it('ticks on its interval, logs a failing tick, and stops', () => {
    vi.useFakeTimers()
    vi.setSystemTime(START)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    running('t1', 'w1', { lease_expires_at: null })
    testDb.exec("CREATE TRIGGER no_lease BEFORE UPDATE OF lease_expires_at ON conductor_tasks BEGIN SELECT RAISE(ABORT, 'disk full'); END")

    const stop = scheduleConductor(MIN)
    vi.advanceTimersByTime(MIN)
    expect(error).toHaveBeenCalledTimes(1)
    expect(row('t1').lease_expires_at).toBeNull()

    // the failure did not stop the timer
    testDb.exec('DROP TRIGGER no_lease')
    vi.advanceTimersByTime(MIN)
    expect(row('t1').lease_expires_at).toBe(isoSeconds(START + 2 * MIN + 24 * HOUR))

    stop()
    expect(vi.getTimerCount()).toBe(0)
    testDb.prepare('UPDATE conductor_tasks SET lease_expires_at = NULL').run()
    vi.advanceTimersByTime(10 * MIN)
    expect(row('t1').lease_expires_at).toBeNull()
  })
})
