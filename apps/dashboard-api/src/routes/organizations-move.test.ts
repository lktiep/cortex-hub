import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { join, dirname, basename } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ── In-memory DB for tests ──
let testDb: InstanceType<typeof Database>

function createTestDb() {
  const db = new Database(':memory:')
  const schema = readFileSync(join(__dirname, '../db/schema.sql'), 'utf-8')
  db.exec(schema)
  // Added by the runtime migration in db/client.ts, not by schema.sql.
  db.exec('ALTER TABLE session_handoffs ADD COLUMN api_key_name TEXT')
  return db
}

vi.mock('../db/client.js', () => ({
  get db() {
    return testDb
  },
}))

// Not exercised here — moving a project never touches mem9, and the search never embeds.
vi.mock('./mem9-proxy.js', () => ({ getMem9: vi.fn() }))
vi.mock('../lib/embedder-factory.js', () => ({ createEmbedder: vi.fn() }))
vi.mock('../lib/reranker.js', () => ({ getReranker: vi.fn(), RERANK_OVERFETCH: 4 }))

process.env.GITNEXUS_AUTH_TOKEN = 'test-token'

import { Hono } from 'hono'
import { orgsRouter, projectsRouter } from './organizations.js'
import { intelRouter } from './intel.js'

const app = new Hono()
app.route('/api/orgs', orgsRouter)
app.route('/api/projects', projectsRouter)
app.route('/api/intel', intelRouter)

function seed() {
  testDb.exec(`
    INSERT INTO organizations (id, name, slug) VALUES
      ('org-yulgang', 'Yulgang', 'yulgang'),
      ('org-acme',    'Acme',    'acme');
    INSERT INTO projects (id, org_id, name, slug, indexed_symbols) VALUES
      ('proj-yg-client', 'org-yulgang', 'Yulgang Client', 'yg-client', 500),
      ('proj-yg-server', 'org-yulgang', 'Yulgang Server', 'yg-server', 400),
      ('proj-ac-bill',   'org-acme',    'Acme Billing',   'ac-billing', 200);
  `)
}

async function move(projectId: string, body: Record<string, unknown>) {
  const res = await app.request(`/api/projects/${projectId}/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a test reads whatever JSON the route answered
  return { status: res.status, json: await res.json() as Record<string, any> }
}

async function projectIdsIn(orgId: string): Promise<string[]> {
  const res = await app.request(`/api/orgs/${orgId}/projects`)
  const json = await res.json() as { projects: Array<{ id: string }> }
  return json.projects.map(p => p.id).sort()
}

beforeEach(() => {
  testDb = createTestDb()
  seed()
})

afterEach(() => {
  vi.unstubAllGlobals()
  testDb.close()
})

describe('POST /api/projects/:id/move', () => {
  it('moves the project into the target organization', async () => {
    const { status, json } = await move('proj-yg-client', { orgId: 'org-acme' })

    expect(status).toBe(200)
    expect(json).toMatchObject({ success: true, moved: true, fromOrgId: 'org-yulgang', toOrgId: 'org-acme' })
    expect(await projectIdsIn('org-acme')).toEqual(['proj-ac-bill', 'proj-yg-client'])
    expect(await projectIdsIn('org-yulgang')).toEqual(['proj-yg-server'])
  })

  it('reports a move into the same organization as a no-op', async () => {
    const { status, json } = await move('proj-yg-client', { orgId: 'org-yulgang' })

    expect(status).toBe(200)
    expect(json.moved).toBe(false)
    expect(await projectIdsIn('org-yulgang')).toEqual(['proj-yg-client', 'proj-yg-server'])
  })

  it('refuses a slug the target organization already uses, and leaves the project where it was', async () => {
    testDb.exec(`INSERT INTO projects (id, org_id, name, slug) VALUES ('proj-ac-client', 'org-acme', 'Acme Client', 'yg-client')`)

    const { status, json } = await move('proj-yg-client', { orgId: 'org-acme' })

    expect(status).toBe(409)
    expect(json.error).toContain('"yg-client"')
    expect(await projectIdsIn('org-yulgang')).toEqual(['proj-yg-client', 'proj-yg-server'])
  })

  it('rejects a missing orgId, an unknown project and an unknown organization', async () => {
    expect((await move('proj-yg-client', {})).status).toBe(400)
    expect((await move('proj-nope', { orgId: 'org-acme' })).status).toBe(404)
    expect((await move('proj-yg-client', { orgId: 'org-nope' })).status).toBe(404)
    expect(await projectIdsIn('org-yulgang')).toEqual(['proj-yg-client', 'proj-yg-server'])
  })

  it('takes the cross-repo search boundary with it', async () => {
    const queried: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as { repo?: string }
      if (body.repo) queried.push(basename(body.repo))
      return new Response(`▸ handleLogin\n  → src/login.ts`, { status: 200 })
    }))
    testDb.prepare(
      `INSERT INTO session_handoffs (id, from_agent, project, project_id, task_summary, context, status, api_key_name)
       VALUES ('sess-1', 'claude-code', 'proj-yg-client', 'proj-yg-client', 'test', '{}', 'active', 'alice')`
    ).run()
    const search = async () => {
      queried.length = 0
      await app.request('/api/intel/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key-Owner': 'alice' },
        body: JSON.stringify({ query: 'login' }),
      })
      return [...new Set(queried.filter(r => r.startsWith('proj-')))].sort()
    }

    expect(await search()).toEqual(['proj-yg-client', 'proj-yg-server'])

    await move('proj-yg-client', { orgId: 'org-acme' })

    // The open session did not change; its project's org did, and the scope follows.
    expect(await search()).toEqual(['proj-ac-bill', 'proj-yg-client'])
  })
})
