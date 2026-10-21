import { describe, it, expect, vi, afterEach } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../types.js'
import { registerCodeTools } from './code.js'

/**
 * Which repos cortex_code_search asks, by what the agent named. No repo used to mean every repo
 * of the organization, graph flows only; with the checkout's remote (`here`, from the client
 * hook) it means that repo in full, with the organization's other repos listed under it.
 */

type Result = { content: Array<{ text: string }>; isError?: boolean }
type Handler = (args: Record<string, unknown>) => Promise<Result>
type Call = { path: string; body: Record<string, unknown> }

const realFetch = globalThis.fetch
let calls: Call[]

const hit = (repo: string | undefined, filePath: string, score: number) => ({ repo, filePath, score, startLine: 3, endLine: 9 })

function codeSearch(opts: { unknownRepo?: string } = {}): Handler {
  calls = []
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace('http://api', '')
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    calls.push({ path, body })
    if (path === '/api/intel/search') {
      if (body.projectId && body.projectId === opts.unknownRepo) {
        return new Response(JSON.stringify({ error: 'Repository not found' }), { status: 500 })
      }
      const formatted = body.projectId ? `flows in ${String(body.projectId)}` : 'flows across the organization'
      return new Response(JSON.stringify({ data: { formatted } }))
    }
    if (path === '/api/intel/code-search') {
      const results = body.projectId
        ? [hit(undefined, 'src/login.ts', 0.6)]
        : [hit('game-server', 'src/auth/login.ts', 0.55), hit('game-tools', 'tools/login-bot.ts', 0.41)]
      return new Response(JSON.stringify({ data: { results } }))
    }
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch

  const tools: Record<string, Handler> = {}
  const server = { tool: (name: string, _d: string, _s: unknown, handler: Handler) => { tools[name] = handler; return { update: () => {} } } }
  registerCodeTools(server as unknown as McpServer, { DASHBOARD_API_URL: 'http://api' } as Env)
  return tools.cortex_code_search!
}

const asked = (path: string) => calls.filter((c) => c.path === `/api/intel/${path}`).map((c) => c.body)

afterEach(() => { globalThis.fetch = realFetch })

describe('cortex_code_search without a repo', () => {
  it('searches the checkout\'s repo in full and lists the other repos under it', async () => {
    const res = await codeSearch()({ query: 'login', here: 'https://example.com/acme/game-client.git' })
    const text = res.content[0]!.text

    expect(asked('search').map((b) => b.projectId)).toEqual(['game-client'])
    expect(asked('code-search')).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectId: 'game-client' }),
      expect.objectContaining({ exclude: 'game-client', scopeRepo: 'game-client' }),
    ]))
    expect(text.indexOf('src/login.ts')).toBeLessThan(text.indexOf('flows in game-client'))
    expect(text).toContain('**In other repos of your organization:**\n- game-server — src/auth/login.ts L3-9 55%\n- game-tools — tools/login-bot.ts L3-9 41%')
    expect(text).toContain('repo: "*"')
  })

  it('searches the organization when the hub does not hold the checkout', async () => {
    const res = await codeSearch({ unknownRepo: 'scratch' })({ query: 'login', here: 'git@example.com:me/scratch.git' })

    expect(res.isError).toBeUndefined()
    expect(res.content[0]!.text).toContain('flows across the organization')
    expect(res.content[0]!.text).toContain('game-server: src/auth/login.ts')
  })

  it('without the checkout\'s remote, searches every repo of the organization as before', async () => {
    const res = await codeSearch()({ query: 'login' })

    expect(asked('search')).toEqual([expect.not.objectContaining({ projectId: expect.anything() })])
    expect(res.content[0]!.text).toContain('across your organization\'s repos')
  })
})

describe('cortex_code_search with a repo', () => {
  it('"*" searches every repo of the organization, anchored to the checkout', async () => {
    const res = await codeSearch()({ query: 'login', repo: '*', here: 'https://example.com/acme/game-client.git' })

    expect(asked('search')).toEqual([expect.objectContaining({ scopeRepo: 'game-client' })])
    expect(asked('search')[0]).not.toHaveProperty('projectId')
    expect(res.content[0]!.text).toContain('1. game-server: src/auth/login.ts')
  })

  it('a named repo is searched alone, with no other repos listed', async () => {
    const res = await codeSearch()({ query: 'login', repo: 'game-server', here: 'https://example.com/acme/game-client.git' })

    expect(asked('search').map((b) => b.projectId)).toEqual(['game-server'])
    expect(asked('code-search').map((b) => b.projectId)).toEqual(['game-server'])
    expect(res.content[0]!.text).not.toContain('other repos')
  })
})
