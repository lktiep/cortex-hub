import { beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from '../conductor/testing.js'

let testDb: Database.Database
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
}))

import { knowledgeRouter } from './knowledge.js'

beforeEach(() => {
  // Clustering talks to Qdrant directly; offline here, which it already tolerates.
  vi.stubGlobal('fetch', async () => { throw new Error('offline') })
  testDb = createTestDb()
  testDb.exec('ALTER TABLE session_handoffs ADD COLUMN api_key_name TEXT')
  testDb.prepare("INSERT INTO organizations (id, name, slug) VALUES ('org-1', 'Org', 'org')").run()
  testDb.prepare(
    `INSERT INTO projects (id, org_id, name, slug, git_repo_url)
     VALUES ('proj-1', 'org-1', 'Demo', 'demo', 'https://github.com/example/demo.git')`,
  ).run()
  testDb.prepare(
    `INSERT INTO session_handoffs (id, from_agent, project, task_summary, context, status, project_id, api_key_name)
     VALUES ('s1', 'agent', 'demo', 's', '{}', 'active', 'proj-1', 'k')`,
  ).run()
})

function post(path: string, body: unknown, owner = 'k'): Promise<Response> {
  return Promise.resolve(knowledgeRouter.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key-Owner': owner },
    body: JSON.stringify(body),
  }))
}

describe('knowledge linked to files', () => {
  it('a document stored with files is linked in the caller\'s session project and answered for them', async () => {
    const res = await post('/', { title: 'Lock first', content: 'Take the lock before refresh.', category: 'risk', files: ['./src/a.ts', 'src/*.ts'] })
    expect(res.status).toBe(201)
    const doc = await res.json() as { id: string; files: string[]; project_id: string }
    expect(doc.files).toEqual(['src/a.ts'])
    expect(doc.project_id).toBe('proj-1')

    const notes = await (await post('/file-notes', { files: ['src/a.ts', 'src/b.ts'] })).json()
    expect(notes).toEqual({
      projectId: 'proj-1',
      notes: { 'src/a.ts': [expect.objectContaining({ id: doc.id, title: 'Lock first', kind: 'risk', note: 'Take the lock before refresh.' })] },
    })

    const named = await (await post('/file-notes', { repo: 'https://github.com/example/demo.git', text: 'hit: src/a.ts:3' }, 'nobody')).json() as { notes: Record<string, unknown> }
    expect(Object.keys(named.notes)).toEqual(['src/a.ts'])

    const detail = await (await knowledgeRouter.request(`/${doc.id}`)).json() as { files: string[] }
    expect(detail.files).toEqual(['src/a.ts'])

    expect((await knowledgeRouter.request(`/${doc.id}`, { method: 'DELETE' })).status).toBe(200)
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM knowledge_links').get()).toEqual({ n: 0 })
  })

  it('a document without files keeps no project it was not given', async () => {
    const doc = await (await post('/', { title: 'General', content: 'x' })).json() as { project_id: string | null; files: string[] }
    expect(doc).toMatchObject({ project_id: null, files: [] })
  })

  it('no project resolved answers no notes', async () => {
    expect(await (await post('/file-notes', { files: ['a.ts'] }, 'nobody')).json()).toEqual({ projectId: null, notes: {} })
    expect(await (await post('/file-notes', { repo: 'https://github.com/example/unknown.git' })).json()).toEqual({ projectId: null, notes: {} })
  })

  it('exports full text with links, filtered by category', async () => {
    const long = 'a'.repeat(2000) + 'END'
    const risk = await (await post('/', { title: 'R', content: long, category: 'risk', files: ['x.ts'] })).json() as { id: string }
    await post('/', { title: 'L', content: 'lesson', category: 'lesson' })

    const out = await (await knowledgeRouter.request('/export?category=risk')).json() as {
      total: number; documents: Array<{ id: string; content: string; files: string[]; category: string }>
    }
    expect(out.total).toBe(1)
    expect(out.documents[0]).toMatchObject({ id: risk.id, category: 'risk', files: ['x.ts'], content: long })

    // A document stored before content was kept is rebuilt from its chunks.
    testDb.prepare('UPDATE knowledge_documents SET content = NULL WHERE id = ?').run(risk.id)
    const rebuilt = await (await knowledgeRouter.request('/export?category=risk')).json() as { documents: Array<{ content: string }> }
    expect(rebuilt.documents[0]!.content).toBe(long)
  })

  it('lists documents of one category', async () => {
    await post('/', { title: 'R', content: 'risk', category: 'risk', files: ['x.ts'] })
    await post('/', { title: 'L', content: 'lesson', category: 'lesson' })
    const out = await (await knowledgeRouter.request('/?category=risk')).json() as { documents: Array<{ title: string; files: string[] }>; total: number }
    expect(out.total).toBe(1)
    expect(out.documents.map((d) => [d.title, d.files])).toEqual([['R', ['x.ts']]])
  })
})
