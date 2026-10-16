import { describe, it, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../types.js'
import { registerTaskTools } from './tasks.js'

type Result = { content: Array<{ text: string }>; isError?: boolean }
type Handler = (args: Record<string, unknown>) => Promise<Result>

const realFetch = globalThis.fetch
const shapes: Record<string, Record<string, z.ZodTypeAny>> = {}
let calls: Array<{ url: string; method?: string; body: unknown }>

function tool(name: string, payload: unknown): Handler {
  calls = []
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : null })
    return new Response(JSON.stringify(payload), { status: 200 })
  }) as unknown as typeof fetch
  const tools: Record<string, Handler> = {}
  const server = { tool: (n: string, _d: string, s: Record<string, z.ZodTypeAny>, h: Handler) => { tools[n] = h; shapes[n] = s } }
  registerTaskTools(server as unknown as McpServer, { DASHBOARD_API_URL: 'http://api', API_KEY_OWNER: 'lead-key' } as Env)
  const handler = tools[name]
  if (!handler) throw new Error(`${name} was not registered`)
  return handler
}

/** Run input through the registered zod shape, as the MCP server does before calling the handler. */
const parsed = (name: string, input: Record<string, unknown>): Record<string, unknown> =>
  z.object(shapes[name]!).parse(input) as Record<string, unknown>

afterEach(() => { globalThis.fetch = realFetch })

describe('cortex_task_create', () => {
  it('maps "high" to 3 and sends routing fields', async () => {
    const h = tool('cortex_task_create', { task: { id: 't1', title: 'x', status: 'pending' } })
    await h(parsed('cortex_task_create', {
      title: 'x', assignTo: 'agent-a', priority: 'high', executor: 'codex', model: 'm', effort: 'high',
      fallback: [{ executor: 'claude', model: 'opus' }], files: ['a.ts'], branch: 'cx/x', reviewRequired: false,
    }))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://api/api/conductor')
    expect(calls[0]!.body).toEqual({
      title: 'x', assignedTo: 'agent-a', priority: 3, executor: 'codex', model: 'm', effort: 'high',
      fallback: [{ executor: 'claude', model: 'opus' }], files: ['a.ts'], branch: 'cx/x', reviewRequired: false,
    })
  })

  it('passes a numeric priority through and omits unset routing fields', async () => {
    const h = tool('cortex_task_create', { task: { id: 't1', title: 'x', status: 'pending' } })
    await h(parsed('cortex_task_create', { title: 'x', priority: 7 }))
    const body = calls[0]!.body as Record<string, unknown>
    expect(body.priority).toBe(7)
    for (const k of ['executor', 'model', 'effort', 'fallback', 'files', 'branch', 'reviewRequired']) expect(body).not.toHaveProperty(k)
  })
})

describe('cortex_task_pickup', () => {
  it('sends projectId when given and omits it otherwise', async () => {
    await tool('cortex_task_pickup', { task: null })({ projectId: 'proj-1' })
    expect(calls[0]!.body).toEqual({ agentId: 'lead-key', apiKeyOwner: 'lead-key', projectId: 'proj-1' })
    await tool('cortex_task_pickup', { task: null })({})
    expect(calls[0]!.body).toEqual({ agentId: 'lead-key', apiKeyOwner: 'lead-key' })
    expect(calls[0]!.body).not.toHaveProperty('projectId')
  })
})

describe('cortex_task_list', () => {
  it('sends assigned_to and projectId', async () => {
    await tool('cortex_task_list', { tasks: [] })({ assignedTo: 'agent-a', projectId: 'p1', status: 'pending' })
    const url = new URL(calls[0]!.url)
    expect(url.searchParams.get('assigned_to')).toBe('agent-a')
    expect(url.searchParams.get('projectId')).toBe('p1')
    expect(url.searchParams.has('assignedTo')).toBe(false)
  })

  it('shows key, wait reason and escalation', async () => {
    const res = await tool('cortex_task_list', {
      tasks: [
        { id: 't1', title: 'one', status: 'pending', assigned_to_agent: 'a', priority: 3, task_key: 'CX-1', kind: 'gate', wait_reason: 'lock', escalated_at: '2026-10-16T00:00:00Z' },
        { id: 't2', title: 'two', status: 'pending', task_key: null, kind: 'work', wait_reason: null, escalated_at: null },
      ],
    })({})
    const lines = res.content[0]!.text.split('\n')
    expect(lines[2]).toBe('| t1 | one | pending | a | 3 | key: CX-1 | gate | wait: lock | escalated')
    expect(lines[3]).toBe('| t2 | two | pending')
  })
})
