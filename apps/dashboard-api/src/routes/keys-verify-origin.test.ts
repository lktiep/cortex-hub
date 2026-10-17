import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createHash } from 'crypto'
import { createTestDb } from '../conductor/testing.js'

let testDb: Database.Database

vi.mock('../db/client.js', () => ({
  get db() { return testDb },
}))

import { Hono } from 'hono'
import { keysRouter } from './keys.js'
import { setupRouter } from './setup.js'
import { detectedMcpOrigin, recordMcpOrigin } from '../lib/mcp-origin.js'

const app = new Hono()
app.route('/api/keys', keysRouter)
app.route('/api/setup', setupRouter)

const TOKEN = 'k-test-1'

function verify(origin?: string, token = TOKEN): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (origin !== undefined) headers['X-Cortex-Public-Origin'] = origin
  return Promise.resolve(app.request('/api/keys/verify', { method: 'POST', headers, body: JSON.stringify({ token }) }))
}

async function settingsMcp(): Promise<{ mcp: string | null; mcpDetected: { url: string; agentId: string | null } | null }> {
  const res = await app.request('/api/setup/settings')
  const body = await res.json() as { externalUrls: { mcp: string | null; mcpDetected: { url: string; agentId: string | null } | null } }
  return body.externalUrls
}

beforeEach(() => {
  testDb = createTestDb()
  testDb.prepare('INSERT INTO api_keys (id, name, key_hash, scope) VALUES (?, ?, ?, ?)')
    .run('key1', 'lead', createHash('sha256').update(TOKEN).digest('hex'), 'all')
  delete process.env.EXTERNAL_MCP_URL
})

afterEach(() => { delete process.env.EXTERNAL_MCP_URL })

describe('MCP origin from key checks', () => {
  it('a valid key with the gateway header records the origin, and settings reports it', async () => {
    expect((await verify('https://mcp.example.com')).status).toBe(200)
    expect(detectedMcpOrigin()).toMatchObject({ url: 'https://mcp.example.com', agentId: 'lead' })
    expect(await settingsMcp()).toMatchObject({ mcp: null, mcpDetected: { url: 'https://mcp.example.com', agentId: 'lead' } })
  })

  it('an invalid key records nothing', async () => {
    expect((await verify('https://mcp.example.com', 'wrong-1')).status).toBe(401)
    expect(detectedMcpOrigin()).toBeNull()
  })

  it('a garbage header records nothing and the key still passes', async () => {
    for (const origin of ['http://mcp.example.com', 'https://10.0.0.5:8318', 'https://mcp.example.com/x', 'not a url']) {
      const res = await verify(origin)
      expect(res.status).toBe(200)
      expect((await res.json() as { valid: boolean }).valid).toBe(true)
    }
    expect(detectedMcpOrigin()).toBeNull()
  })

  it('a key check without the header leaves the last origin in place', async () => {
    await verify('https://mcp.example.com')
    await verify()
    expect(detectedMcpOrigin()?.url).toBe('https://mcp.example.com')
  })

  it('a failure to store never fails the key', async () => {
    testDb.exec('DROP TABLE hub_config')
    const res = await verify('https://mcp.example.com')
    expect(res.status).toBe(200)
    expect((await res.json() as { valid: boolean }).valid).toBe(true)
  })

  it('EXTERNAL_MCP_URL wins: settings leaves the detected origin out', async () => {
    recordMcpOrigin('https://mcp.example.com', 'lead')
    process.env.EXTERNAL_MCP_URL = 'https://pinned.example.com'
    expect(await settingsMcp()).toMatchObject({ mcp: 'https://pinned.example.com', mcpDetected: null })
  })

  it('ignores a stored row that is not a public origin', () => {
    testDb.prepare("INSERT OR REPLACE INTO hub_config (key, value) VALUES ('mcp.detected', ?)").run('{"url":"http://x.example.com"}')
    expect(detectedMcpOrigin()).toBeNull()
    testDb.prepare("INSERT OR REPLACE INTO hub_config (key, value) VALUES ('mcp.detected', ?)").run('not json')
    expect(detectedMcpOrigin()).toBeNull()
  })
})
