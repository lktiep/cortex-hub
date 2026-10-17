import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from '../conductor/testing.js'

let testDb: Database.Database
vi.mock('../db/client.js', () => ({ get db() { return testDb } }))
vi.mock('./mem9-proxy.js', () => ({ getMem9: vi.fn() }))

import { Hono } from 'hono'
import { orgsRouter, projectsRouter } from './organizations.js'

const app = new Hono()
app.route('/api/orgs', orgsRouter)
app.route('/api/projects', projectsRouter)

const SAVED = 'tok-saved'

function send(method: string, path: string, body?: Record<string, unknown>) {
  return app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
}

function tokenOf(id: string): string | null {
  return (testDb.prepare('SELECT git_token FROM projects WHERE id = ?').get(id) as { git_token: string | null }).git_token
}

beforeEach(() => {
  testDb = createTestDb()
  testDb.exec(`
    INSERT INTO organizations (id, name, slug) VALUES ('org-1', 'Org', 'org');
    INSERT INTO projects (id, org_id, name, slug, git_repo_url, git_username, git_token) VALUES
      ('p-saved', 'org-1', 'Saved', 'saved', 'https://github.com/acme/saved.git', 'Acme', '${SAVED}'),
      ('p-bare',  'org-1', 'Bare',  'bare',  'https://github.com/acme/bare.git',  NULL,   NULL);
  `)
})

describe('GET /api/projects/git-accounts', () => {
  it('lists saved accounts with the projects that use them, never the token', async () => {
    const res = await app.request('/api/projects/git-accounts?host=github.com')
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain(SAVED)
    expect(JSON.parse(text)).toEqual({
      accounts: [{ host: 'github.com', username: 'Acme', projects: [{ id: 'p-saved', name: 'Saved' }], updatedAt: expect.any(String) }],
    })
  })
})

describe('POST /api/orgs/:id/projects with reuseGitToken', () => {
  it('copies the saved token for that username on that host, without returning it', async () => {
    const res = await send('POST', '/api/orgs/org-1/projects', {
      name: 'New', gitRepoUrl: 'https://github.com/acme/new', gitUsername: 'acme', reuseGitToken: true,
    })
    expect(res.status).toBe(201)
    const text = await res.text()
    expect(text).not.toContain(SAVED)
    const { id, hasGitToken } = JSON.parse(text) as { id: string; hasGitToken: boolean }
    expect(hasGitToken).toBe(true)
    expect(tokenOf(id)).toBe(SAVED)
  })

  it('keeps a token that was typed', async () => {
    const res = await send('POST', '/api/orgs/org-1/projects', {
      name: 'Typed', gitRepoUrl: 'https://github.com/acme/typed', gitUsername: 'acme', gitToken: 'tok-typed', reuseGitToken: true,
    })
    const { id } = await res.json() as { id: string }
    expect(tokenOf(id)).toBe('tok-typed')
  })

  it('refuses when nothing is saved for that username', async () => {
    const res = await send('POST', '/api/orgs/org-1/projects', {
      name: 'Other', gitRepoUrl: 'https://github.com/bob/other', gitUsername: 'bob', reuseGitToken: true,
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'No saved token for bob on github.com' })
    expect(testDb.prepare("SELECT COUNT(*) AS n FROM projects WHERE name = 'Other'").get()).toEqual({ n: 0 })
  })

  it('refuses without a username', async () => {
    const res = await send('POST', '/api/orgs/org-1/projects', {
      name: 'Nameless', gitRepoUrl: 'https://github.com/acme/nameless', reuseGitToken: true,
    })
    expect(res.status).toBe(400)
  })
})

describe('PUT /api/projects/:id with reuseGitToken', () => {
  it('copies the saved token, taking the URL the project already has', async () => {
    const res = await send('PUT', '/api/projects/p-bare', { gitUsername: 'ACME', reuseGitToken: true })
    expect(res.status).toBe(200)
    expect(await res.text()).not.toContain(SAVED)
    expect(tokenOf('p-bare')).toBe(SAVED)
  })

  it('refuses when nothing is saved for that username', async () => {
    const res = await send('PUT', '/api/projects/p-bare', { gitUsername: 'bob', reuseGitToken: true })
    expect(res.status).toBe(400)
    expect(tokenOf('p-bare')).toBeNull()
  })
})
