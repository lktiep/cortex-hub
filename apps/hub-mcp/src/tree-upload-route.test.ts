import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MAX_TREE_UPLOAD_BYTES } from './tree-upload.js'

/**
 * Importing a plan file: cortex_task_tree_create(upload: true) hands out a link, and a plain
 * POST of the file to it creates the tree as the agent that asked, without an API key.
 */

const realFetch = globalThis.fetch
let treeCalls: Array<{ owner: string | null; body: unknown }>
let treeAnswer: { status: number; body: unknown }

function stubFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.includes('/api/keys/verify')) {
      return new Response(JSON.stringify({ valid: true, agentId: 'lead-a' }), { status: 200 })
    }
    if (url.endsWith('/api/conductor/tree')) {
      treeCalls.push({ owner: new Headers(init?.headers).get('X-API-Key-Owner'), body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify(treeAnswer.body), { status: treeAnswer.status })
    }
    // /api/metrics/* — telemetry and hints
    return new Response('{}', { status: 200 })
  })
}

async function app() {
  return (await import('./index.js')).default
}

/** Ask for a link the way an agent does: one tools/call through /mcp. */
async function link(): Promise<string> {
  const res = await (await app()).fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer k-sekrit',
      'X-Forwarded-Proto': 'https',
      'X-Forwarded-Host': 'hub.example.com',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cortex_task_tree_create', arguments: { upload: true } } }),
  }), {} as never)
  const body = (await res.json()) as { result: { content: Array<{ text: string }> } }
  const m = /"@plan\.json" (https:\/\/hub\.example\.com\/tree-upload\/[0-9a-f]{48})\n/.exec(body.result.content[0]!.text)
  if (!m) throw new Error(`no link in: ${body.result.content[0]!.text}`)
  return m[1]!
}

async function upload(url: string, body: string): Promise<{ status: number; text: string }> {
  const res = await (await app()).fetch(new Request(url.replace('https://hub.example.com', 'http://localhost'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }), {} as never)
  return { status: res.status, text: await res.text() }
}

const plan = { projectId: 'p', tasks: [{ key: 'A', title: 'a' }, { key: 'B', title: 'b', dependsOn: ['A'] }] }
const created = { status: 201, body: { ids: { A: 'id-a', B: 'id-b' }, rootIds: ['id-a'], ready: 1 } }

describe('POST /tree-upload/:token', () => {
  beforeEach(() => {
    globalThis.fetch = stubFetch() as unknown as typeof fetch
    treeCalls = []
    treeAnswer = created
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('creates the tree from the file as the agent that asked for the link, once', async () => {
    const url = await link()

    const first = await upload(url, JSON.stringify(plan))
    expect(first.status).toBe(201)
    expect(first.text.split('\n')).toEqual(['**Plan created** — 2 tasks, 1 ready now', '- A → id-a', '- B → id-b'])
    expect(treeCalls).toEqual([{ owner: 'lead-a', body: plan }])

    const again = await upload(url, JSON.stringify(plan))
    expect(again.status).toBe(404)
    expect(again.text).toContain('unknown, used or expired')
    expect(treeCalls).toHaveLength(1)
  })

  it('keeps the link when the file is not JSON or does not fit the plan schema', async () => {
    const url = await link()

    const notJson = await upload(url, '{"tasks": [')
    expect(notJson.status).toBe(400)
    expect(notJson.text).toMatch(/^The file is not valid JSON: /)

    const noTitle = await upload(url, JSON.stringify({ tasks: [{ key: 'A' }, { key: 'B', title: 'b', priority: 'urgent' }] }))
    expect(noTitle.status).toBe(400)
    expect(noTitle.text).toMatch(/^The file does not match the plan schema:\n- tasks\.0\.title: /)
    expect(noTitle.text).toContain('- tasks.1.priority: ')

    expect(treeCalls).toEqual([])
    expect((await upload(url, JSON.stringify(plan))).status).toBe(201)
  })

  it("passes the hub's rejection through with the cycle, and keeps the link", async () => {
    const url = await link()
    treeAnswer = { status: 400, body: { error: 'dependency cycle', cycle: ['A', 'B', 'A'] } }

    const rejected = await upload(url, JSON.stringify(plan))
    expect(rejected.status).toBe(400)
    expect(rejected.text.split('\n')).toEqual(['Plan rejected: dependency cycle', 'Cycle: A → B → A'])

    treeAnswer = created
    expect((await upload(url, JSON.stringify(plan))).status).toBe(201)
  })

  it('answers 502 when the hub fails, and keeps the link', async () => {
    const url = await link()
    treeAnswer = { status: 500, body: { error: 'database is locked' } }

    const failed = await upload(url, JSON.stringify(plan))
    expect(failed.status).toBe(502)
    expect(failed.text).toBe('Plan rejected: database is locked')

    treeAnswer = created
    expect((await upload(url, JSON.stringify(plan))).status).toBe(201)
  })

  it('refuses a file over the size limit without sending it on', async () => {
    const url = await link()
    const big = await upload(url, JSON.stringify({ tasks: [{ key: 'A', title: 'x'.repeat(MAX_TREE_UPLOAD_BYTES) }] }))
    expect(big.status).toBe(413)
    expect(big.text).toContain('5 MiB')
    expect(treeCalls).toEqual([])
  })

  it('refuses a token it never issued', async () => {
    const res = await upload(`https://hub.example.com/tree-upload/${'0'.repeat(48)}`, JSON.stringify(plan))
    expect(res.status).toBe(404)
    expect(treeCalls).toEqual([])
  })
})
