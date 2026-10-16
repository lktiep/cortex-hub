import { beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb, insertTask } from './testing.js'

let testDb: Database.Database
vi.mock('../db/client.js', () => ({ get db() { return testDb } }))

import { formatNotification, notifyLead, takeNotifications } from './notify.js'

const count = () => (testDb.prepare('SELECT COUNT(*) AS n FROM conductor_notifications').get() as { n: number }).n

describe('notifications', () => {
  beforeEach(() => { testDb = createTestDb() })

  it('skips tasks without an owner', () => {
    const task = insertTask(testDb, { id: 't1' })
    notifyLead(task, 'capacity', 'x')
    expect(count()).toBe(0)
  })

  it('records task id, kind and message for the owner', () => {
    const task = insertTask(testDb, { id: 't1', api_key_owner: 'lead-key' })
    notifyLead(task, 'escalated', 'hello')
    const row = testDb.prepare('SELECT * FROM conductor_notifications').get() as Record<string, unknown>
    expect(row).toMatchObject({ recipient: 'lead-key', task_id: 't1', kind: 'escalated', message: 'hello', delivered_at: null })
  })

  it('delivers at most five, oldest first, then marks them', () => {
    const task = insertTask(testDb, { id: 't1', api_key_owner: 'lead-key' })
    for (let i = 1; i <= 7; i++) notifyLead(task, 'capacity', `m${i}`)
    expect(takeNotifications('lead-key')).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'])
    expect(takeNotifications('lead-key')).toEqual(['m6', 'm7'])
    expect(takeNotifications('lead-key')).toEqual([])
    const stamp = (testDb.prepare('SELECT delivered_at AS d FROM conductor_notifications WHERE id = 1').get() as { d: string }).d
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })

  it('does not deliver another key\'s rows', () => {
    const task = insertTask(testDb, { id: 't1', api_key_owner: 'lead-key' })
    notifyLead(task, 'capacity', 'mine')
    expect(takeNotifications('other-key')).toEqual([])
    expect(takeNotifications('lead-key')).toEqual(['mine'])
  })
})

describe('formatNotification', () => {
  const task = insertTask(createTestDb(), { id: 'x1', task_key: 'TT3', title: 'Inventory UI' })

  it('review_ready', () => {
    expect(formatNotification('review_ready', task, { prUrl: 'https://github.com/o/r/pull/41', branch: 'cx/b', testOutput: 'ok' }))
      .toBe('TT3 "Inventory UI" is ready for review — https://github.com/o/r/pull/41 (tests attached)')
    expect(formatNotification('review_ready', task, { prUrl: null, branch: 'cx/tt3-inventory-ui', testOutput: '' }))
      .toBe('TT3 "Inventory UI" is ready for review — cx/tt3-inventory-ui')
  })

  it('escalated', () => {
    expect(formatNotification('escalated', task, { count: 2, of: 'failures', reason: 'r'.repeat(250) }))
      .toBe(`TT3 "Inventory UI" needs you: 2 failures — last: ${'r'.repeat(200)}. Clear with cortex_task_route clearEscalation.`)
    expect(formatNotification('escalated', task, { count: 2, of: 'rejections', reason: 'too slow' }))
      .toBe('TT3 "Inventory UI" needs you: 2 rejections — last: too slow. Clear with cortex_task_route clearEscalation.')
  })

  it('capacity', () => {
    expect(formatNotification('capacity', task, { until: '2026-10-16T10:00:00Z' }))
      .toBe('TT3 "Inventory UI" is waiting for capacity: every route is out of quota until 2026-10-16T10:00:00Z.')
  })

  it('no_worker', () => {
    expect(formatNotification('no_worker', task, { routes: 'agy/gemini-4-argon-low → claude/opus' }))
      .toBe('TT3 "Inventory UI" has no connected worker that can run it (agy/gemini-4-argon-low → claude/opus).')
  })

  it('gate_ready', () => {
    expect(formatNotification('gate_ready', { ...task, approver: 'user' }, {}))
      .toBe('TT3 "Inventory UI" is waiting for approval by the user in the dashboard.')
    expect(formatNotification('gate_ready', { ...task, approver: 'lead' }, {}))
      .toBe('TT3 "Inventory UI" is waiting for your approval (cortex_task_review).')
  })
})
