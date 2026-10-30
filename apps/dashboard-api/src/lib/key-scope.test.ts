import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'crypto'
import { Hono } from 'hono'
import type Database from 'better-sqlite3'
import { createTestDb, insertTask } from '../conductor/testing.js'

let testDb: Database.Database
vi.mock('../db/client.js', () => ({ get db() { return testDb } }))

import { keyScope } from './key-scope.js'
import { currentGrant } from './key-grant.js'

// Org A holds p-a, org B holds p-b. key-a is bound to A, key-u to nothing, key-z only to a
// deleted organization.
const app = new Hono()
app.use('/api/*', keyScope)
const reached = (c: { json: (v: unknown) => Response }) => {
  const grant = currentGrant()
  return c.json({ reached: true, orgs: grant?.orgs ? [...grant.orgs] : null })
}
app.post('/api/intel/search', reached)
app.post('/api/sessions/start', reached)
app.post('/api/projects/:id/index', reached)
app.get('/api/projects/:id', reached)
app.get('/api/conductor/:id', reached)
app.post('/api/mem9/search', reached)
app.get('/api/keys', reached)
app.get('/api/metrics/overview-v2', reached)

function call(path: string, keyId: string | null, body?: Record<string, unknown>, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra }
  if (keyId) headers['X-Cortex-Key-Id'] = keyId
  if (body) headers['Content-Type'] = 'application/json'
  return app.request(path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined })
}

const savedMode = process.env['API_KEY_BINDING']

beforeEach(() => {
  delete process.env['API_KEY_BINDING']
  testDb = createTestDb()
  const hash = (t: string) => createHash('sha256').update(t).digest('hex')
  testDb.exec(`
    INSERT INTO organizations (id, name, slug) VALUES ('org-a', 'A', 'a'), ('org-b', 'B', 'b');
    INSERT INTO projects (id, org_id, name, slug, git_repo_url) VALUES
      ('p-a', 'org-a', 'Alpha', 'alpha', 'https://github.com/acme/alpha.git'),
      ('p-b', 'org-b', 'Beta',  'beta',  'https://github.com/acme/beta.git');
    INSERT INTO api_keys (id, name, key_hash, scope) VALUES
      ('k-a', 'key-a', '${hash('tok-a')}', 'all'),
      ('k-u', 'key-u', '${hash('tok-u')}', 'all'),
      ('k-z', 'key-z', '${hash('tok-z')}', 'all');
    INSERT INTO api_key_orgs (key_id, org_id) VALUES ('k-a', 'org-a'), ('k-z', 'org-gone');
  `)
})

afterEach(() => {
  if (savedMode === undefined) delete process.env['API_KEY_BINDING']
  else process.env['API_KEY_BINDING'] = savedMode
})

describe('keyScope', () => {
  it('lets a request without a key through unlimited', async () => {
    const res = await call('/api/projects/p-b', null)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ reached: true, orgs: null })
  })

  it('holds a bound key to its organizations for the rest of the request', async () => {
    const res = await call('/api/intel/search', 'k-a', { projectId: 'p-a', query: 'x' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ reached: true, orgs: ['org-a'] })
  })

  it.each([
    ['a project id', { projectId: 'p-b' }],
    ['a project slug', { project: 'beta' }],
    ['a repo', { repo: 'https://github.com/acme/beta.git' }],
  ])('answers 404 for %s of another organization, as for one that does not exist', async (_, refs) => {
    const res = await call('/api/intel/search', 'k-a', { query: 'x', ...refs })
    expect(res.status).toBe(404)
  })

  it('answers 403 for another organization named outright', async () => {
    expect((await call('/api/intel/search', 'k-a', { query: 'x', org: 'org-b' })).status).toBe(403)
    expect((await call('/api/intel/search', 'k-a', { query: 'x', org: 'org-a' })).status).toBe(200)
  })

  it('checks the project a path names, and a project\'s memories', async () => {
    expect((await call('/api/projects/p-b/index', 'k-a', {})).status).toBe(404)
    expect((await call('/api/projects/p-a/index', 'k-a', {})).status).toBe(200)
    expect((await call('/api/mem9/search', 'k-a', { userId: 'project-p-b:branch-main', query: 'x' })).status).toBe(404)
    expect((await call('/api/mem9/search', 'k-a', { userId: 'project-p-a', query: 'x' })).status).toBe(200)
  })

  it('shows a bound key the tasks of its organizations and the project-less ones it created', async () => {
    insertTask(testDb, { id: 't-b', project_id: 'p-b' })
    insertTask(testDb, { id: 't-own', project_id: null, api_key_owner: 'key-a' })
    insertTask(testDb, { id: 't-other', project_id: null, api_key_owner: 'key-u' })
    expect((await call('/api/conductor/t-b', 'k-a')).status).toBe(404)
    expect((await call('/api/conductor/t-other', 'k-a')).status).toBe(404)
    expect((await call('/api/conductor/t-own', 'k-a')).status).toBe(200)
  })

  it('refuses a bound key the routes that manage or list across the hub', async () => {
    expect((await call('/api/keys', 'k-a')).status).toBe(403)
    expect((await call('/api/projects/p-a', 'k-a')).status).toBe(403)
    expect((await call('/api/keys', 'k-u')).status).toBe(200)
    expect((await call('/api/metrics/overview-v2', 'k-a')).status).toBe(200)
  })

  it('refuses a key it does not know, and one bound only to deleted organizations', async () => {
    expect((await call('/api/projects/p-a', 'k-missing')).status).toBe(401)
    expect((await call('/api/projects/p-a', 'k-z')).status).toBe(401)
  })

  it.each([
    [undefined, 200],
    ['off', 200],
    ['warn', 200],
    ['required', 401],
  ])('with API_KEY_BINDING=%s an unbound key gets %i', async (mode, status) => {
    if (mode) process.env['API_KEY_BINDING'] = mode
    const res = await call('/api/projects/p-b', 'k-u')
    expect(res.status).toBe(status)
    if (status === 200) expect(await res.json()).toEqual({ reached: true, orgs: null })
  })

  it('finds the key from a Bearer token when nothing authenticated the request', async () => {
    const bearer = (t: string) => ({ Authorization: `Bearer ${t}` })
    expect((await call('/api/projects/p-b/index', null, {}, bearer('tok-a'))).status).toBe(404)
    expect((await call('/api/projects/p-a/index', null, {}, bearer('tok-a'))).status).toBe(200)
    expect((await call('/api/projects/p-b/index', null, {}, bearer('tok-unknown'))).status).toBe(200)
  })
})
