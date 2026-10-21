import { describe, expect, it, vi } from 'vitest'
import { withInternalSecret } from './internal-secret.js'

function recorder() {
  const calls: Array<{ url: string; secret: string | null; other: string | null }> = []
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    calls.push({ url: String(input instanceof Request ? input.url : input), secret: headers.get('X-Internal-Secret'), other: headers.get('X-Other') })
    return new Response('{}')
  })
  return { calls, impl: impl as unknown as typeof fetch }
}

describe('withInternalSecret', () => {
  it('adds the secret to calls to the API only', async () => {
    const { calls, impl } = recorder()
    const f = withInternalSecret(impl, 'http://api:4000/', 'k-sekrit')
    await f('http://api:4000/api/keys/verify', { headers: { 'X-Other': '1' } })
    await f(new URL('http://api:4000/api/x'))
    await f('http://api:40000/api/x')
    await f('https://example.com/api/x')
    expect(calls).toEqual([
      { url: 'http://api:4000/api/keys/verify', secret: 'k-sekrit', other: '1' },
      { url: 'http://api:4000/api/x', secret: 'k-sekrit', other: null },
      { url: 'http://api:40000/api/x', secret: null, other: null },
      { url: 'https://example.com/api/x', secret: null, other: null },
    ])
  })

  it('keeps a secret the caller set, and does nothing without one', async () => {
    const { calls, impl } = recorder()
    await withInternalSecret(impl, 'http://api:4000', 'k-sekrit')('http://api:4000/a', { headers: { 'X-Internal-Secret': 'own' } })
    expect(calls[0]!.secret).toBe('own')
    expect(withInternalSecret(impl, 'http://api:4000', undefined)).toBe(impl)
  })
})
