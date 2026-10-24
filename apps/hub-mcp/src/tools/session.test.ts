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

function register(endStatus = 200, startReply?: Record<string, unknown>): Record<string, Handler> {
  calls = []
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
    const status = url.endsWith('/end') ? endStatus : 200
    const reply = startReply && url.endsWith('/api/sessions/start') ? startReply : { session: { id: 's1', status: 'abandoned' } }
    return new Response(JSON.stringify(reply), { status })
  }) as unknown as typeof fetch

  const tools: Record<string, Handler> = {}
  const server = { tool: (name: string, _d: string, _s: unknown, handler: Handler) => { tools[name] = handler; return { update: () => {} } } }
  registerSessionTools(server as unknown as McpServer, { DASHBOARD_API_URL: 'http://api' } as Env)
  return tools
}

function tool(name: string, endStatus?: number, startReply?: Record<string, unknown>): Handler {
  const handler = register(endStatus, startReply)[name]
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

  it('tells the agent the hub registered the repo and is indexing it', async () => {
    const autoRegistered = { projectId: 'proj-new', orgId: 'org-1', orgName: 'Org', username: 'acme', message: 'Registered sandbox in Org' }
    const res = await tool('cortex_session_start', 200, {
      sessionId: 'sess-1', project: { id: 'proj-new', orgId: 'org-1' }, autoRegistered,
    })({ repo: 'https://github.com/acme/sandbox.git' })
    const out = JSON.parse(res.content[0]!.text) as Record<string, unknown>
    expect(out.auto_registered).toEqual(autoRegistered)
    expect(out.project).toEqual({ id: 'proj-new', orgId: 'org-1' })
  })

  it('passes on how to register a repo the hub does not know', async () => {
    const res = await tool('cortex_session_start', 200, { sessionId: 'sess-1', project: null, projectNote: 'not registered' })({ repo: 'r' })
    const out = JSON.parse(res.content[0]!.text) as Record<string, unknown>
    expect(out.project_note).toBe('not registered')
    expect(out).not.toHaveProperty('auto_registered')
    expect(out).not.toHaveProperty('hub_error')
  })

  it('says why the hub refused the session, rather than passing a local id off as recorded', async () => {
    const handler = tool('cortex_session_start')
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/api/sessions/start')
        ? new Response(JSON.stringify({ success: false, error: 'Cortex Hub is disabled for this project.' }), { status: 403 })
        : new Response('{}', { status: 200 })) as unknown as typeof fetch
    const out = JSON.parse((await handler({ repo: 'r' })).content[0]!.text) as Record<string, unknown>
    expect(out.hub_error).toBe('The hub refused the session (HTTP 403): Cortex Hub is disabled for this project.')
    expect(out).not.toHaveProperty('project')
  })

  it('leaves out the instruction files the agent already has, and each document past its first chunk', async () => {
    const handler = tool('cortex_session_start')
    const hit = (documentId: string, title: string) => ({ documentId, title, content: `${title} body` })
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) =>
      new Response(JSON.stringify(String(input).endsWith('/api/knowledge/search')
        ? { results: [hit('d1', '[CLAUDE.md] Instructions'), hit('d2', '[apps/web/AGENTS.md] Web'), hit('d3', 'Session summary'), hit('d3', 'Session summary'), hit('d4', 'Auth decision')] }
        : { sessionId: 'sess-1' }), { status: 200 })) as unknown as typeof fetch
    const res = await handler({ repo: 'https://github.com/acme/app.git' })
    const out = JSON.parse(res.content[0]!.text) as { mission_brief: string; relevant_knowledge: Array<{ id: string }> }
    expect(out.mission_brief).toContain('Session summary')
    expect(out.relevant_knowledge.map((k) => k.id)).toEqual(['d3', 'd4'])
    // One line: the indentation was a sixth of the reply
    expect(res.content[0]!.text).not.toContain('\n  ')
  })

  it('says so when the hub does not answer', async () => {
    const handler = tool('cortex_session_start')
    globalThis.fetch = vi.fn(async () => { throw new Error('connect ECONNREFUSED') }) as unknown as typeof fetch
    const out = JSON.parse((await handler({ repo: 'r' })).content[0]!.text) as Record<string, unknown>
    expect(out.hub_error).toBe('The hub did not answer the session start: connect ECONNREFUSED')
  })
})
