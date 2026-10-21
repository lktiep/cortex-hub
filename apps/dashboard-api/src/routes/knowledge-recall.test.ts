import { beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from '../conductor/testing.js'

let testDb: Database.Database
let memories: Array<Record<string, unknown>> = []
const memoryCalls: Array<Record<string, unknown>> = []

vi.mock('../db/client.js', () => ({ get db() { return testDb } }))
vi.mock('../lib/embedder-factory.js', () => ({ createEmbedder: () => ({ embed: async () => [0.1, 0.2, 0.3] }) }))
vi.mock('@cortex/shared-mem9', () => ({
  VectorStore: class {
    async ensureCollection() {}
    async upsert() {}
    async search() { return [] }
    async delete() {}
    async deleteByFilter() {}
  },
  isSessionSummary: (m: { metadata?: Record<string, unknown> }) => m.metadata?.['type'] === 'session-summary',
}))
vi.mock('./mem9-proxy.js', () => ({
  mem9ProxyRouter: {
    request: async (_path: string, init: { body: string }) => {
      memoryCalls.push(JSON.parse(init.body) as Record<string, unknown>)
      return new Response(JSON.stringify({ memories }))
    },
  },
}))

import { knowledgeRouter } from './knowledge.js'

type Hit = { id: string; score: number; payload: Record<string, unknown> }
let hits: Hit[] = []
let searchBodies: Array<{ filter?: { must: Array<Record<string, unknown>> } }> = []

beforeEach(() => {
  hits = []
  searchBodies = []
  memories = []
  memoryCalls.length = 0
  // Only the flat search answers; the count that picks hierarchical search fails, as offline.
  vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
    if (!String(url).endsWith('/collections/knowledge/points/search')) throw new Error('offline')
    searchBodies.push(JSON.parse(init?.body ?? '{}') as (typeof searchBodies)[number])
    return new Response(JSON.stringify({ result: hits }))
  })
  testDb = createTestDb()
  testDb.exec('ALTER TABLE session_handoffs ADD COLUMN api_key_name TEXT')
  testDb.prepare("INSERT INTO organizations (id, name, slug) VALUES ('org-1', 'Org', 'org')").run()
  testDb.prepare(
    `INSERT INTO projects (id, org_id, name, slug, git_repo_url)
     VALUES ('proj-1', 'org-1', 'Demo', 'demo', 'https://github.com/example/demo.git')`,
  ).run()
})

function post(path: string, body: unknown, owner = 'k'): Promise<Response> {
  return Promise.resolve(knowledgeRouter.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key-Owner': owner },
    body: JSON.stringify(body),
  }))
}

async function storeDoc(title: string, content: string): Promise<string> {
  const res = await post('/', { title, content, projectId: 'proj-1' })
  return ((await res.json()) as { id: string }).id
}

const hit = (id: string, documentId: string, score: number, content: string): Hit =>
  ({ id, score, payload: { document_id: documentId, title: id, content } })

describe('POST /recall', () => {
  it('answers the project\'s strong hits once per document, without archived ones or counting them', async () => {
    const pages = await storeDoc('Docs site', 'The showcase page is published on GitHub Pages from site/.')
    const old = await storeDoc('Old docs site', 'The showcase page used to live elsewhere.')
    const weak = await storeDoc('Unrelated', 'Database schema columns.')
    testDb.prepare("UPDATE knowledge_documents SET status = 'archived' WHERE id = ?").run(old)
    hits = [
      hit('c1', pages, 0.9, 'The showcase page is published on GitHub Pages from site/.'),
      hit('c2', pages, 0.88, 'A second chunk of the same document.'),
      hit('c3', old, 0.9, 'The showcase page used to live elsewhere.'),
      hit('c4', weak, 0.1, 'Database schema columns.'),
    ]
    memories = [
      { id: 'session-s1', memory: '[Session Summary] last time', score: 1, metadata: { type: 'session-summary' } },
      { id: 'm1', memory: 'The user wants the docs in Vietnamese and English.', score: 0.8 },
      { id: 'm2', memory: 'Something else entirely.', score: 0.3 },
    ]

    const res = await post('/recall', { query: 'showcase page', repo: 'https://github.com/example/demo.git' }, 'nobody')
    expect(res.status).toBe(200)
    const body = await res.json() as { projectId: string; knowledge: Array<Record<string, unknown>>; memories: Array<Record<string, unknown>> }
    expect(body.projectId).toBe('proj-1')
    expect(body.knowledge).toEqual([
      { id: pages, title: 'c1', snippet: 'The showcase page is published on GitHub Pages from site/.', score: expect.any(Number) },
    ])
    expect(body.memories).toEqual([{ id: 'm1', text: 'The user wants the docs in Vietnamese and English.', score: 0.8 }])

    expect(searchBodies[0]?.filter?.must).toContainEqual({ key: 'project_id', match: { value: 'proj-1' } })
    expect(memoryCalls[0]).toMatchObject({ query: 'showcase page', userId: 'project-proj-1' })
    const counted = testDb.prepare('SELECT SUM(hit_count) AS h, SUM(selection_count) AS s FROM knowledge_documents').get()
    expect(counted).toEqual({ h: 0, s: 0 })
  })

  it('cuts long chunks to a snippet', async () => {
    const doc = await storeDoc('Long', 'x')
    hits = [hit('c1', doc, 0.95, `word ${'y'.repeat(600)}`)]
    const body = await (await post('/recall', { query: 'word', projectId: 'proj-1' })).json() as { knowledge: Array<{ snippet: string }> }
    expect(body.knowledge[0]?.snippet).toHaveLength(240)
    expect(body.knowledge[0]?.snippet.endsWith('…')).toBe(true)
  })

  it('answers nothing for a project it cannot resolve, without searching', async () => {
    const body = await (await post('/recall', { query: 'anything', repo: 'https://github.com/example/unknown.git' })).json()
    expect(body).toEqual({ projectId: null, knowledge: [], memories: [] })
    expect(searchBodies).toHaveLength(0)
    expect(memoryCalls).toHaveLength(0)
  })

  it('still answers memories when the knowledge search fails', async () => {
    vi.stubGlobal('fetch', async () => new Response('down', { status: 500 }))
    memories = [{ id: 'm1', memory: 'kept', score: 0.9 }]
    const body = await (await post('/recall', { query: 'q', projectId: 'proj-1' })).json()
    expect(body).toEqual({ projectId: 'proj-1', knowledge: [], memories: [{ id: 'm1', text: 'kept', score: 0.9 }] })
  })

  it('requires a query', async () => {
    expect((await post('/recall', { projectId: 'proj-1' })).status).toBe(400)
  })
})
