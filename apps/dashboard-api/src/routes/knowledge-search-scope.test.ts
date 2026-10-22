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

/** The filter each Qdrant search was sent. */
let filters: unknown[]

beforeEach(() => {
  filters = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { filter?: unknown }
    if (url.endsWith('/points/count')) return new Response(JSON.stringify({ result: { count: 3 } }))
    filters.push(body.filter)
    return new Response(JSON.stringify({ result: [] }))
  })
  testDb = createTestDb()
  testDb.exec('ALTER TABLE session_handoffs ADD COLUMN api_key_name TEXT')
  testDb.prepare("INSERT OR IGNORE INTO organizations (id, name, slug) VALUES ('org-1', 'Org', 'org'), ('org-default', 'Personal', 'personal')").run()
  testDb.prepare(
    `INSERT INTO projects (id, org_id, name, slug, git_repo_url) VALUES
       ('proj-1', 'org-1', 'Client', 'client', 'https://example.com/a/client.git'),
       ('proj-2', 'org-1', 'Server', 'server', 'https://example.com/a/server.git'),
       ('proj-3', 'org-default', 'Mine', 'mine', 'https://example.com/me/mine.git'),
       ('proj-4', 'org-default', 'Other', 'other', 'https://example.com/me/other.git')`,
  ).run()
})

function session(owner: string, projectId: string) {
  testDb.prepare(
    `INSERT INTO session_handoffs (id, from_agent, project, task_summary, context, status, project_id, api_key_name)
     VALUES (?, 'agent', 'x', 's', '{}', 'active', ?, ?)`,
  ).run(`s-${owner}`, projectId, owner)
}

async function search(body: Record<string, unknown>, owner = 'k') {
  const res = await knowledgeRouter.request('/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key-Owner': owner },
    body: JSON.stringify({ query: 'rotate key', ...body }),
  })
  expect(res.status).toBe(200)
  return filters.at(-1) as { must?: unknown[] } | undefined
}

const scopedTo = (ids: string[]) => ({
  must: [{ should: [{ key: 'project_id', match: { any: [...ids, ''] } }, { is_empty: { key: 'project_id' } }] }],
})

describe('knowledge search with no project named', () => {
  it('reads the session project\'s organization and the hub-wide notes', async () => {
    session('k', 'proj-1')
    expect(await search({})).toEqual(scopedTo(['proj-1', 'proj-2']))
  })

  it('in the personal organization, reads the session project alone', async () => {
    session('k', 'proj-3')
    expect(await search({})).toEqual(scopedTo(['proj-3']))
  })

  it('is as wide as before for a caller with no session, or one that asks for every project', async () => {
    expect(await search({}, 'nobody')).toBeUndefined()
    session('k', 'proj-1')
    expect(await search({ allProjects: true })).toBeUndefined()
  })

  it('a named project still wins', async () => {
    session('k', 'proj-1')
    expect(await search({ projectId: 'proj-4' })).toEqual({ must: [{ key: 'project_id', match: { value: 'proj-4' } }] })
  })
})
