import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { createHash } from 'crypto'
import { Hono } from 'hono'
import { createTestDb } from '../conductor/testing.js'

let testDb: Database.Database
vi.mock('../db/client.js', () => ({ get db() { return testDb } }))

import { keysRouter } from './keys.js'

const app = new Hono()
app.route('/api/keys', keysRouter)

function send(method: string, path: string, body: Record<string, unknown>) {
  return app.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

const savedMode = process.env['API_KEY_BINDING']

beforeEach(() => {
  delete process.env['API_KEY_BINDING']
  // Saving a key tells hub-mcp to drop its key cache; nothing listens here.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')))
  testDb = createTestDb()
  testDb.exec(`INSERT INTO organizations (id, name, slug) VALUES ('org-a', 'A', 'a'), ('org-b', 'B', 'b')`)
  testDb.prepare('INSERT INTO api_keys (id, name, key_hash, scope) VALUES (?, ?, ?, ?)')
    .run('k-u', 'key-u', createHash('sha256').update('tok-u').digest('hex'), 'all')
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (savedMode === undefined) delete process.env['API_KEY_BINDING']
  else process.env['API_KEY_BINDING'] = savedMode
})

describe('API key organizations', () => {
  it('binds a new key to the organizations given, and lists them with the binding mode', async () => {
    const created = await send('POST', '/api/keys', { name: 'lead', scope: 'all', orgs: ['org-b', 'org-a', 'org-a'] })
    expect(created.status).toBe(201)
    const { id, key } = await created.json() as { id: string; key: string }

    const list = await (await app.request('/api/keys')).json() as { keys: Array<{ id: string; orgs: string[] }>; binding: string }
    expect(list.binding).toBe('warn')
    expect(list.keys.find((k) => k.id === id)?.orgs).toEqual(['org-a', 'org-b'])
    expect(list.keys.find((k) => k.id === 'k-u')?.orgs).toEqual([])

    const verified = await (await send('POST', '/api/keys/verify', { token: key })).json()
    expect(verified).toMatchObject({ valid: true, keyId: id, orgs: expect.arrayContaining(['org-a', 'org-b']) })
  })

  it('refuses an organization that does not exist, or orgs that are not a list of ids', async () => {
    expect((await send('POST', '/api/keys', { name: 'x', scope: 'all', orgs: ['org-nope'] })).status).toBe(400)
    expect((await send('POST', '/api/keys', { name: 'x', scope: 'all', orgs: 'org-a' })).status).toBe(400)
    expect((await send('PUT', '/api/keys/k-u', { name: 'key-u', scope: 'all', orgs: [1] })).status).toBe(400)
  })

  it('an edit that leaves orgs out keeps them, an empty list unbinds the key', async () => {
    expect(await (await send('PUT', '/api/keys/k-u', { name: 'key-u', scope: 'all', orgs: ['org-a'] })).json())
      .toMatchObject({ orgs: ['org-a'] })
    expect(await (await send('PUT', '/api/keys/k-u', { name: 'renamed', scope: 'all' })).json())
      .toMatchObject({ orgs: ['org-a'] })
    expect(await (await send('PUT', '/api/keys/k-u', { name: 'renamed', scope: 'all', orgs: [] })).json())
      .toMatchObject({ orgs: [] })
  })

  it('verify refuses an unbound key under API_KEY_BINDING=required, and a key bound only to deleted organizations', async () => {
    expect((await send('POST', '/api/keys/verify', { token: 'tok-u' })).status).toBe(200)
    process.env['API_KEY_BINDING'] = 'required'
    expect((await send('POST', '/api/keys/verify', { token: 'tok-u' })).status).toBe(401)
    testDb.exec(`INSERT INTO api_key_orgs (key_id, org_id) VALUES ('k-u', 'org-gone')`)
    const res = await send('POST', '/api/keys/verify', { token: 'tok-u' })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('no longer exist') })
  })

  it('revoking a key drops its organizations', async () => {
    testDb.exec(`INSERT INTO api_key_orgs (key_id, org_id) VALUES ('k-u', 'org-a')`)
    expect((await app.request('/api/keys/k-u', { method: 'DELETE' })).status).toBe(200)
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM api_key_orgs').get()).toEqual({ n: 0 })
  })
})
