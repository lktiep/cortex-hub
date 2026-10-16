import { describe, it, expect, vi, afterEach } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../types.js'
import { registerConductorLeadTools } from './conductor-lead.js'

type Result = { content: Array<{ text: string }>; isError?: boolean }
type Handler = (args: Record<string, unknown>) => Promise<Result>

const realFetch = globalThis.fetch
let calls: Array<{ url: string; method?: string; body: unknown }>

function tool(name: string, status: number, payload: unknown): Handler {
  calls = []
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : null })
    return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status })
  }) as unknown as typeof fetch
  const tools: Record<string, Handler> = {}
  const server = { tool: (n: string, _d: string, _s: unknown, h: Handler) => { tools[n] = h } }
  registerConductorLeadTools(server as unknown as McpServer, { DASHBOARD_API_URL: 'http://api' } as Env)
  const handler = tools[name]
  if (!handler) throw new Error(`${name} was not registered`)
  return handler
}

afterEach(() => { globalThis.fetch = realFetch })

describe('cortex_task_tree_create', () => {
  const tasks = [{ key: 'A', title: 'a' }, { key: 'B', title: 'b', dependsOn: ['A'] }]

  it('posts the plan and lists ids in input order', async () => {
    const res = await tool('cortex_task_tree_create', 201, { ids: { B: 'id-b', A: 'id-a' }, rootIds: ['id-a'], ready: 1 })({ projectId: 'p', tasks })
    expect(calls).toEqual([{ url: 'http://api/api/conductor/tree', method: 'POST', body: { projectId: 'p', tasks } }])
    expect(res.isError).toBeUndefined()
    expect(res.content[0]!.text.split('\n')).toEqual(['**Plan created** — 2 tasks, 1 ready now', '- A → id-a', '- B → id-b'])
  })

  it('shows the cycle on 400', async () => {
    const res = await tool('cortex_task_tree_create', 400, { error: 'dependency cycle', cycle: ['A', 'B', 'A'] })({ tasks })
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text.split('\n')).toEqual(['Plan rejected: dependency cycle', 'Cycle: A → B → A'])
  })

  it('falls back to the status text when the body is not JSON', async () => {
    const res = await tool('cortex_task_tree_create', 502, 'oops')({ tasks })
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain('Plan rejected:')
  })
})

describe('cortex_agents', () => {
  it('lists workers, quota and sessions', async () => {
    const res = await tool('cortex_agents', 200, {
      online: 1,
      agents: [{
        agentId: 'w1', hostname: 'box', os: 'linux', status: 'busy', currentTaskId: 't9',
        engines: [{ executor: 'claude', models: ['opus', 'sonnet'], defaultModel: 'opus' }, { executor: 'codex', models: ['*'], defaultModel: null }, { executor: 'gemini', models: [], defaultModel: null }],
        quota: [{ executor: 'claude', model: 'opus', exhaustedUntil: '2026-10-16T12:00:00Z', reason: null }],
      }],
      sessions: [{ agentId: 's1', ide: 'cursor', branch: 'main', lastActivity: '2026-10-16T11:00:00Z' }],
    })({})
    expect(calls[0]).toMatchObject({ url: 'http://api/api/conductor/agents' })
    expect(res.content[0]!.text.split('\n')).toEqual([
      '**Workers (1 online)**',
      '- w1 @ box (linux) · busy · on t9 · engines: claude[opus,sonnet], codex[*], gemini · quota: claude/opus until 2026-10-16T12:00:00Z',
      '**MCP sessions**',
      '- s1 · cursor · main · 2026-10-16T11:00:00Z',
    ])
  })

  it('prints none for empty sections and ? for missing host and os', async () => {
    const empty = await tool('cortex_agents', 200, { online: 0, agents: [], sessions: [] })({})
    expect(empty.content[0]!.text.split('\n')).toEqual(['**Workers (0 online)**', '- none', '**MCP sessions**', '- none'])
    const nulls = await tool('cortex_agents', 200, { online: 1, agents: [{ agentId: 'w', hostname: null, os: null, status: 'idle', currentTaskId: null, engines: [], quota: [] }], sessions: [] })({})
    expect(nulls.content[0]!.text).toContain('- w @ ? (?) · idle · engines: ')
  })
})

describe('cortex_task_review', () => {
  it('posts the verdict', async () => {
    const res = await tool('cortex_task_review', 200, { task: { id: 't1', task_key: 'K1', status: 'completed' } })({ taskId: 't1', verdict: 'approve', feedback: 'ok' })
    expect(calls).toEqual([{ url: 'http://api/api/conductor/t1/review', method: 'POST', body: { verdict: 'approve', feedback: 'ok' } }])
    expect(res.content[0]!.text).toBe('**Review recorded** — K1 is now completed')
  })

  it('surfaces the 403 for user gates', async () => {
    const res = await tool('cortex_task_review', 403, { error: 'user gates are dashboard-only' })({ taskId: 't1', verdict: 'approve' })
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toBe('user gates are dashboard-only')
  })
})

describe('cortex_task_route', () => {
  it('sends only the provided fields', async () => {
    const res = await tool('cortex_task_route', 200, { task: { id: 't1', task_key: null, status: 'pending', executor: 'codex', model: null } })({ taskId: 't1', executor: 'codex', clearEscalation: true })
    expect(calls).toEqual([{ url: 'http://api/api/conductor/t1/route', method: 'POST', body: { executor: 'codex', clearEscalation: true } }])
    expect(res.content[0]!.text).toBe('**Route updated** — t1: codex/default')
  })

  it('keeps explicit nulls', async () => {
    await tool('cortex_task_route', 200, { task: { id: 't1', status: 'pending' } })({ taskId: 't1', executor: null })
    expect(calls[0]!.body).toEqual({ executor: null })
  })

  it('shows the cycle on 400', async () => {
    const res = await tool('cortex_task_route', 400, { error: 'cycle', cycle: ['A', 'B', 'A'] })({ taskId: 't1', dependsOn: ['x'] })
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text.split('\n')).toEqual(['cycle', 'Cycle: A → B → A'])
  })
})

describe('cortex_task_cancel', () => {
  it('posts the reason', async () => {
    const res = await tool('cortex_task_cancel', 200, { success: true, id: 't1' })({ taskId: 't1', reason: 'obsolete' })
    expect(calls).toEqual([{ url: 'http://api/api/conductor/t1/cancel', method: 'POST', body: { reason: 'obsolete' } }])
    expect(res.content[0]!.text).toBe('**Cancelled** — t1')
  })

  it('reports 404', async () => {
    const res = await tool('cortex_task_cancel', 404, { error: 'task not found' })({ taskId: 'zz' })
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toBe('task not found')
  })
})
