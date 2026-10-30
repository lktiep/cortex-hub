import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiCall } from './api-call.js'
import type { Env } from './types.js'

/** dashboard-api limits a call to the organizations of the key in X-Cortex-Key-Id, so only auth may set it. */

const realFetch = globalThis.fetch

function capture(): () => Headers {
  let seen = new Headers()
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    seen = new Headers(init?.headers)
    return new Response('{}')
  }) as unknown as typeof fetch
  return () => seen
}

afterEach(() => { globalThis.fetch = realFetch })

describe('apiCall key id', () => {
  const env = { DASHBOARD_API_URL: 'http://api.invalid', API_KEY_OWNER: 'lead', API_KEY_ID: 'key_a' } as Env

  it('sends the authenticated key\'s id', async () => {
    const headers = capture()
    await apiCall(env, '/api/intel/search', { method: 'POST' })
    expect(headers().get('X-Cortex-Key-Id')).toBe('key_a')
  })

  it('replaces a key id a tool put on the request', async () => {
    const headers = capture()
    await apiCall(env, '/api/intel/search', { headers: { 'X-Cortex-Key-Id': 'key_b' } })
    expect(headers().get('X-Cortex-Key-Id')).toBe('key_a')
  })

  it('sends none without an authenticated key', async () => {
    const headers = capture()
    await apiCall({ DASHBOARD_API_URL: 'http://api.invalid' } as Env, '/api/x', { headers: { 'X-Cortex-Key-Id': 'key_b' } })
    expect(headers().has('X-Cortex-Key-Id')).toBe(false)
  })
})
