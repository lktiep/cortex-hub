import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { Hono } from 'hono'
import { createTestDb } from '../conductor/testing.js'

let testDb: Database.Database
vi.mock('../db/client.js', () => ({ get db() { return testDb } }))

import { projectGuard } from './project-guard.js'

/**
 * The guard runs in front of every /api route. It used to resolve a `repo` by
 * its last path segment against slug and name alone, so session start never saw
 * a repo registered under another name, nor an unregistered one it could register.
 */

const app = new Hono()
app.use('/api/*', projectGuard)
app.post('/api/sessions/start', (c) => c.json({ reached: true }))
app.post('/api/intel/search', (c) => c.json({ reached: true }))

function post(path: string, body: Record<string, unknown>) {
  return app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

beforeEach(() => {
  testDb = createTestDb()
  testDb.exec(`
    INSERT INTO organizations (id, name, slug) VALUES ('org-1', 'Org', 'org');
    INSERT INTO projects (id, org_id, name, slug, git_repo_url, enabled) VALUES
      ('p-sandbox', 'org-1', 'Agent Sandbox', 'agent-sandbox', 'https://github.com/acme/conductor-sandbox.git', 1),
      ('p-off',     'org-1', 'Off',           'off',           'https://github.com/acme/off.git',               0);
  `)
})

describe('projectGuard', () => {
  it.each([
    'https://github.com/acme/conductor-sandbox.git',
    'https://github.com/acme/conductor-sandbox',
    'git@github.com:acme/conductor-sandbox.git',
  ])('lets session start through for %s, registered under another name', async (repo) => {
    const res = await post('/api/sessions/start', { repo, agentId: 'a' })
    expect(res.status).toBe(200)
  })

  it('lets session start through for an unregistered repo, which its handler registers or explains', async () => {
    const res = await post('/api/sessions/start', { repo: 'https://github.com/acme/brand-new.git', agentId: 'a' })
    expect(res.status).toBe(200)
  })

  it('still refuses an unregistered repo on other routes', async () => {
    const res = await post('/api/intel/search', { repo: 'https://github.com/acme/brand-new.git' })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('not registered') })
  })

  it('refuses a disabled project, session start included', async () => {
    const res = await post('/api/sessions/start', { repo: 'https://github.com/acme/off.git', agentId: 'a' })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'Cortex Hub is disabled for this project.' })
  })

  it('refuses an unknown projectId', async () => {
    const res = await post('/api/intel/search', { projectId: 'nope' })
    expect(res.status).toBe(403)
  })

  it('passes a request that names no project', async () => {
    expect((await post('/api/intel/search', { query: 'x' })).status).toBe(200)
  })
})
