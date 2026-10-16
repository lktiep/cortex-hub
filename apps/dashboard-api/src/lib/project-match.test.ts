import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from '../conductor/testing.js'

let testDb: Database.Database
vi.mock('../db/client.js', () => ({ get db() { return testDb } }))

import { findProjectByRepo, normalizeRepo } from './project-match.js'

describe('findProjectByRepo', () => {
  beforeEach(() => {
    testDb = createTestDb()
    testDb.prepare("INSERT INTO organizations (id, name, slug) VALUES ('org-1', 'Org', 'org')").run()
    testDb.prepare(
      `INSERT INTO projects (id, org_id, name, slug, git_repo_url, default_branch)
       VALUES ('proj-1', 'org-1', 'Cortex Hub', 'cortex-hub', 'https://github.com/lktiep/cortex-hub.git', 'master')`,
    ).run()
  })

  const expected = { id: 'proj-1', name: 'Cortex Hub', orgId: 'org-1', defaultBranch: 'master' }

  it.each([
    'https://github.com/lktiep/cortex-hub.git',
    'git@github.com:lktiep/cortex-hub.git',
    'https://github.com/lktiep/cortex-hub',
    'cortex-hub',
  ])('matches %s', (repo) => {
    expect(findProjectByRepo(repo)).toEqual(expected)
  })

  it('returns null for an unknown repo', () => {
    expect(findProjectByRepo('https://github.com/other/unknown.git')).toBeNull()
  })

  it('normalizes trailing .git and slash', () => {
    expect(normalizeRepo('https://x/y/z.git')).toBe('https://x/y/z')
    expect(normalizeRepo('https://x/y/z/')).toBe('https://x/y/z')
  })
})
