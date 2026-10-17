import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from '../conductor/testing.js'

let testDb: Database.Database
vi.mock('../db/client.js', () => ({ get db() { return testDb } }))

import { parseRepoUrl, gitProviderForHost, httpsRepoUrl, listGitAccounts, savedTokenFor } from './git-credentials.js'

describe('parseRepoUrl', () => {
  it.each([
    ['https://github.com/acme/hub.git', { host: 'github.com', owner: 'acme', name: 'hub', path: 'acme/hub' }],
    ['https://github.com/acme/hub/', { host: 'github.com', owner: 'acme', name: 'hub', path: 'acme/hub' }],
    ['https://someone@GitHub.com/Acme/Hub', { host: 'github.com', owner: 'Acme', name: 'Hub', path: 'Acme/Hub' }],
    ['git@github.com:acme/hub.git', { host: 'github.com', owner: 'acme', name: 'hub', path: 'acme/hub' }],
    ['ssh://git@github.com/acme/hub.git', { host: 'github.com', owner: 'acme', name: 'hub', path: 'acme/hub' }],
    ['https://gitlab.example.com/group/sub/hub.git', { host: 'gitlab.example.com', owner: 'group', name: 'hub', path: 'group/sub/hub' }],
  ])('parses %s', (url, expected) => {
    expect(parseRepoUrl(url)).toEqual(expected)
  })

  it.each(['', 'cortex-hub', 'https://github.com/acme', 'file:///tmp/hub', 'not a url'])('rejects %s', (url) => {
    expect(parseRepoUrl(url)).toBeNull()
  })
})

describe('gitProviderForHost', () => {
  it('names the hosted providers and nothing else', () => {
    expect(gitProviderForHost('github.com')).toBe('github')
    expect(gitProviderForHost('gitlab.com')).toBe('gitlab')
    expect(gitProviderForHost('bitbucket.org')).toBe('bitbucket')
    expect(gitProviderForHost('dev.azure.com')).toBe('azure')
    expect(gitProviderForHost('git.example.com')).toBeNull()
  })
})

describe('httpsRepoUrl', () => {
  it('rewrites an ssh remote to the https clone URL a token works with', () => {
    expect(httpsRepoUrl(parseRepoUrl('git@github.com:acme/hub.git')!)).toBe('https://github.com/acme/hub.git')
  })
})

describe('saved accounts', () => {
  beforeEach(() => {
    testDb = createTestDb()
    testDb.prepare("INSERT INTO organizations (id, name, slug) VALUES ('org-1', 'Org', 'org')").run()
    const add = testDb.prepare(
      `INSERT INTO projects (id, org_id, name, slug, git_repo_url, git_username, git_token, updated_at)
       VALUES (?, 'org-1', ?, ?, ?, ?, ?, ?)`,
    )
    add.run('p-old', 'Old', 'old', 'https://github.com/acme/old.git', 'acme', 'tok-old', '2026-01-01T00:00:00Z')
    add.run('p-new', 'New', 'new', 'git@github.com:acme/new.git', 'Acme', 'tok-new', '2026-02-01T00:00:00Z')
    add.run('p-lab', 'Lab', 'lab', 'https://gitlab.com/acme/lab.git', 'acme', 'tok-lab', '2026-03-01T00:00:00Z')
    add.run('p-none', 'None', 'none', 'https://github.com/acme/none.git', 'acme', null, '2026-04-01T00:00:00Z')
    // Saved without a username: it counts for the owner of the repo.
    add.run('p-blank', 'Blank', 'blank', 'https://github.com/acme/blank.git', '', 'tok-x', '2026-04-01T00:00:00Z')
    add.run('p-solo', 'Solo', 'solo', 'https://github.com/solo/tool.git', null, 'tok-solo', '2026-01-15T00:00:00Z')
  })

  it('groups projects with a stored token by host and username, newest first, without the token', () => {
    const accounts = listGitAccounts()
    expect(accounts).toEqual([
      {
        host: 'github.com',
        // Named as typed on p-new, though p-blank, saved without a username, is newer.
        username: 'Acme',
        projects: [{ id: 'p-blank', name: 'Blank' }, { id: 'p-new', name: 'New' }, { id: 'p-old', name: 'Old' }],
        updatedAt: '2026-04-01T00:00:00Z',
      },
      { host: 'gitlab.com', username: 'acme', projects: [{ id: 'p-lab', name: 'Lab' }], updatedAt: '2026-03-01T00:00:00Z' },
      { host: 'github.com', username: 'solo', projects: [{ id: 'p-solo', name: 'Solo' }], updatedAt: '2026-01-15T00:00:00Z' },
    ])
    expect(JSON.stringify(accounts)).not.toContain('tok-')
  })

  it('filters by host', () => {
    expect(listGitAccounts('GitHub.com').map((a) => a.host)).toEqual(['github.com', 'github.com'])
  })

  it('returns the newest token saved for a username on that host, case-insensitively', () => {
    // p-blank is newer, but a token saved with the username comes first.
    expect(savedTokenFor('github.com', 'ACME')).toEqual({ account: 'Acme', username: 'Acme', token: 'tok-new', projectId: 'p-new' })
    expect(savedTokenFor('gitlab.com', 'acme')?.token).toBe('tok-lab')
    expect(savedTokenFor('github.com', 'someone-else')).toBeNull()
    expect(savedTokenFor('bitbucket.org', 'acme')).toBeNull()
  })

  it('falls back to a token saved without a username for a repo the account owns', () => {
    expect(savedTokenFor('github.com', 'Solo')).toEqual({ account: 'solo', username: null, token: 'tok-solo', projectId: 'p-solo' })
    testDb.exec("UPDATE projects SET git_token = NULL WHERE id IN ('p-new', 'p-old')")
    expect(savedTokenFor('github.com', 'acme')).toEqual({ account: 'acme', username: null, token: 'tok-x', projectId: 'p-blank' })
  })
})
