import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../types.js'
import { registerSessionTools } from './session.js'
import { formatOrgRepos, formatTaskRecall, terms } from './task-recall.js'

/**
 * cortex_session_start with the task: the recall and the code lookup an agent ran as three more
 * calls come back in the start's answer, with the lines the client hooks take as evidence.
 */

type Result = { content: Array<{ text: string }>; isError?: boolean }
type Handler = (args: Record<string, unknown>) => Promise<Result>

const realFetch = globalThis.fetch
let asked: Array<{ path: string; body: Record<string, unknown> }>
let projectMemories: Array<Record<string, unknown>>

function sessionStart(down: string[] = [], orgRepos?: string[]): Handler {
  asked = []
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace('http://api', '')
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    asked.push({ path, body })
    if (down.includes(path)) return new Response('down', { status: 503 })
    const reply: Record<string, unknown> = {
      '/api/sessions/start': { sessionId: 'sess_1', project: { id: 'proj-1', orgId: 'org-1', orgRepos }, recentSessions: [{ id: 'other' }] },
      '/api/knowledge/search': { results: [
        { documentId: 'kdoc-1', title: 'Rotate keys in place', content: 'Keep the id,\n swap the hash.', score: 0.62 },
        { documentId: 'kdoc-1', title: 'Rotate keys in place', content: 'second chunk', score: 0.6 },
        { documentId: 'kdoc-2', title: '[CLAUDE.md] Project rules', content: 'already in context', score: 0.58 },
        { documentId: 'kdoc-3', title: 'Deploy notes', content: 'unrelated', score: 0.41 },
      ] },
      '/api/mem9/search': { memories: body.userId === 'project-proj-1'
        ? projectMemories
        : [{ id: 'm9', memory: 'Another project rotates its key on deploy' }] },
      '/api/intel/code-search': { data: { results: [{ filePath: 'src/routes/keys.ts', score: 0.7, startLine: 40, endLine: 90, content: 'x' }] } },
      '/api/intel/cypher': { data: { raw: '| file | name | type | s | e |\n| --- | --- | --- | --- | --- |\n| src/routes/keys.ts | generateApiKey | Function | 32 | 38 |\n| src/routes/keys.ts | rotateKey | Function | 45 | 80 |' } },
    }
    return new Response(JSON.stringify(reply[path] ?? {}), { status: reply[path] ? 200 : 404 })
  }) as unknown as typeof fetch

  const tools: Record<string, Handler> = {}
  const server = { tool: (name: string, _d: string, _s: unknown, handler: Handler) => { tools[name] = handler; return { update: () => {} } } }
  registerSessionTools(server as unknown as McpServer, { DASHBOARD_API_URL: 'http://api' } as Env)
  return tools.cortex_session_start!
}

beforeEach(() => {
  projectMemories = [{ id: 'm1', memory: 'Cache is per key hash' }, { id: 'm2', memory: 'Never commit the build folder' }]
})
afterEach(() => { globalThis.fetch = realFetch })

const start = { repo: 'https://example.com/acme/keys-api.git', agentId: 'claude-code', task: 'rotate an API key' }

