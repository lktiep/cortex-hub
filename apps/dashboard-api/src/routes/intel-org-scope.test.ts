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

// Not exercised here — the search paths under test never embed or rerank.
vi.mock('../lib/embedder-factory.js', () => ({ createEmbedder: vi.fn() }))
vi.mock('../lib/reranker.js', () => ({ getReranker: vi.fn(), RERANK_OVERFETCH: 4 }))

process.env.GITNEXUS_AUTH_TOKEN = 'test-token'

import { Hono } from 'hono'
import { intelRouter } from './intel.js'

const app = new Hono()
app.route('/api/intel', intelRouter)

// ── Fixture: two organizations, each with related repos ──
//
//   yulgang  — client, server (the cross-repo case the fan-out exists for)
//   acme     — server, billing (a second "server", to prove names resolve per org)

function seed() {
  testDb.exec(`
    INSERT INTO organizations (id, name, slug) VALUES
      ('org-yulgang', 'Yulgang', 'yulgang'),
      ('org-acme',    'Acme',    'acme');
    INSERT INTO projects (id, org_id, name, slug, indexed_symbols) VALUES
      ('proj-yg-client', 'org-yulgang', 'Yulgang Client', 'yg-client', 500),
      ('proj-yg-server', 'org-yulgang', 'Server',         'yg-server', 400),
      ('proj-ac-server', 'org-acme',    'Server',         'ac-server', 300),
      ('proj-ac-bill',   'org-acme',    'Acme Billing',   'ac-billing', 200);
  `)
}

function startSession(apiKeyOwner: string, projectId: string, createdAt: string, status = 'active') {
  testDb.prepare(
    `INSERT INTO session_handoffs
       (id, from_agent, project, project_id, task_summary, context, status, api_key_name, created_at)
     VALUES (?, 'claude-code', ?, ?, 'test', '{}', ?, ?, ?)`
  ).run(`sess-${projectId}-${createdAt}`, projectId, projectId, status, apiKeyOwner, createdAt)
}

// ── GitNexus stub: records which repo every call went to ──
let gitnexusRepos: string[]

function installGitNexusStub() {
  gitnexusRepos = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as { repo?: string }
    if (body.repo) gitnexusRepos.push(basename(body.repo))
    // One flow and one definition, so every queried repo scores as a hit.
    return new Response(`▸ handleLogin\n  → src/login.ts`, { status: 200 })
  }))
}

/** Project ids GitNexus was asked about (clone paths are /app/data/repos/<id>). */
function queriedProjects(): string[] {
  return [...new Set(gitnexusRepos.filter(r => r.startsWith('proj-')))].sort()
}

