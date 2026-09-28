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

// Not exercised here — detect-changes never embeds or reranks.
vi.mock('../lib/embedder-factory.js', () => ({ createEmbedder: vi.fn() }))
vi.mock('../lib/reranker.js', () => ({ getReranker: vi.fn(), RERANK_OVERFETCH: 4 }))

process.env.GITNEXUS_AUTH_TOKEN = 'test-token'

import { Hono } from 'hono'
import { intelRouter } from './intel.js'
import { MAX_DIFF_CHARS } from '../lib/diff-symbols.js'

const app = new Hono()
app.route('/api/intel', intelRouter)

function seed() {
  testDb.exec(`
    INSERT INTO organizations (id, name, slug) VALUES
      ('org-yulgang', 'Yulgang', 'yulgang'),
      ('org-acme',    'Acme',    'acme');
    INSERT INTO projects (id, org_id, name, slug, indexed_symbols) VALUES
      ('proj-yg-server', 'org-yulgang', 'Yulgang Server', 'yg-server', 400),
      ('proj-ac-bill',   'org-acme',    'Acme Billing',   'ac-billing', 200);
  `)
}

function startSession(apiKeyOwner: string, projectId: string) {
  testDb.prepare(
    `INSERT INTO session_handoffs
       (id, from_agent, project, project_id, task_summary, context, status, api_key_name)
     VALUES (?, 'claude-code', ?, ?, 'test', '{}', 'active', ?)`
  ).run(`sess-${projectId}`, projectId, projectId, apiKeyOwner)
}

// ── GitNexus stub ──
//
// Answers like the real cypher tool: HTTP 200 whatever happened. Only the repos in
// `graphs` exist; any other repo, and a call with no repo at all, gets an error body.
type Call = { tool: string; repo?: string; query?: string; base_ref?: string }
let calls: Call[]
let graphs: Set<string>

function answer(markdown: string, rows: number) {
  return `${JSON.stringify({ markdown, row_count: rows }, null, 2)}\n---\nNext: ...`
}

function installGitNexusStub() {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as Omit<Call, 'tool'>
    const tool = String(url).split('/tool/')[1] ?? ''
    const repo = body.repo ? basename(body.repo) : undefined
    calls.push({ ...body, tool, repo })

    if (tool === 'detect_changes') return new Response(JSON.stringify({ summary: { changed_count: 0 } }))
    if (!repo || !graphs.has(repo)) {
      return new Response(`Error: Repository "${body.repo ?? ''}" not found.\n---\nNext: ...`)
    }
    const q = body.query ?? ''
    if (q === 'RETURN 1 AS ok') return new Response(answer('| ok |\n| --- |\n| 1 |', 1))
    if (q.includes('STEP_IN_PROCESS')) {
      return new Response(answer(
        '| nodeId | pid | label | processType | stepCount | step |\n| --- | --- | --- | --- | --- | --- |\n' +
        '| Function:src/login.ts:handleLogin | proc_1 | HandleLogin → CheckPassword | cross_community | 4 | 1 |',
        1,
      ))
    }
    return new Response(answer(
      '| id | name | type | filePath | startLine | endLine |\n| --- | --- | --- | --- | --- | --- |\n' +
      '| Function:src/login.ts:handleLogin | handleLogin | Function | src/login.ts | 10 | 40 |',
      1,
    ))
  }))
}

const DIFF = [
  'diff --git a/src/login.ts b/src/login.ts',
  '--- a/src/login.ts',
  '+++ b/src/login.ts',
  '@@ -20 +20 @@',
  '-  if (!ok) return',
  '+  if (!ok) throw new Error("denied")',
  '',
].join('\n')

type Reply = {
  error?: string
  hint?: string
  data: { repo?: string; summary: Record<string, unknown>; changed_symbols: Array<{ name: string }> }
}

async function post(body: Record<string, unknown>, apiKeyOwner?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKeyOwner) headers['X-API-Key-Owner'] = apiKeyOwner
  const res = await app.request('/api/intel/detect-changes', { method: 'POST', headers, body: JSON.stringify(body) })
  return { status: res.status, json: await res.json() as Reply }
}

beforeEach(() => {
  testDb = createTestDb()
  seed()
  graphs = new Set(['proj-yg-server', 'proj-ac-bill'])
  installGitNexusStub()
})

afterEach(() => {
  vi.unstubAllGlobals()
  testDb.close()
})

describe('POST /api/intel/detect-changes', () => {
  it('maps the caller\'s diff onto the graph of the repo it names', async () => {
    const { status, json } = await post({ diff: DIFF, projectId: 'yg-server' })

    expect(status).toBe(200)
    expect(json.data.changed_symbols.map((s) => s.name)).toEqual(['handleLogin'])
    expect(json.data.summary).toMatchObject({ changed_count: 1, affected_count: 1, risk_level: 'medium' })
    expect(new Set(calls.map((c) => c.repo))).toEqual(new Set(['proj-yg-server']))
  })

  it('takes the repo from the caller\'s session when none is named', async () => {
    startSession('alice', 'proj-ac-bill')

    const { status, json } = await post({ diff: DIFF }, 'alice')

    expect(status).toBe(200)
    expect(json.data.repo).toBe('proj-ac-bill')
    expect(new Set(calls.map((c) => c.repo))).toEqual(new Set(['proj-ac-bill']))
  })

  it('refuses the working-tree scopes without a diff instead of reporting no changes', async () => {
    for (const scope of [undefined, 'all', 'staged', 'unstaged']) {
      const { status, json } = await post({ scope, projectId: 'yg-server' })
      expect(status).toBe(400)
      expect(json.hint).toContain('git diff --staged')
    }
    expect(calls).toEqual([])
  })

  it('never falls back to a repo-less query when the named repo has no graph', async () => {
    graphs = new Set(['proj-ac-bill'])

    const { status, json } = await post({ diff: DIFF, projectId: 'yg-server' })

    expect(status).toBe(404)
    expect(json.hint).toContain('cortex_code_reindex')
    // Every call named a repo: on a hub with one indexed repo, a repo-less query would
    // have mapped this diff onto somebody else's code.
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((c) => c.repo !== undefined)).toBe(true)
  })

  it('refuses a repo of another organization', async () => {
    const { status } = await post({ diff: DIFF, projectId: 'ac-billing', orgId: 'org-yulgang' })
    expect(status).toBe(403)
    expect(calls).toEqual([])
  })

  it('asks for a repo when neither the call nor a session names one', async () => {
    const { status, json } = await post({ diff: DIFF })
    expect(status).toBe(400)
    expect(json.hint).toContain('repo')
  })

  it('rejects a diff over the size limit before touching the graph', async () => {
    const { status } = await post({ diff: 'x'.repeat(MAX_DIFF_CHARS + 1), projectId: 'yg-server' })
    expect(status).toBe(413)
    expect(calls).toEqual([])
  })

  it('still compares indexed code against a ref, which the hub can see', async () => {
    expect((await post({ scope: 'compare', projectId: 'yg-server' })).status).toBe(400)

    const { status } = await post({ scope: 'compare', baseRef: 'v0.8.3', projectId: 'yg-server' })
    expect(status).toBe(200)
    expect(calls.find((c) => c.tool === 'detect_changes')).toMatchObject({ base_ref: 'v0.8.3', repo: 'proj-yg-server' })
  })
})
