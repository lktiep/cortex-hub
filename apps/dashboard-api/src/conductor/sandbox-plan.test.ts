import { beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import type { TreeCreateRequest } from '@cortex/shared-types'
import { createTestDb } from './testing.js'

let testDb: Database.Database
vi.mock('../db/client.js', () => ({ get db() { return testDb } }))

import { resetRegistry } from './registry.js'
import { createTree } from './tree.js'

// The sample plans in examples/conductor-sandbox must keep passing the hub's own validator.
const read = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as T
const plan = (name: string) => read<Pick<TreeCreateRequest, 'tasks'>>(`../../../../examples/conductor-sandbox/${name}`)

beforeEach(() => {
  testDb = createTestDb()
  resetRegistry()
})

function statusByKey(): Record<string, string> {
  const rows = testDb.prepare('SELECT task_key, status FROM conductor_tasks').all() as { task_key: string; status: string }[]
  return Object.fromEntries(rows.map((r) => [r.task_key, r.status]))
}

describe('examples/conductor-sandbox', () => {
  it('plan.json is accepted, with A1 and A2 ready and every other task blocked', () => {
    const r = createTree({ projectId: 'p1', ...plan('plan.json') }, 'owner')
    expect(r).toMatchObject({ ok: true, res: { ready: 2 } })
    const status = statusByKey()
    expect([status.A1, status.A2]).toEqual(['pending', 'pending'])
    // Groups are never blocked: they complete when their children do.
    for (const key of ['A3', 'G1', 'B1', 'B2', 'B3', 'G2']) expect(status[key], key).toBe('blocked')
  })

  it('plan-escalation.json is accepted, with E1 ready', () => {
    expect(createTree({ projectId: 'p1', ...plan('plan-escalation.json') }, 'owner')).toMatchObject({ ok: true, res: { ready: 1 } })
  })

  it('asks only for capabilities the hub keeps', () => {
    const known = new Set(read<{ available_capabilities: { id: string }[] }>('../../../../.cortex/capability-templates.json')
      .available_capabilities.map((c) => c.id))
    const asked = plan('plan.json').tasks.flatMap((t) => t.requiredCapabilities ?? [])
    expect(asked.length).toBeGreaterThan(0)
    for (const cap of asked) expect(known.has(cap), cap).toBe(true)
  })
})
