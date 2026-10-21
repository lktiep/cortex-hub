import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { invalidateTokenCache } from './middleware/auth.js'
import { refusalStatus, validateWsAuth } from './ws-auth.js'

/**
 * A worker that hears 401 on its handshake stops for good. When the hub restarts, hub-mcp can
 * come up before the dashboard API that verifies keys; that must answer 503, never 401.
 */

const realFetch = globalThis.fetch
const API = 'http://api:4000'

function verifyAnswers(answer: () => Response | Promise<Response>) {
  const fetchMock = vi.fn(async () => answer())
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

const ok = () => new Response(JSON.stringify({ valid: true, agentId: 'w1' }), { status: 200 })

describe('validateWsAuth', () => {
  beforeEach(() => invalidateTokenCache())
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('refuses a handshake without a key with 401, without asking the API', async () => {
    const fetchMock = verifyAnswers(ok)
    const auth = await validateWsAuth('/ws/conductor', {}, API)
    expect(auth.valid).toBe(false)
    expect(refusalStatus(auth)).toMatch(/^HTTP\/1\.1 401/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('takes the key from ?apiKey= and passes it as a Bearer token', async () => {
    const fetchMock = verifyAnswers(ok)
    const auth = await validateWsAuth('/ws/conductor?apiKey=k-query', { host: 'hub' }, API)
    expect(auth).toMatchObject({ valid: true, agentId: 'w1' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${API}/api/keys/verify`)
    expect(JSON.parse(String(init.body))).toEqual({ token: 'k-query' })
  })

  it('takes the key from the Authorization header', async () => {
    verifyAnswers(ok)
    const auth = await validateWsAuth('/ws/conductor', { authorization: 'Bearer k-header' }, API)
    expect(auth.valid).toBe(true)
  })

  it('answers 401 when the API rejects the key', async () => {
    verifyAnswers(() => new Response('{}', { status: 401 }))
    const auth = await validateWsAuth('/ws/conductor?apiKey=k-bad', {}, API)
    expect(auth).toMatchObject({ valid: false })
    expect(auth.unavailable).toBeUndefined()
    expect(refusalStatus(auth)).toMatch(/^HTTP\/1\.1 401/)
  })

  it('answers 503 when the API is still starting (502 from the proxy)', async () => {
    verifyAnswers(() => new Response('bad gateway', { status: 502 }))
    const auth = await validateWsAuth('/ws/conductor?apiKey=k-boot', {}, API)
    expect(auth).toMatchObject({ valid: false, unavailable: true })
    expect(refusalStatus(auth)).toMatch(/^HTTP\/1\.1 503 .*\r\nRetry-After: \d+$/)
  })

  it('answers 503 when the API cannot be reached at all', async () => {
    verifyAnswers(() => {
      throw new TypeError('fetch failed')
    })
    const auth = await validateWsAuth('/ws/conductor?apiKey=k-down', {}, API)
    expect(auth).toMatchObject({ valid: false, unavailable: true })
    expect(refusalStatus(auth)).toMatch(/^HTTP\/1\.1 503/)
  })

  it('lets a key verified moments ago through while the API restarts', async () => {
    verifyAnswers(ok)
    expect((await validateWsAuth('/ws/conductor?apiKey=k-known', {}, API)).valid).toBe(true)
    verifyAnswers(() => {
      throw new TypeError('fetch failed')
    })
    expect((await validateWsAuth('/ws/conductor?apiKey=k-known', {}, API)).valid).toBe(true)
  })

  it('does not remember an outage as a verdict', async () => {
    verifyAnswers(() => new Response('', { status: 503 }))
    expect((await validateWsAuth('/ws/conductor?apiKey=k-later', {}, API)).unavailable).toBe(true)
    verifyAnswers(ok)
    expect((await validateWsAuth('/ws/conductor?apiKey=k-later', {}, API)).valid).toBe(true)
  })
})