async function post(path: string, body: Record<string, unknown>, apiKeyOwner?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKeyOwner) headers['X-API-Key-Owner'] = apiKeyOwner
  const res = await app.request(`/api/intel${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  return { status: res.status, json: await res.json() as Record<string, any> }
}

beforeEach(() => {
  testDb = createTestDb()
  seed()
  installGitNexusStub()
})

afterEach(() => {
  vi.unstubAllGlobals()
  testDb.close()
})

describe('multi-project search stays inside one organization', () => {
  it('fans out across the caller\'s organization only, anchored by its session', async () => {
    startSession('alice', 'proj-yg-client', '2026-09-28T10:00:00Z')

    const { status, json } = await post('/search', { query: 'login' }, 'alice')

    expect(status).toBe(200)
    expect(queriedProjects()).toEqual(['proj-yg-client', 'proj-yg-server'])
    expect(json.data.formatted).toContain('Scanned 2 repos')
    expect(json.data.formatted).not.toContain('Acme Billing')
  })

  it('follows the latest session when the same key moves to another organization', async () => {
    startSession('alice', 'proj-yg-client', '2026-09-28T10:00:00Z')
    startSession('alice', 'proj-ac-bill', '2026-09-28T11:00:00Z')

    await post('/search', { query: 'login' }, 'alice')

    expect(queriedProjects()).toEqual(['proj-ac-bill', 'proj-ac-server'])
  })

  it('prefers an active session over a more recent closed one', async () => {
    startSession('alice', 'proj-yg-client', '2026-09-28T10:00:00Z', 'active')
    startSession('alice', 'proj-ac-bill', '2026-09-28T11:00:00Z', 'completed')

    await post('/search', { query: 'login' }, 'alice')

    expect(queriedProjects()).toEqual(['proj-yg-client', 'proj-yg-server'])
  })

  it('honours an explicit orgId over the session', async () => {
    startSession('alice', 'proj-yg-client', '2026-09-28T10:00:00Z')

    await post('/search', { query: 'login', orgId: 'org-acme' }, 'alice')

    expect(queriedProjects()).toEqual(['proj-ac-bill', 'proj-ac-server'])
  })

  it('anchors on scopeRepo when there is no session', async () => {
    await post('/search', { query: 'login', scopeRepo: 'ac-billing' })

    expect(queriedProjects()).toEqual(['proj-ac-bill', 'proj-ac-server'])
  })

  it('refuses to widen when several organizations have code and nothing anchors the call', async () => {
    const { status, json } = await post('/search', { query: 'login' })

    expect(status).toBe(200)
    expect(gitnexusRepos).toEqual([])
    expect(json.data.results).toBeNull()
    expect(json.data.formatted).toContain('needs to know which organization')
    expect(json.data.formatted).toContain('org-yulgang')
    expect(json.data.formatted).toContain('org-acme')
  })

  it('keeps working unanchored when only one organization has indexed code', async () => {
    testDb.exec(`UPDATE projects SET indexed_symbols = 0 WHERE org_id = 'org-acme'`)

    const { json } = await post('/search', { query: 'login' })

    expect(queriedProjects()).toEqual(['proj-yg-client', 'proj-yg-server'])
    expect(json.data.formatted).toContain('Scanned 2 repos')
  })

  it('reports an empty organization instead of falling back to the rest of the hub', async () => {
    testDb.exec(`INSERT INTO organizations (id, name, slug) VALUES ('org-empty', 'Empty', 'empty')`)

    const { json } = await post('/search', { query: 'login', orgId: 'org-empty' })

    expect(gitnexusRepos).toEqual([])
    expect(json.data.formatted).toContain('No indexed repositories found in this organization')
  })
})

describe('a named project', () => {
  it('resolves an ambiguous name to the caller\'s own organization', async () => {
    startSession('alice', 'proj-ac-bill', '2026-09-28T10:00:00Z')

    await post('/search', { query: 'login', projectId: 'Server' }, 'alice')

    expect(queriedProjects()).toEqual(['proj-ac-server'])
  })

  it('prefers an exact name over a partial one', async () => {
    // Put the partial match first in table order, so only the ORDER BY can pick the exact one.
    testDb.exec(`
      DELETE FROM projects WHERE id = 'proj-yg-server';
      INSERT INTO projects (id, org_id, name, slug, indexed_symbols)
        VALUES ('proj-yg-tools', 'org-yulgang', 'Server Tools', 'yg-tools', 100);
      INSERT INTO projects (id, org_id, name, slug, indexed_symbols)
        VALUES ('proj-yg-server', 'org-yulgang', 'Server', 'yg-server', 400);
    `)
    startSession('alice', 'proj-yg-client', '2026-09-28T10:00:00Z')

    await post('/search', { query: 'login', projectId: 'server' }, 'alice')

    expect(queriedProjects()).toEqual(['proj-yg-server'])
  })

  it('is refused when it belongs to a different organization than the one asked for', async () => {
    const { status, json } = await post('/search', { query: 'login', projectId: 'ac-billing', orgId: 'org-yulgang' })

    expect(status).toBe(403)
    expect(json.error).toContain('another organization')
    expect(gitnexusRepos).toEqual([])
  })

  it('is refused by every code-reading route, not only search', async () => {
    const body = { projectId: 'ac-billing', orgId: 'org-yulgang' }
    const results = await Promise.all([
      post('/impact', { ...body, target: 'charge' }),
      post('/context', { ...body, name: 'charge' }),
      post('/cypher', { ...body, query: 'MATCH (n) RETURN n LIMIT 1' }),
      post('/detect-changes', { ...body }),
      post('/code-search', { ...body, query: 'charge' }),
      post('/file-content', { ...body, file: 'src/index.ts' }),
    ])

    expect(results.map(r => r.status)).toEqual([403, 403, 403, 403, 403, 403])
    expect(gitnexusRepos).toEqual([])
  })

  it('is not refused on the strength of a session alone', async () => {
    // One key can have sessions open in two organizations at once, so the latest session
    // cannot prove which one a call came from. Naming the project is the caller's choice.
    startSession('alice', 'proj-yg-client', '2026-09-28T10:00:00Z')

    const { status } = await post('/search', { query: 'login', projectId: 'ac-billing' }, 'alice')

    expect(status).toBe(200)
    expect(queriedProjects()).toEqual(['proj-ac-bill'])
  })

  it('that the database does not know is passed through, not refused', async () => {
    // Legacy GitNexus clone names were never rows in `projects`; they cannot be attributed.
    const { status } = await post('/search', { query: 'login', projectId: 'legacy-clone', orgId: 'org-yulgang' })

    expect(status).toBe(200)
    expect(gitnexusRepos).toContain('legacy-clone')
  })
})

describe('repo listing', () => {
  function stubListRepos() {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([
      { name: 'proj-yg-client', path: '/app/data/repos/proj-yg-client' },
      { name: 'proj-ac-bill', path: '/app/data/repos/proj-ac-bill' },
      { name: 'unattributed-clone', path: '/app/data/repos/unattributed-clone' },
    ]), { status: 200 })))
  }

  it('lists only the organization\'s repos when a scope is known', async () => {
    stubListRepos()

    const res = await app.request('/api/intel/repos?orgId=org-yulgang')
    const json = await res.json() as { data: Array<{ projectId?: string; name?: string }>; orgId: string }

    expect(json.orgId).toBe('org-yulgang')
    const ids = json.data.map(r => r.projectId)
    expect(ids).toContain('proj-yg-client')
    expect(ids).not.toContain('proj-ac-bill')
    expect(json.data.map(r => r.name)).not.toContain('unattributed-clone')
  })

  it('names the organizations instead of their repos when nothing anchors the call', async () => {
    stubListRepos()

    const res = await app.request('/api/intel/repos')
    const json = await res.json() as { data: unknown[]; organizations: Array<{ id: string }> }

    expect(json.data).toEqual([])
    expect(json.organizations.map(o => o.id).sort()).toEqual(['org-acme', 'org-yulgang'])
  })

  it('keeps unattributed clones when only one organization has code — but not another org\'s repo', async () => {
    stubListRepos()
    // Acme still owns proj-ac-bill; its index count is just zero. GitNexus still lists it.
    testDb.exec(`UPDATE projects SET indexed_symbols = 0 WHERE org_id = 'org-acme'`)

    const res = await app.request('/api/intel/repos')
    const json = await res.json() as { data: Array<{ name?: string; projectId?: string }>; orgId: string }

    expect(json.orgId).toBe('org-yulgang')
    const names = json.data.map(r => r.name)
    expect(names).toContain('unattributed-clone')
    expect(names).toContain('Yulgang Client')
    expect(names).not.toContain('Acme Billing')
    expect(names).not.toContain('proj-ac-bill')
  })
})
