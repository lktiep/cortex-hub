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
    ALTER TABLE session_handoffs ADD COLUMN last_activity TEXT;
    ALTER TABLE query_logs ADD COLUMN input_size INTEGER DEFAULT 0;
    ALTER TABLE query_logs ADD COLUMN output_size INTEGER DEFAULT 0;
    ALTER TABLE query_logs ADD COLUMN compute_tokens INTEGER DEFAULT 0;
    ALTER TABLE query_logs ADD COLUMN compute_model TEXT;
  `)
  return db
}

vi.mock('../db/client.js', () => ({
  get db() {
    return testDb
  },
}))

// stats.ts reads the GitNexus repo list for its overview; the heartbeat never does.
vi.mock('./intel.js', () => ({ getGitNexusRepos: vi.fn() }))

import { Hono } from 'hono'
import { statsRouter } from './stats.js'

const app = new Hono()
app.route('/api/metrics', statsRouter)

// Every session starts with this last_activity; a touched one moves to now.
const SEEDED = '2026-01-01T00:00:00Z'

// ── Fixture: one key with sessions in two projects, a second key, a legacy row ──
//
// Every agent calls itself "claude-code", including the one on the "hung" key: the
// heartbeat has to go by the key, which is what query-log's agentId carries.

function seed() {
  testDb.exec(`
    INSERT INTO organizations (id, name, slug) VALUES ('org-1', 'Org', 'org');
    INSERT INTO projects (id, org_id, name, slug) VALUES
      ('proj-farm', 'org-1', 'Farm', 'farm'),
      ('proj-hub',  'org-1', 'Hub',  'hub');
  `)
  const session = testDb.prepare(
    `INSERT INTO session_handoffs
       (id, from_agent, project, project_id, task_summary, context, status, api_key_name, created_at, last_activity)
     VALUES (?, ?, ?, ?, 'test', '{}', ?, ?, ?, ?)`
  )
  const rows: Array<[id: string, agent: string, projectId: string, status: string, key: string | null, createdAt: string]> = [
    ['s-farm-old', 'claude-code', 'proj-farm', 'active',    'claude-code', '2026-10-01T00:00:00Z'],
    ['s-farm',     'claude-code', 'proj-farm', 'active',    'claude-code', '2026-10-08T00:00:00Z'],
    ['s-hub',      'claude-code', 'proj-hub',  'active',    'claude-code', '2026-10-09T00:00:00Z'],
    ['s-ended',    'claude-code', 'proj-hub',  'completed', 'claude-code', '2026-10-09T13:00:00Z'],
    ['s-hung',     'claude-code', 'proj-farm', 'active',    'hung',        '2026-10-09T12:00:00Z'],
    ['s-legacy',   'old-agent',   'proj-farm', 'active',    null,          '2026-09-01T00:00:00Z'],
  ]
  for (const [id, agent, projectId, status, key, createdAt] of rows) {
    session.run(id, agent, projectId, projectId, status, key, createdAt, SEEDED)
  }
}

async function logCall(body: Record<string, unknown>) {
  const res = await app.request('/api/metrics/query-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'cortex_code_search', status: 'ok', latencyMs: 5, ...body }),
  })
  expect(res.status).toBe(200)
}

/** Sessions whose last_activity the calls moved off the seeded value. */
function touched(): string[] {
  return (testDb.prepare('SELECT id FROM session_handoffs WHERE last_activity != ? ORDER BY id').all(SEEDED) as Array<{ id: string }>)
    .map((r) => r.id)
}

describe('POST /query-log session heartbeat', () => {
  beforeEach(() => {
    testDb = createTestDb()
    seed()
  })

  it('touches only the calling key\'s newest active session', async () => {
    await logCall({ agentId: 'claude-code' })
    expect(touched()).toEqual(['s-hub'])
  })

  it('leaves another key\'s sessions alone though its agent has the same name', async () => {
    await logCall({ agentId: 'hung' })
    expect(touched()).toEqual(['s-hung'])
  })

  it('prefers the caller\'s session in the project the call is about', async () => {
    await logCall({ agentId: 'claude-code', projectId: 'farm' })
    expect(touched()).toEqual(['s-farm'])
  })

  it('falls back to the newest session when the caller has none in that project', async () => {
    testDb.exec(`INSERT INTO projects (id, org_id, name, slug) VALUES ('proj-other', 'org-1', 'Other', 'other')`)
    await logCall({ agentId: 'claude-code', projectId: 'proj-other' })
    expect(touched()).toEqual(['s-hub'])
  })

  it('touches exactly the session a call names, and nothing for one already ended', async () => {
    await logCall({ agentId: 'claude-code', tool: 'cortex_session_end', params: { sessionId: 's-farm-old' } })
    expect(touched()).toEqual(['s-farm-old'])

    await logCall({ agentId: 'claude-code', tool: 'cortex_session_end', params: { sessionId: 's-ended' } })
    expect(touched()).toEqual(['s-farm-old'])
  })

  it('matches a row from before api_key_name by its agent, and an unknown caller by nothing', async () => {
    await logCall({ agentId: 'old-agent' })
    expect(touched()).toEqual(['s-legacy'])

    await logCall({})
    expect(touched()).toEqual(['s-legacy'])
  })

  it('still logs the call', async () => {
    await logCall({ agentId: 'claude-code', projectId: 'farm', params: { query: 'x' } })
    const rows = testDb.prepare('SELECT agent_id, tool, project_id, params FROM query_logs').all()
    expect(rows).toEqual([{ agent_id: 'claude-code', tool: 'cortex_code_search', project_id: 'proj-farm', params: '{"query":"x"}' }])
  })
})
