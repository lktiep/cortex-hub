import { describe, it, expect, vi, afterEach } from 'vitest'

/**
 * /mcp tells a rejected key (401) apart from an auth service that did not answer (503), so a
 * client restarting with the hub does not take a good key for a bad one.
 */

const realFetch = globalThis.fetch

function verifyAnswers(answer: () => Response) {
  globalThis.fetch = vi.fn(async () => answer()) as unknown as typeof fetch
}

async function postMcp(key: string): Promise<Response> {
  const app = (await import('./index.js')).default
  return app.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }),
    {} as never,
  )
}

describe('POST /mcp auth', () => {
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('answers 401 for a key the API rejects', async () => {
    verifyAnswers(() => new Response('{}', { status: 401 }))
    const res = await postMcp('k-rejected')
    expect(res.status).toBe(401)
  })

  it('answers 503 with Retry-After while the API is down', async () => {
    verifyAnswers(() => {
      throw new TypeError('fetch failed')
    })
    const res = await postMcp('k-outage')
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('5')
    const body = await res.json() as { error: { message: string } }
    expect(body.error.message).toMatch(/unavailable/i)
  })
})