describe('cortex_session_start with a task', () => {
  it('answers the recall and where the code is, once each', async () => {
    const res = await sessionStart()(start)
    const [head, brief] = res.content.map((c) => c.text)

    expect(JSON.parse(head!)).toEqual({ session_id: 'sess_1', status: 'active', project: { id: 'proj-1', orgId: 'org-1' } })
    expect(brief).toContain('recalled: knowledge+memory for "rotate an API key"')
    expect(brief).toContain('- Rotate keys in place — Keep the id, swap the hash. (kdoc-1)')
    expect(brief).not.toContain('second chunk')
    expect(brief).not.toContain('CLAUDE.md')
    expect(brief).not.toContain('Deploy notes')
    expect(brief).toContain('- Cache is per key hash')
    expect(brief).not.toContain('build folder')
    expect(brief).toContain('located: code for "rotate an API key"')
    expect(brief).toContain('1. src/routes/keys.ts — L40-90 70% · in rotateKey L45-80')
    expect(brief).not.toContain('generateApiKey')
    expect(brief).not.toContain('```')
  })

  it('searches the task\'s words, not the generic session-summary query', async () => {
    await sessionStart()(start)

    const queries = asked.filter((a) => a.path === '/api/knowledge/search').map((a) => a.body.query)
    expect(queries).toEqual(['rotate an API key'])
    expect(asked.find((a) => a.path === '/api/intel/code-search')!.body).toMatchObject({ query: 'rotate an API key', projectId: 'keys-api' })
    expect(asked.filter((a) => a.path === '/api/mem9/search').map((a) => a.body.userId)).toEqual(['project-proj-1'])
  })

  it('recalls only the project\'s memories, never what the agent stored for another one', async () => {
    const brief = (await sessionStart()(start)).content.map((c) => c.text).join('\n')

    expect(brief).not.toContain('Another project')
  })

  it('leads with the last session summary, whole, even when the task names nothing in it', async () => {
    const next = 'Next: wire the flag into the help output and add a test for the hidden option.'
    projectMemories = [
      { id: 's1', memory: '[Session Summary] older work', createdAt: '2026-10-20T00:00:00Z', metadata: { type: 'session-summary' } },
      { id: 'm3', memory: 'Deprecated options print a warning once', createdAt: '2026-10-22T00:00:00Z' },
      { id: 's2', memory: `[Session Summary] Added Option.deprecated and its tests. ${'x'.repeat(200)} ${next}`, createdAt: '2026-10-22T09:00:00Z', metadata: { type: 'session-summary' } },
    ]

    const brief = (await sessionStart()({ ...start, task: 'continue the deprecation work where we left off' })).content[1]!.text
    const memory = brief.slice(brief.indexOf('Memory:'))

    expect(memory.split('\n')[1]).toContain('[Session Summary] Added Option.deprecated')
    expect(memory).toContain(next)
    expect(memory).toContain('- Deprecated options print a warning once')
    expect(memory).not.toContain('older work')
  })

  it('claims no recall when a search did not answer, and no location without files', async () => {
    const res = await sessionStart(['/api/mem9/search', '/api/intel/code-search'])(start)
    const text = res.content.map((c) => c.text).join('\n')

    expect(text).not.toContain('recalled:')
    expect(text).not.toContain('located:')
  })

  it('names the other repos of the organization, with or without a task', async () => {
    const withTask = (await sessionStart([], ['Server', 'Tools'])(start)).content.map((c) => c.text)
    expect(withTask[1]).toContain('searchable: 2 other repo(s) of this organization, not on disk here — Server, Tools.')
    expect(withTask[1]).toContain('cortex_code_grep')

    const bare = (await sessionStart([], ['Server'])({ repo: start.repo })).content.map((c) => c.text)
    expect(bare).toHaveLength(2)
    expect(bare[1]).toContain('— Server.')
  })

  it('without a task, answers as before', async () => {
    const res = await sessionStart()({ repo: start.repo })
    const body = JSON.parse(res.content[0]!.text) as Record<string, unknown>

    expect(res.content).toHaveLength(1)
    expect(body).toHaveProperty('mission_brief')
    expect(body).toHaveProperty('identity')
  })
})

describe('formatTaskRecall', () => {
  it('says so when nothing is stored for the task yet, and still counts as a recall', () => {
    expect(formatTaskRecall('x', [], [])).toBe('recalled: knowledge+memory for "x" — nothing stored is close to it.')
  })

  it('shows only the part that has something', () => {
    expect(formatTaskRecall('x', [], [{ memory: 'm' }])).toBe('recalled: knowledge+memory for "x"\nMemory:\n- m')
  })
})

describe('formatOrgRepos', () => {
  it('says nothing for no other repo, and cuts a long list', () => {
    expect(formatOrgRepos(undefined)).toBe('')
    expect(formatOrgRepos([])).toBe('')
    const many = Array.from({ length: 25 }, (_, i) => `r${i}`)
    expect(formatOrgRepos(many)).toContain('25 other repo(s)')
    expect(formatOrgRepos(many)).toContain('r19, ….')
    expect(formatOrgRepos(many)).not.toContain('r20')
  })
})

describe('terms', () => {
  it('splits identifiers, keeps short words that carry meaning, and drops filler', () => {
    expect([...terms('add the toolStats filter to cortex_tool_stats for API keys')].sort())
      .toEqual(['api', 'cortex', 'filter', 'key', 'stat', 'tool'])
  })
})
