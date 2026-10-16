import { beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb, insertTask } from './testing.js'

let testDb: Database.Database
vi.mock('../db/client.js', () => ({ get db() { return testDb } }))

import { assignedMsg, branchFor, slugify } from './messages.js'

beforeEach(() => { testDb = createTestDb() })

describe('slugify', () => {
  it('lowercases, dashes non-alphanumerics and trims', () => {
    expect(slugify('  Inventory UI: grid & drag!  ')).toBe('inventory-ui-grid-drag')
  })

  it('drops combining accents instead of dashing them', () => {
    expect(slugify('Café crème brûlée')).toBe('cafe-creme-brulee')
    expect(slugify('Sửa lỗi')).toBe('sua-loi')
  })

  it('keeps at most 40 characters without a trailing dash', () => {
    expect(slugify('a'.repeat(50))).toBe('a'.repeat(40))
    expect(slugify(`${'a'.repeat(39)} b`)).toBe('a'.repeat(39))
  })
})

describe('branchFor', () => {
  it('uses the task key and the title slug', () => {
    const task = insertTask(testDb, { id: 't1', task_key: 'TT3', title: 'Inventory UI: grid & drag' })
    expect(branchFor(task, 'cx/{key}-{slug}')).toBe('cx/TT3-inventory-ui-grid-drag')
  })

  it('falls back to the first 8 characters of the id without its task_ prefix', () => {
    const task = insertTask(testDb, { id: 'task_0123456789abcdef', title: 'Fix login' })
    expect(branchFor(task, 'cx/{key}-{slug}')).toBe('cx/01234567-fix-login')
  })

  it('sanitises the key to [A-Za-z0-9._-]', () => {
    const task = insertTask(testDb, { id: 't1', task_key: 'Phase 1/A', title: 'X' })
    expect(branchFor(task, 'cx/{key}-{slug}')).toBe('cx/Phase-1-A-x')
  })

  it('makes the key a valid git ref component: no "..", no trailing .lock', () => {
    const task = insertTask(testDb, { id: 't1', task_key: 'v1..2.lock', title: 'X' })
    for (const template of ['cx/{key}', 'cx/{key}-{slug}']) {
      const branch = branchFor(task, template)
      expect(branch).not.toContain('..')
      expect(branch.endsWith('.lock')).toBe(false)
    }
    expect(branchFor(task, 'cx/{key}')).toBe('cx/v1.2')
    expect(branchFor(task, 'cx/{key}-{slug}')).toBe('cx/v1.2-x')
  })

  it('strips a leading "." or "-" and trailing dots, and falls back to the id when nothing is left', () => {
    const lead = insertTask(testDb, { id: 't1', task_key: '.-hidden...', title: 'X' })
    expect(branchFor(lead, 'cx/{key}')).toBe('cx/hidden')
    const empty = insertTask(testDb, { id: 'task_0123456789abcdef', task_key: '...lock', title: 'X' })
    expect(branchFor(empty, 'cx/{key}')).toBe('cx/01234567')
  })
})

describe('assignedMsg', () => {
  it('carries reviews, handoff and testCommand from context, plus the flat copy', () => {
    const reviews = [{ at: '2026-10-16T09:00:00Z', by: 'lead', verdict: 'reject', feedback: 'add tests' }]
    const handoff = { branch: 'cx/TT3-inventory-ui', commit: 'abc123', note: 'half done' }
    const task = insertTask(testDb, {
      id: 't1', task_key: 'TT3', title: 'Inventory UI', description: 'Build the grid',
      context: JSON.stringify({ reviews, handoff, testCommand: 'pnpm test', extra: 1 }),
      files: '["src/inventory/"]', branch: 'cx/TT3-inventory-ui', attempt: 2,
      current_route: '{"executor":"agy","model":"gemini-4-argon-low","effort":"low"}',
      lease_expires_at: '2026-10-17T12:00:00Z',
    })
    expect(assignedMsg(task, 'develop', 'task.assigned')).toEqual({
      type: 'task.assigned',
      taskId: 't1',
      title: 'Inventory UI',
      description: 'Build the grid',
      task: {
        id: 't1', key: 'TT3', title: 'Inventory UI', description: 'Build the grid',
        context: { reviews, handoff, testCommand: 'pnpm test', extra: 1 },
        files: ['src/inventory/'],
        branch: 'cx/TT3-inventory-ui', baseBranch: 'develop',
        route: { executor: 'agy', model: 'gemini-4-argon-low', effort: 'low' },
        attempt: 2, leaseExpiresAt: '2026-10-17T12:00:00Z',
        reviews, handoff, testCommand: 'pnpm test',
      },
    })
  })

  it('defaults reviews, handoff and testCommand, and the route to the primary', () => {
    const task = insertTask(testDb, { id: 't1', title: 'T', executor: 'claude', model: 'opus' })
    const msg = assignedMsg(task, 'main', 'task.resumed')
    expect(msg.type).toBe('task.resumed')
    expect(msg.task).toMatchObject({
      key: null, reviews: [], handoff: null, testCommand: null,
      route: { executor: 'claude', model: 'opus', effort: null },
    })
  })
})
