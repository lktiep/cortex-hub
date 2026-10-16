import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from './testing.js'

let testDb: Database.Database

vi.mock('../db/client.js', () => ({
  get db() { return testDb },
}))

import { getConductorConfig, baseBranchFor } from './config.js'
import { isoSeconds } from './rows.js'

function setConfig(key: string, value: string): void {
  testDb.prepare('INSERT OR REPLACE INTO hub_config (key, value) VALUES (?, ?)').run(key, value)
}

beforeEach(() => { testDb = createTestDb() })

describe('getConductorConfig', () => {
  it('defaults', () => {
    expect(getConductorConfig()).toEqual({
      defaultFallback: [{ executor: 'claude', model: 'opus', effort: null }],
      branchTemplate: 'cx/{key}-{slug}',
      offlineReclaimMinutes: 30,
      leaseHours: 24,
    })
  })

  it('reads overrides and ignores bad JSON', () => {
    setConfig('conductor.leaseHours', '2')
    setConfig('conductor.defaultFallback', 'not json')
    const cfg = getConductorConfig()
    expect(cfg.leaseHours).toBe(2)
    expect(cfg.defaultFallback).toEqual([{ executor: 'claude', model: 'opus', effort: null }])
  })
})

describe('baseBranchFor', () => {
  it('prefers conductor.baseBranch', () => {
    setConfig('conductor.baseBranch', 'trunk')
    expect(baseBranchFor(null)).toBe('trunk')
  })

  it('falls back to the project default branch, then main', () => {
    testDb.prepare("INSERT INTO projects (id, org_id, slug, name, default_branch) VALUES ('p1', 'org-default', 'p', 'P', 'develop')").run()
    testDb.prepare("INSERT INTO projects (id, org_id, slug, name) VALUES ('p2', 'org-default', 'q', 'Q')").run()
    expect(baseBranchFor('p1')).toBe('develop')
    expect(baseBranchFor('p2')).toBe('main')
    expect(baseBranchFor(null)).toBe('main')
  })
})

describe('isoSeconds', () => {
  it('drops milliseconds', () => {
    expect(isoSeconds(Date.UTC(2026, 9, 16, 8, 0, 0, 123))).toBe('2026-10-16T08:00:00Z')
  })
})
