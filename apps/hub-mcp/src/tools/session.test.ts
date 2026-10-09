import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../types.js'
import { registerSessionTools } from './session.js'

/**
 * cortex_session_end as the exit hook calls it.
 *
 * The hook marks a session closed whenever the tool answers without isError, so an
 * automatic close has to reach the API as `auto` and has to report a failure as one.
 */

type Result = { content: Array<{ text: string }>; isError?: boolean }
type Handler = (args: Record<string, unknown>) => Promise<Result>

const realFetch = globalThis.fetch
let calls: Array<{ url: string; body: unknown }>

function register(endStatus = 200): Record<string, Handler> {
  calls = []
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
    const status = url.endsWith('/end') ? endStatus : 200
    return new Response(JSON.stringify({ session: { id: 's1', status: 'abandoned' } }), { status })
  }) as unknown as typeof fetch

  const tools: Record<string, Handler> = {}
  const server = { tool: (name: string, _d: string, _s: unknown, handler: Handler) => { tools[name] = handler } }
  registerSessionTools(server as unknown as McpServer, { DASHBOARD_API_URL: 'http://api' } as Env)
  return tools
}

function tool(name: string, endStatus?: number): Handler {
  const handler = register(endStatus)[name]
  if (!handler) throw new Error(`${name} was not registered`)
  return handler
}

const sessionEnd = (endStatus: number) => tool('cortex_session_end', endStatus)

describe('cortex_session_end', () => {
  beforeEach(() => { calls = [] })
  afterEach(() => { globalThis.fetch = realFetch })

  it('forwards auto to the API', async () => {
    const res = await sessionEnd(200)({ sessionId: 's1', summary: 'auto-closed', auto: true })
    expect(res.isError).toBeUndefined()
    expect(calls).toEqual([{ url: 'http://api/api/sessions/s1/end', body: { summary: 'auto-closed', auto: true } }])
  })

  it('leaves auto out of an ordinary close', async () => {
    await sessionEnd(200)({ sessionId: 's1', summary: 'done' })
    expect(calls.map((c) => c.body)).toEqual([{ summary: 'done' }])
  })

  it('reports a failed automatic close instead of falling back to "closed"', async () => {
    const res = await sessionEnd(500)({ sessionId: 's1', summary: 'auto-closed', auto: true })
    expect(res.isError).toBe(true)
    expect(calls.map((c) => c.url)).toEqual(['http://api/api/sessions/s1/end'])
  })
})

describe('cortex_session_start', () => {
  afterEach(() => { globalThis.fetch = realFetch })

  const startBody = () => calls.find((c) => c.url.endsWith('/api/sessions/start'))?.body as Record<string, unknown>

  it('passes the conversation id on, so the hub keeps parallel conversations apart', async () => {
    await tool('cortex_session_start')({ repo: 'r', clientSessionId: 'conv-a' })
    expect(startBody().clientSessionId).toBe('conv-a')
  })

  it('sends none when the agent has none', async () => {
    await tool('cortex_session_start')({ repo: 'r' })
    expect(startBody()).not.toHaveProperty('clientSessionId')
  })
})
