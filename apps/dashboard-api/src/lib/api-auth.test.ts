import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, generateKeyPairSync, sign } from 'crypto'
import { Hono } from 'hono'
import type Database from 'better-sqlite3'
import { createTestDb } from '../conductor/testing.js'

let testDb: Database.Database
vi.mock('../db/client.js', () => ({ get db() { return testDb } }))

import { accessVerifier, apiAuth, apiAuthFromEnv, describeApiAuth, isLoopback, type ApiAuthOptions } from './api-auth.js'

const TEAM = 'demo.cloudflareaccess.invalid'
const AUD = 'aud-1'
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'kid-1', alg: 'RS256' }

function b64(v: unknown): string {
  return Buffer.from(JSON.stringify(v)).toString('base64url')
}

function accessToken(claims: Record<string, unknown> = {}, kid = 'kid-1'): string {
  const head = b64({ alg: 'RS256', kid })
  const body = b64({ iss: `https://${TEAM}`, aud: [AUD], exp: Math.floor(Date.now() / 1000) + 600, email: 'dev@example.com', ...claims })
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`
}

const certsFetch = vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] })))

function appWith(opts: Partial<ApiAuthOptions>, remote = '172.18.0.1'): Hono {
  const app = new Hono()
  app.use('/api/*', apiAuth({
    required: true, internalSecret: 'k-sekrit', access: { teamDomain: TEAM, aud: AUD },
    remoteAddress: () => remote, fetchImpl: certsFetch as unknown as typeof fetch, ...opts,
  }))
  app.get('/api/who', (c) => c.json({ owner: c.req.header('X-API-Key-Owner') ?? null }))
  return app
}

async function status(app: Hono, headers: Record<string, string> = {}): Promise<number> {
  return (await app.request('/api/who', { headers })).status
}

beforeEach(() => {
  testDb = createTestDb()
  certsFetch.mockClear()
  const add = testDb.prepare('INSERT INTO api_keys (id, name, key_hash, scope, expires_at) VALUES (?, ?, ?, ?, ?)')
  add.run('k1', 'agent-a', createHash('sha256').update('sk-good').digest('hex'), 'all', null)
  add.run('k2', 'agent-b', createHash('sha256').update('sk-old').digest('hex'), 'all', '2020-01-01T00:00:00Z')
})

describe('apiAuth', () => {
  it('lets everything through when not required', async () => {
    expect(await status(appWith({ required: false }), { 'X-API-Key-Owner': 'anyone' })).toBe(200)
  })

  it('refuses an anonymous caller', async () => {
    const res = await appWith({}).request('/api/who')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: expect.stringContaining('Authentication required') })
  })

  it('trusts loopback and the internal secret, owner included', async () => {
    expect(await (await appWith({}, '127.0.0.1').request('/api/who', { headers: { 'X-API-Key-Owner': 'agent-a' } })).json()).toEqual({ owner: 'agent-a' })
    expect(await status(appWith({}, '::ffff:127.0.0.1'))).toBe(200)
    expect(await status(appWith({}), { 'X-Internal-Secret': 'k-sekrit', 'X-API-Key-Owner': 'agent-a' })).toBe(200)
    expect(await status(appWith({}), { 'X-Internal-Secret': 'wrong' })).toBe(401)
    expect(await status(appWith({ internalSecret: undefined }), { 'X-Internal-Secret': '' })).toBe(401)
  })

  it('takes a valid API key, and an owner only when it is the key\'s', async () => {
    const app = appWith({})
    expect(await status(app, { Authorization: 'Bearer sk-good' })).toBe(200)
    expect(await status(app, { Authorization: 'Bearer sk-good', 'X-API-Key-Owner': 'agent-a' })).toBe(200)
    expect(await status(app, { Authorization: 'Bearer sk-good', 'X-API-Key-Owner': 'agent-b' })).toBe(403)
    expect(await status(app, { Authorization: 'Bearer sk-old' })).toBe(401)
    expect(await status(app, { Authorization: 'Bearer nope' })).toBe(401)
  })

  it('takes a valid Cloudflare Access token, without an owner', async () => {
    const app = appWith({})
    expect(await status(app, { 'Cf-Access-Jwt-Assertion': accessToken() })).toBe(200)
    expect(await status(app, { 'Cf-Access-Jwt-Assertion': accessToken(), 'X-API-Key-Owner': 'agent-a' })).toBe(403)
    expect(await status(app, { 'Cf-Access-Jwt-Assertion': accessToken({ aud: ['other'] }) })).toBe(401)
    expect(await status(app, { 'Cf-Access-Jwt-Assertion': accessToken({ exp: 1 }) })).toBe(401)
    expect(await status(app, { 'Cf-Access-Jwt-Assertion': accessToken({ iss: 'https://evil.invalid' }) })).toBe(401)
    expect(await status(app, { 'Cf-Access-Jwt-Assertion': 'a.b.c' })).toBe(401)
    // Without Access configured the header means nothing.
    expect(await status(appWith({ access: undefined }), { 'Cf-Access-Jwt-Assertion': accessToken() })).toBe(401)
  })

  it('a token whose signature does not match is refused', async () => {
    const [head, body] = accessToken().split('.')
    const forged = b64({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), email: 'admin@example.com' })
    const sig = accessToken().split('.')[2]
    expect(await status(appWith({}), { 'Cf-Access-Jwt-Assertion': `${head}.${forged}.${sig}` })).toBe(401)
  })

  it('answers 503 when the signing keys cannot be fetched', async () => {
    const down = vi.fn(async () => new Response('', { status: 502 }))
    expect(await status(appWith({ fetchImpl: down as unknown as typeof fetch }), { 'Cf-Access-Jwt-Assertion': accessToken() })).toBe(503)
  })
})

describe('accessVerifier', () => {
  it('fetches the keys once, and again for a key it has not seen, at most once a minute', async () => {
    const verify = accessVerifier({ teamDomain: `https://${TEAM}/`, aud: AUD }, certsFetch as unknown as typeof fetch)
    expect(await verify(accessToken())).toBe('dev@example.com')
    expect(await verify(accessToken({ email: undefined, common_name: 'svc.access' }))).toBe('svc.access')
    expect(certsFetch).toHaveBeenCalledTimes(1)
    expect(certsFetch.mock.calls[0]).toEqual([`https://${TEAM}/cdn-cgi/access/certs`, expect.anything()])
    expect(await verify(accessToken({}, 'kid-2'))).toBeNull()
    expect(certsFetch).toHaveBeenCalledTimes(1)
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 61_000)
      expect(await verify(accessToken({}, 'kid-3'))).toBeNull()
      expect(certsFetch).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('config', () => {
  it('reads the environment', () => {
    expect(apiAuthFromEnv({})).toEqual({ required: false, internalSecret: undefined, access: undefined })
    const opts = apiAuthFromEnv({ API_AUTH: 'Required', INTERNAL_API_SECRET: 'k-sekrit', CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD })
    expect(opts).toEqual({ required: true, internalSecret: 'k-sekrit', access: { teamDomain: TEAM, aud: AUD } })
    expect(describeApiAuth(opts)).toBe('API_AUTH=required: /api accepts loopback, API keys, hub-mcp (internal secret), Cloudflare Access')
    expect(describeApiAuth(apiAuthFromEnv({}))).toContain('API_AUTH is off')
  })

  it('knows loopback', () => {
    expect(['127.0.0.1', '::1', '::ffff:127.0.0.1', '172.18.0.1', undefined].map(isLoopback)).toEqual([true, true, true, false, false])
  })
})
