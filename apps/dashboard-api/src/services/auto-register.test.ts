import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from '../conductor/testing.js'

let testDb: Database.Database
vi.mock('../db/client.js', () => ({ get db() { return testDb } }))

const indexer = vi.hoisted(() => ({
  checkRemoteAccess: vi.fn(),
  requestIndexing: vi.fn(),
}))
vi.mock('./indexer.js', () => indexer)

import { autoRegisterProject, indexRegisteredProject } from './auto-register.js'

const SAVED = 'tok-saved'

function row(id: string) {
  return testDb.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown>
}

function projectCount(): number {
  return (testDb.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n
}

beforeEach(() => {
  vi.clearAllMocks()
  testDb = createTestDb()
  // Added by the runtime migration in db/client.ts, not by schema.sql.
  testDb.exec('ALTER TABLE index_jobs ADD COLUMN triggered_by TEXT')
  testDb.exec(`
    INSERT INTO organizations (id, name, slug, created_at) VALUES
      ('org-a', 'Alpha', 'alpha', '2026-01-01T00:00:00Z'),
      ('org-b', 'Beta',  'beta',  '2026-01-02T00:00:00Z');
    INSERT INTO projects (id, org_id, name, slug, git_repo_url, git_username, git_token, updated_at) VALUES
      ('p-a1', 'org-a', 'A1', 'a1', 'https://github.com/acme/a1.git', 'Acme', '${SAVED}', '2026-02-01T00:00:00Z'),
      ('p-b1', 'org-b', 'B1', 'b1', 'https://github.com/acme/b1.git', NULL, NULL, '2026-01-01T00:00:00Z'),
      ('p-b2', 'org-b', 'B2', 'b2', 'git@github.com:ACME/b2.git',     NULL, NULL, '2026-01-01T00:00:00Z');
  `)
})

describe('autoRegisterProject', () => {
  it('registers a repo of a saved account in the org holding most of that owner\'s repos, with the saved token', () => {
    const reg = autoRegisterProject('https://github.com/acme/sandbox.git')
    expect(reg).toEqual({
      projectId: expect.stringMatching(/^proj-/),
      orgId: 'org-b',
      orgName: 'Beta',
      name: 'sandbox',
      repoUrl: 'https://github.com/acme/sandbox.git',
      username: 'Acme',
    })
    expect(row(reg!.projectId)).toMatchObject({
      org_id: 'org-b',
      name: 'sandbox',
      slug: 'sandbox',
      git_repo_url: 'https://github.com/acme/sandbox.git',
      git_provider: 'github',
      git_username: 'Acme',
      git_token: SAVED,
    })
    expect(JSON.stringify(reg)).not.toContain(SAVED)
  })

  it('stores the https URL for an ssh remote, and matches the owner case-insensitively', () => {
    const reg = autoRegisterProject('git@github.com:ACME/sandbox.git')
    expect(row(reg!.projectId).git_repo_url).toBe('https://github.com/ACME/sandbox.git')
  })

  it('falls back to the org of the project the token was saved on', () => {
    testDb.exec("UPDATE projects SET git_repo_url = 'https://github.com/bigco/x.git' WHERE id IN ('p-b1', 'p-b2')")
    expect(autoRegisterProject('https://github.com/acme/sandbox')?.orgId).toBe('org-a')
  })

  it('uses a token saved without a username for another repo of the same owner, and keeps it without one', () => {
    testDb.exec("UPDATE projects SET git_username = NULL WHERE id = 'p-a1'")
    const reg = autoRegisterProject('https://github.com/acme/sandbox.git')
    expect(reg?.username).toBe('acme')
    expect(row(reg!.projectId)).toMatchObject({ git_username: null, git_token: SAVED })
  })

  it.each([
    ['another owner', 'https://github.com/bob/sandbox.git'],
    ['another host', 'https://gitlab.com/acme/sandbox.git'],
    ['a bare name', 'sandbox'],
  ])('leaves %s alone', (_label, repo) => {
    expect(autoRegisterProject(repo)).toBeNull()
    expect(projectCount()).toBe(3)
  })

  it('names the project owner/name when the org already has that slug', () => {
    testDb.exec("INSERT INTO projects (id, org_id, name, slug) VALUES ('p-taken', 'org-b', 'Sandbox.', 'sandbox')")
    const reg = autoRegisterProject('https://github.com/acme/sandbox.git')
    expect(reg?.name).toBe('acme/sandbox')
    expect(row(reg!.projectId).slug).toBe('acme-sandbox')
  })
})

describe('indexRegisteredProject', () => {
  it('queues the remote\'s default branch once the token can read it', async () => {
    indexer.checkRemoteAccess.mockResolvedValue({ ok: true, branch: 'master' })
    await indexRegisteredProject('p-a1')
    expect(indexer.requestIndexing).toHaveBeenCalledWith('p-a1', 'master', { triggeredBy: 'auto-register' })
    expect(row('p-a1').default_branch).toBe('master')
  })

  it('records a failed job that says the token cannot read the repo, and indexes nothing', async () => {
    indexer.checkRemoteAccess.mockResolvedValue({ ok: false, error: "fatal: repository 'https://github.com/acme/a1.git/' not found" })
    await indexRegisteredProject('p-a1')
    expect(indexer.requestIndexing).not.toHaveBeenCalled()
    const job = testDb.prepare('SELECT * FROM index_jobs WHERE project_id = ?').get('p-a1') as Record<string, unknown>
    expect(job).toMatchObject({ status: 'error', branch: null, triggered_by: 'auto-register' })
    expect(job.error).toContain('The token saved for Acme cannot read github.com/acme/a1')
    expect(job.error).toContain('not found')
  })
})
