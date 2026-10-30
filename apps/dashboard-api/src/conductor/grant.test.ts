import { beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb, insertTask } from './testing.js'

let testDb: Database.Database
vi.mock('../db/client.js', () => ({ get db() { return testDb } }))

import { connGrant, grantTaskCondition, taskInGrant } from './grant.js'
import { runWithGrant, type KeyGrant } from '../lib/key-grant.js'

const keyA: KeyGrant = { keyId: 'k-a', keyName: 'key-a', orgs: new Set(['org-a']) }

beforeEach(() => {
  testDb = createTestDb()
  testDb.exec(`
    INSERT INTO organizations (id, name, slug) VALUES ('org-a', 'A', 'a'), ('org-b', 'B', 'b');
    INSERT INTO projects (id, org_id, name, slug) VALUES ('p-a', 'org-a', 'Pa', 'pa'), ('p-b', 'org-b', 'Pb', 'pb');
  `)
  insertTask(testDb, { id: 't-a', project_id: 'p-a' })
  insertTask(testDb, { id: 't-b', project_id: 'p-b' })
  insertTask(testDb, { id: 't-own', project_id: null, api_key_owner: 'key-a' })
  insertTask(testDb, { id: 't-other', project_id: null, api_key_owner: 'key-b' })
})

function visibleIds(grant: KeyGrant | undefined): string[] {
  const cond = grantTaskCondition('t.', grant)
  return (testDb.prepare(`SELECT t.id FROM conductor_tasks t WHERE ${cond?.sql ?? '1'} ORDER BY t.id`)
    .all(...(cond?.params ?? [])) as Array<{ id: string }>).map((r) => r.id)
}

describe('conductor task grant', () => {
  it('a bound key sees its organizations\' tasks and the project-less ones its key created', () => {
    expect(visibleIds(keyA)).toEqual(['t-a', 't-own'])
    expect(taskInGrant({ project_id: 'p-a', api_key_owner: null }, keyA)).toBe(true)
    expect(taskInGrant({ project_id: 'p-b', api_key_owner: 'key-a' }, keyA)).toBe(false)
    expect(taskInGrant({ project_id: null, api_key_owner: 'key-b' }, keyA)).toBe(false)
  })

  it('no grant, or an unbound key, sees every task', () => {
    expect(visibleIds(undefined)).toEqual(['t-a', 't-b', 't-other', 't-own'])
    expect(visibleIds({ keyId: 'k-u', keyName: 'key-u', orgs: null })).toEqual(['t-a', 't-b', 't-other', 't-own'])
    expect(taskInGrant({ project_id: 'p-b', api_key_owner: null })).toBe(true)
  })

  it('reads the request\'s grant when none is passed', () => {
    expect(runWithGrant(keyA, () => taskInGrant({ project_id: 'p-b', api_key_owner: null }))).toBe(false)
    expect(runWithGrant(keyA, () => grantTaskCondition())).toBeDefined()
  })

  it('a key bound only to deleted organizations sees only its own project-less tasks', () => {
    expect(visibleIds({ keyId: 'k-z', keyName: 'key-a', orgs: new Set() })).toEqual(['t-own'])
  })

  it('a worker socket carries its key\'s grant, or none when the key is unbound', () => {
    expect(connGrant({ apiKeyOwner: 'key-a', apiKeyOrgs: new Set(['org-a']) })).toEqual({ keyName: 'key-a', orgs: new Set(['org-a']) })
    expect(connGrant({ apiKeyOwner: 'key-u', apiKeyOrgs: null })).toBeUndefined()
  })
})
