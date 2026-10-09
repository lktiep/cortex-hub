import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ── In-memory DB for tests ──
let testDb: InstanceType<typeof Database>

function createTestDb() {
  const db = new Database(':memory:')
  const schema = readFileSync(join(__dirname, '../db/schema.sql'), 'utf-8')
  db.exec(schema)
  // Added by the runtime migrations in db/client.ts, not by schema.sql.
  db.exec(`
    ALTER TABLE session_handoffs ADD COLUMN api_key_name TEXT;
    ALTER TABLE session_handoffs ADD COLUMN hostname TEXT;
    ALTER TABLE session_handoffs ADD COLUMN os TEXT;
    ALTER TABLE session_handoffs ADD COLUMN ide TEXT;
    ALTER TABLE session_handoffs ADD COLUMN branch TEXT;
    ALTER TABLE session_handoffs ADD COLUMN capabilities TEXT DEFAULT '[]';
    ALTER TABLE session_handoffs ADD COLUMN role TEXT;
    ALTER TABLE session_handoffs ADD COLUMN last_activity TEXT;
  `)
  return db
}

vi.mock('../db/client.js', () => ({
  get db() {
    return testDb
  },
}))

// quality.ts reaches mem9 for its memory routes; /start never does.
vi.mock('./mem9-proxy.js', () => ({ getMem9: vi.fn() }))

import { Hono } from 'hono'
import { sessionsRouter } from './quality.js'

const app = new Hono()
app.route('/api/sessions', sessionsRouter)

const HUB_URL = 'https://github.com/acme/hub.git'

// The workspace a /cs comes from: what hub-mcp sends plus the key it authenticated.
const workspace = {
  key: 'laptop-key',
  body: { repo: HUB_URL, agentId: 'claude-code', hostname: 'laptop', os: 'darwin', ide: 'claude-code', branch: 'main' },
}

async function start(overrides: { key?: string | null; body?: Record<string, unknown> } = {}): Promise<string> {
  const key = overrides.key === undefined ? workspace.key : overrides.key
  const res = await app.request('/api/sessions/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'X-API-Key-Owner': key } : {}) },
    body: JSON.stringify({ mode: 'development', ...workspace.body, ...overrides.body }),
  })
  expect(res.status).toBe(200)
  return ((await res.json()) as { sessionId: string }).sessionId
}

function activeCount(): number {
  return (testDb.prepare(`SELECT COUNT(*) n FROM session_handoffs WHERE status = 'active'`).get() as { n: number }).n
}

describe('POST /api/sessions/start session reuse', () => {
  beforeEach(() => {
    testDb = createTestDb()
    testDb.exec(`
      INSERT INTO organizations (id, name, slug) VALUES ('org-1', 'Org', 'org');
      INSERT INTO projects (id, org_id, name, slug, git_repo_url) VALUES ('proj-hub', 'org-1', 'Hub', 'hub', '${HUB_URL}');
    `)
  })

  it('hands the same workspace its open session back instead of adding a row', async () => {
    const first = await start()
    testDb.prepare(`UPDATE session_handoffs SET created_at = '2026-01-01T00:00:00Z', last_activity = '2026-01-01T00:00:00Z'`).run()

    const second = await start()
    expect(second).toBe(first)
    expect(activeCount()).toBe(1)

    const row = testDb.prepare('SELECT project, project_id, created_at, last_activity FROM session_handoffs WHERE id = ?').get(first) as {
      project: string
      project_id: string
      created_at: string
      last_activity: string
    }
    expect(row.project).toBe('Hub')
    expect(row.project_id).toBe('proj-hub')
    expect(row.created_at > '2026-01-01T00:00:00Z').toBe(true)
    expect(row.last_activity > '2026-01-01T00:00:00Z').toBe(true)
  })

  it('finds the project by its id whichever spelling of the URL the agent sends', async () => {
    const first = await start()
    const second = await start({ body: { repo: 'https://github.com/acme/hub/' } })
    expect(second).toBe(first)
  })

  it('gives another branch, machine, IDE or key a session of its own', async () => {
    const first = await start()
    const others = [
      await start({ body: { branch: 'feature-x' } }),
      await start({ body: { hostname: 'desktop' } }),
      await start({ body: { ide: 'cursor' } }),
      await start({ key: 'ci-key' }),
    ]
    expect(new Set([first, ...others]).size).toBe(5)
    expect(activeCount()).toBe(5)

    // ...and each of those comes back to its own on the next /cs.
    expect(await start({ body: { branch: 'feature-x' } })).toBe(others[0])
    expect(activeCount()).toBe(5)
  })

  it('does not reopen a session that has ended', async () => {
    const first = await start()
    testDb.prepare(`UPDATE session_handoffs SET status = 'completed' WHERE id = ?`).run(first)

    const second = await start()
    expect(second).not.toBe(first)
    expect(activeCount()).toBe(1)
  })

  it('reuses by repo name when the repo has no project, without crossing into one that does', async () => {
    const first = await start({ body: { repo: 'https://github.com/acme/scratch.git' } })
    expect(await start({ body: { repo: 'https://github.com/acme/scratch' } })).toBe(first)

    const row = testDb.prepare('SELECT project, project_id FROM session_handoffs WHERE id = ?').get(first)
    expect(row).toEqual({ project: 'scratch', project_id: null })

    expect(await start()).not.toBe(first)
  })

  it('matches a workspace that leaves fields out, and keeps it apart from one that sends them', async () => {
    const bare = { hostname: undefined, ide: undefined, branch: undefined }
    const first = await start({ key: null, body: bare })
    expect(await start({ key: null, body: bare })).toBe(first)
    expect(await start()).not.toBe(first)
  })
})
