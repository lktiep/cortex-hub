import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * The GET /mcp stream must reach the client.
 *
 * Claude Code opens the standalone SSE stream right after `initialize`. The
 * telemetry wrapper around the transport used to buffer every response body to
 * measure its size, and an SSE body only ends when the connection does — so the
 * await never resolved, the response never left the handler, and the client
 * reported CONNECTION_CLOSED with zero bytes received.
 *
 * Headers alone then turned out not to be enough: the proxy in front of this
 * server withholds them until the first body byte arrives, and the stream has
 * nothing to say until the server pushes a message, so through the tunnel the
 * client still saw nothing. These tests pin both halves — the response comes back
 * promptly AND it starts with a byte — plus the fact that POST is still measured.
 */

const realFetch = globalThis.fetch

/** Accept any key, and swallow the telemetry/hints calls the handler fires. */
function stubFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.includes('/api/keys/verify')) {
      return new Response(JSON.stringify({ valid: true, agentId: 'test-agent' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    // /api/metrics/* — telemetry is fire-and-forget, the body is never read
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
}

describe('GET /mcp (standalone SSE stream)', () => {
  beforeEach(() => {
    globalThis.fetch = stubFetch() as unknown as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('answers with stream headers instead of hanging', async () => {
    const app = (await import('./index.js')).default

    const res = await Promise.race([
      app.fetch(
        new Request('http://localhost/mcp', {
          method: 'GET',
          headers: { Accept: 'text/event-stream', Authorization: 'Bearer test-key' },
        }),
        {} as never,
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('GET /mcp did not answer within 3s — the stream is being buffered again')), 3000),
      ),
    ])

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    // Leave no open stream behind for the next test.
    await res.body?.cancel()
  })

  it('starts the stream with a byte, so a proxy releases the headers', async () => {
    const app = (await import('./index.js')).default

    const res = await app.fetch(
      new Request('http://localhost/mcp', {
        method: 'GET',
        headers: { Accept: 'text/event-stream', Authorization: 'Bearer test-key' },
      }),
      {} as never,
    )

    const reader = res.body!.getReader()
    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('the stream sent no byte within 3s — a proxy will hold the headers back and the client will see nothing')),
          3000,
        ),
      ),
    ])

    expect(first.done).toBe(false)
    const text = new TextDecoder().decode(first.value)
    // A line starting with ':' is an SSE comment: a byte that costs the client nothing.
    expect(text.startsWith(':')).toBe(true)

    await reader.cancel()
  })

  it('still answers 401 for a GET without a token', async () => {
    const app = (await import('./index.js')).default

    const res = await app.fetch(
      new Request('http://localhost/mcp', {
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
      }),
      {} as never,
    )

    expect(res.status).toBe(401)
  })

  it('still buffers a POST body, so telemetry keeps measuring it', async () => {
    const app = (await import('./index.js')).default

    const res = await app.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: 'Bearer test-key',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
        }),
      }),
      {} as never,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { result?: { serverInfo?: { name?: string } } }
    expect(body.result?.serverInfo?.name).toBeTruthy()
  })
})
