import { describe, it, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../types.js'
import { registerConductorLeadTools } from './conductor-lead.js'
import { claimTreeUpload } from '../tree-upload.js'

type Result = { content: Array<{ text: string }>; isError?: boolean }
type Handler = (args: Record<string, unknown>) => Promise<Result>

const realFetch = globalThis.fetch
const shapes: Record<string, Record<string, z.ZodTypeAny>> = {}
let calls: Array<{ url: string; method?: string; body: unknown }>

function tool(name: string, status: number, payload: unknown, env: Partial<Env> = {}): Handler {
  calls = []
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : null })
    return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status })
  }) as unknown as typeof fetch
  const tools: Record<string, Handler> = {}
  const server = { tool: (n: string, _d: string, s: Record<string, z.ZodTypeAny>, h: Handler) => { tools[n] = h; shapes[n] = s } }
  registerConductorLeadTools(server as unknown as McpServer, { DASHBOARD_API_URL: 'http://api', ...env } as Env)
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
    expect(res.content[0]!.text.split('\n').slice(0, 3)).toEqual(['**Plan created** — 2 tasks, 1 ready now', '- A → id-a', '- B → id-b'])
    // two one-line tasks in a row: created, with what is wrong with them
    expect(res.content[0]!.text).toContain('Only 2 work task(s)')
  })

  it('answers guide: true with the planning guide, and calls nothing', async () => {
    const res = await tool('cortex_task_tree_create', 500, {})({ guide: true })
    expect(calls).toEqual([])
    expect(res.content[0]!.text).toMatch(/^# Planning a Conductor task tree/)
  })

  it('checks a plan with dryRun: true without creating it', async () => {
    const res = await tool('cortex_task_tree_create', 500, {})({ tasks, dryRun: true })
    expect(calls).toEqual([])
    expect(res.isError).toBeUndefined()
    const text = res.content[0]!.text
    expect(text.split('\n')[0]).toBe('**Plan check** — 2 work task(s), 0 gate(s) · longest chain 2 · widest level 1')
    expect(text).toMatch(/Nothing was created\.$/)
  })

  it('shows the cycle on 400', async () => {
    const res = await tool('cortex_task_tree_create', 400, { error: 'dependency cycle', cycle: ['A', 'B', 'A'] })({ tasks })
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text.split('\n')).toEqual(['Plan rejected: dependency cycle', 'Cycle: A → B → A'])
  })

  it('falls back to the status text when the body is not JSON', async () => {
    const res = await tool('cortex_task_tree_create', 502, 'oops')({ tasks })
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toBe('Plan rejected: HTTP 502')
  })

  it('hands out a one-time upload command instead of calling the API', async () => {
    const res = await tool('cortex_task_tree_create', 500, {}, { PUBLIC_ORIGIN: 'https://hub.example.com', API_KEY_OWNER: 'lead-a' })({ upload: true })
    expect(calls).toEqual([])
    expect(res.isError).toBeUndefined()
    const text = res.content[0]!.text
    const m = /curl -sS --fail-with-body -H "Content-Type: application\/json" --data-binary "@plan\.json" https:\/\/hub\.example\.com\/tree-upload\/([0-9a-f]{48})\n/.exec(text)
    expect(m).not.toBeNull()
    expect(claimTreeUpload(m![1]!)).toEqual({ ok: true, owner: 'lead-a' })
    expect(text).toContain('curl.exe')
  })

  it('refuses plan arguments next to upload, and a call with neither', async () => {
    for (const args of [{ upload: true, tasks }, { upload: true, projectId: 'p' }]) {
      const both = await tool('cortex_task_tree_create', 201, {})(args)
      expect(both.isError).toBe(true)
      expect(both.content[0]!.text).toBe('With upload: true, put parentId, projectId and tasks in the file, not in this call.')
    }
    const neither = await tool('cortex_task_tree_create', 201, {})({})
    expect(neither.isError).toBe(true)
    expect(neither.content[0]!.text).toBe('Give tasks, or upload: true to import the plan from a JSON file, or guide: true for the planning guide.')
    expect(calls).toEqual([])
  })
})

describe('cortex_agents', () => {
  it('lists workers, quota and sessions', async () => {
    const res = await tool('cortex_agents', 200, {
      online: 1,
      agents: [{
        agentId: 'w1', hostname: 'box', os: 'linux', status: 'busy', currentTaskId: 't9', capabilities: ['gpu', 'linux'], projectId: 'p1',
        engines: [{ executor: 'claude', models: ['opus', 'sonnet'], defaultModel: 'opus' }, { executor: 'codex', models: ['*'], defaultModel: null }, { executor: 'gemini', models: [], defaultModel: null }],
        quota: [{ executor: 'claude', model: 'opus', exhaustedUntil: '2026-10-16T12:00:00Z', reason: null }],
      }],
      sessions: [{ agentId: 's1', ide: 'cursor', branch: 'main', lastActivity: '2026-10-16T11:00:00Z' }],
    })({})
    expect(calls[0]).toMatchObject({ url: 'http://api/api/conductor/agents' })
    expect(res.content[0]!.text.split('\n')).toEqual([
      '**Workers (1 online)**',
      '- w1 @ box (linux) · busy · on t9 · engines: claude[opus,sonnet], codex[*], gemini · capabilities: gpu, linux · project: p1 · quota: claude/opus until 2026-10-16T12:00:00Z',
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

describe('fallback without effort', () => {
  const fallback = [{ executor: 'claude', model: 'opus' }]

  it('route accepts and sends it as given', async () => {
    const handler = tool('cortex_task_route', 200, { task: { id: 't1', status: 'pending' } })
    const input = z.object(shapes.cortex_task_route!).parse({ taskId: 't1', fallback })
    await handler(input)
    expect(calls[0]!.body).toEqual({ fallback })
  })

  it('tree_create accepts and sends it as given', async () => {
    const handler = tool('cortex_task_tree_create', 201, { ids: { A: 'a' }, rootIds: ['a'], ready: 1 })
    const tasks = [{ key: 'A', title: 'a', fallback }]
    const input = z.object(shapes.cortex_task_tree_create!).parse({ tasks })
    await handler(input)
    expect(calls[0]!.body).toEqual({ tasks })
  })
})

describe('error shaping', () => {
  it('prints no Cycle line for a non-400 error', async () => {
    const res = await tool('cortex_task_route', 409, { error: 'busy', cycle: ['A', 'B', 'A'] })({ taskId: 't1', dependsOn: ['x'] })
    expect(res.content[0]!.text).toBe('busy')
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
