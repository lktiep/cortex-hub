import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

// intel.ts reads REPOS_DIR when it loads, and imports load before this file's body runs.
const reposDir = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/intel-code-search-${process.pid}`
  process.env.REPOS_DIR = dir
  return dir
})

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

vi.mock('../lib/embedder-factory.js', () => ({
  createEmbedder: () => ({ embed: async () => [0.1, 0.2, 0.3] }),
}))
vi.mock('../lib/reranker.js', () => ({ getReranker: () => null, RERANK_OVERFETCH: 4 }))

import { Hono } from 'hono'
import { addCallSites, formatCypherRaw, intelRouter, locateChunk, rewriteGitNexusHints } from './intel.js'

const app = new Hono()
app.route('/api/intel', intelRouter)

function seed() {
  testDb.exec(`
    INSERT INTO organizations (id, name, slug) VALUES ('org-a', 'Org A', 'org-a');
    INSERT INTO projects (id, org_id, name, slug) VALUES ('proj-hub', 'org-a', 'cortex-hub', 'cortex-hub');
  `)
}

interface Point { file: string; chunk: number; branch: string; score: number; content?: string }

// ── Qdrant stub: no sparse vector, so the plain vector search runs ──
let searched: Array<{ collection: string; limit: number }>
let points: Point[]

function installQdrantStub() {
  searched = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const search = /\/collections\/([^/]+)\/points\/search$/.exec(url)
    if (!search) return new Response('Not found', { status: 404 })
    const body = JSON.parse(init?.body ?? '{}') as { limit: number }
    searched.push({ collection: search[1] ?? '', limit: body.limit })
    const result = points.slice(0, body.limit).map((p, i) => ({
      id: String(i),
      score: p.score,
      payload: { file_path: p.file, chunk_index: p.chunk, branch: p.branch, content: p.content ?? `// File: ${p.file}` },
    }))
    return new Response(JSON.stringify({ result }), { status: 200 })
  }))
}

async function search(body: Record<string, unknown>) {
  const res = await app.request('/api/intel/code-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a test reads whatever JSON the route answered
  return { status: res.status, json: await res.json() as Record<string, any> }
}

beforeEach(() => {
  testDb = createTestDb()
  seed()
  points = []
  installQdrantStub()
})

afterEach(() => {
  vi.unstubAllGlobals()
  testDb.close()
  rmSync(reposDir, { recursive: true, force: true })
})

describe('code search finds the project an agent names', () => {
  it('searches the project id collection when given the repo name', async () => {
    points = [{ file: 'src/a.ts', chunk: 0, branch: 'master', score: 0.9 }]

    const { status, json } = await search({ query: 'verify key', projectId: 'cortex-hub' })

    expect(status).toBe(200)
    expect(searched.map((s) => s.collection)).toEqual(['cortex-project-proj-hub'])
    expect(json.data.results).toHaveLength(1)
  })

  it('still takes a project id as it is', async () => {
    await search({ query: 'verify key', projectId: 'proj-hub' })

    expect(searched.map((s) => s.collection)).toEqual(['cortex-project-proj-hub'])
  })
})

describe('code search returns each place in the code once', () => {
  it('keeps the best copy of a chunk indexed on several branches', async () => {
    points = [
      { file: 'src/a.ts', chunk: 0, branch: 'master', score: 0.9 },
      { file: 'src/a.ts', chunk: 0, branch: 'feat/x', score: 0.89 },
      { file: 'src/b.ts', chunk: 1, branch: 'master', score: 0.8 },
      { file: 'src/a.ts', chunk: 0, branch: 'fix/y', score: 0.7 },
      { file: 'src/a.ts', chunk: 1, branch: 'master', score: 0.6 },
      { file: 'src/c.ts', chunk: 0, branch: 'master', score: 0.5 },
    ]

    const { json } = await search({ query: 'verify key', projectId: 'cortex-hub', limit: 3 })

    // Over-fetched, so the copies do not leave the page short.
    expect(searched[0]?.limit).toBeGreaterThan(3)
    const places = (json.data.results as Array<{ filePath: string; chunkIndex: number; branch: string }>)
      .map((r) => `${r.filePath}#${r.chunkIndex}@${r.branch}`)
    expect(places).toEqual(['src/a.ts#0@master', 'src/b.ts#1@master', 'src/a.ts#1@master'])
  })
})

describe('code search says which lines a hit is', () => {
  const file = ['import x from "x"', '', 'export function lookupApiKey(token: string) {', '  return find(token)', '}', ''].join('\n')

  it('finds a first chunk under its file header', () => {
    expect(locateChunk(file, '// File: src/a.ts\nimport x from "x"\n\nexport function')).toEqual({ startLine: 1, endLine: 3 })
  })

  it('finds a chunk that opens mid-line', () => {
    expect(locateChunk(file, 'nction lookupApiKey(token: string) {\n  return find(token)\n')).toEqual({ startLine: 3, endLine: 4 })
  })

  it('gives no lines for text the checkout does not hold', () => {
    expect(locateChunk(file, 'export function somethingElse() {}')).toBeUndefined()
  })

  it('adds the lines to a hit from the project checkout', async () => {
    mkdirSync(join(reposDir, 'proj-hub', 'src'), { recursive: true })
    writeFileSync(join(reposDir, 'proj-hub', 'src', 'a.ts'), file)
    points = [
      { file: 'src/a.ts', chunk: 0, branch: 'master', score: 0.9, content: 'export function lookupApiKey(token: string) {\n  return find(token)\n}' },
      { file: '../../etc/passwd', chunk: 0, branch: 'master', score: 0.8, content: 'root' },
    ]

    const { json } = await search({ query: 'verify key', projectId: 'cortex-hub' })

    expect(json.data.results[0]).toMatchObject({ filePath: 'src/a.ts', startLine: 3, endLine: 5 })
    expect(json.data.results[1].startLine).toBeUndefined()
  })
})

describe('graph results do not print a missing kind', () => {
  it('drops "undefined" from flow steps and edges, and keeps everything else', () => {
    const raw = [
      '1. KeysPage → TickedPermissions (3 steps, 2 symbols)',
      '   undefined KeysPage → apps/web/keys/page.tsx:18',
      '  ← [calls] undefined index.ts → apps/hub-mcp/src/index.ts',
      '  → [accesses] Function CACHE_TTL_MS → apps/hub-mcp/src/middleware/auth.ts',
    ].join('\n')

    expect(rewriteGitNexusHints(raw)).toBe([
      '1. KeysPage → TickedPermissions (3 steps, 2 symbols)',
      '   KeysPage → apps/web/keys/page.tsx:18',
      '  ← [calls] index.ts → apps/hub-mcp/src/index.ts',
      '  → [accesses] Function CACHE_TTL_MS → apps/hub-mcp/src/middleware/auth.ts',
    ].join('\n'))
  })
})

describe('graph callers come with the lines that call', () => {
  const index = ['import { validateApiKey } from "./auth"', '', 'app.post("/mcp", async (c) => {', '  const ok = await validateApiKey(c)', '  return validateApiKeyCached(ok)', '})'].join('\n')
  const raw = [
    'Function validateApiKey → src/auth.ts:23-105',
    '',
    'Called/imported by (3):',
    '  ← [calls] index.ts → src/index.ts',
    '  ← [calls] Function boot → src/boot.ts:4-9',
    '  ← [calls] gone.ts → src/gone.ts',
    '',
    'Calls/imports (1):',
    '  → [calls] publicOrigin → src/origin.ts',
  ].join('\n')

  it('adds the call lines to a bare caller path, and nothing to an import or a whole word elsewhere', () => {
    const out = addCallSites(raw, 'validateApiKey', (path) => (path === 'src/index.ts' ? index : undefined))

    expect(out.split('\n')).toEqual([
      'Function validateApiKey → src/auth.ts:23-105',
      '',
      'Called/imported by (3):',
      '  ← [calls] index.ts → src/index.ts:4',
      '  ← [calls] Function boot → src/boot.ts:4-9',
      '  ← [calls] gone.ts → src/gone.ts',
      '',
      'Calls/imports (1):',
      '  → [calls] publicOrigin → src/origin.ts',
    ])
  })

  it('finds a method asked for as Class.method', () => {
    const out = addCallSites('  ← [calls] a.ts → src/a.ts', 'Search.run', () => 'x\nawait search.run(q)\nrunAll()')

    expect(out).toBe('  ← [calls] a.ts → src/a.ts:2')
  })

  it('names a few lines and counts the rest', () => {
    const many = Array.from({ length: 9 }, () => 'f()').join('\n')

    expect(addCallSites('  ← [calls] a.ts → src/a.ts', 'f', () => many)).toBe('  ← [calls] a.ts → src/a.ts:1,2,3,4,5,6 (+3 more)')
  })

  it('reads the callers from the project checkout in a context lookup', async () => {
    mkdirSync(join(reposDir, 'proj-hub', 'src'), { recursive: true })
    writeFileSync(join(reposDir, 'proj-hub', 'src', 'index.ts'), index)
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url.endsWith('/tool/context') ? new Response(raw, { status: 200 }) : new Response('Not found', { status: 404 })))

    for (const projectId of ['cortex-hub', undefined]) {
      if (!projectId) writeFileSync(join(reposDir, 'proj-hub', 'src', 'auth.ts'), 'export function validateApiKey() {}')
      const res = await app.request('/api/intel/context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'validateApiKey', projectId }),
      })
      const json = await res.json() as { data: { results: { raw: string } } }

      expect(json.data.results.raw).toContain('  ← [calls] index.ts → src/index.ts:4\n')
    }
  })

  it('adds them to the direct callers of an upstream impact', async () => {
    mkdirSync(join(reposDir, 'proj-hub', 'src'), { recursive: true })
    writeFileSync(join(reposDir, 'proj-hub', 'src', 'index.ts'), index)
    const impact = [
      'Blast radius for  validateApiKey (upstream): 2 symbol(s) depends on this (will break if changed)',
      '',
      'd=1: WILL BREAK (direct) (1)',
      '  undefined index.ts → src/index.ts [CALLS] (conf: 0.85)',
      '  undefined index.ts → src/index.ts [IMPORTS]',
      '---',
      'Next: Review d=1 items first (WILL BREAK). Read the source with cat to understand the code, then make your fix.',
    ].join('\n')
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url.endsWith('/tool/impact') ? new Response(impact, { status: 200 }) : new Response('Not found', { status: 404 })))

    const res = await app.request('/api/intel/impact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'validateApiKey', projectId: 'cortex-hub', direction: 'upstream' }),
    })
    const raw = (await res.json() as { data: { results: { raw: string } } }).data.results.raw

    expect(raw).toContain('\n  index.ts → src/index.ts:4 [CALLS] (conf: 0.85)\n  index.ts → src/index.ts [IMPORTS]\n')
    expect(raw).not.toContain('undefined')
    expect(raw).not.toContain('with cat')
  })
})

describe('a cypher answer reads as a table', () => {
  it('unwraps the JSON the graph wraps a table in', () => {
    const raw = `${JSON.stringify({ markdown: '| a.name |\n| --- |\n| boot |', row_count: 1 }, null, 2)}\n---\nNext: To explore a result symbol in depth, run gitnexus-context "<name>"`

    expect(formatCypherRaw(raw)).toBe('| a.name |\n| --- |\n| boot |\n(1 row)\n---\nNext: To explore a result symbol in depth, run cortex_code_context "<name>"')
  })

  it('names the schema when a guessed edge table does not exist', () => {
    const out = formatCypherRaw('Error: Prepare failed: Binder exception: Table CALLS does not exist.')

    expect(out).toContain("[r:CodeRelation {type: 'CALLS'}]")
    expect(formatCypherRaw('Query returned 0 rows.')).toBe('Query returned 0 rows.')
  })
})

describe('a graph lookup without a repo stays in the organization', () => {
  let asked: string[]

  beforeEach(() => {
    testDb.exec(`
      UPDATE projects SET indexed_symbols = 10 WHERE id = 'proj-hub';
      INSERT INTO projects (id, org_id, name, slug, indexed_symbols) VALUES ('proj-web', 'org-a', 'web', 'web', 10);
      INSERT INTO organizations (id, name, slug) VALUES ('org-b', 'Org B', 'org-b');
      INSERT INTO projects (id, org_id, name, slug, indexed_symbols) VALUES ('proj-hidden', 'org-b', 'hidden', 'hidden', 10);
    `)
    asked = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
      const repo = (JSON.parse(init?.body ?? '{}') as { repo?: string }).repo ?? ''
      asked.push(repo.split('/').pop() ?? '')
      if (!repo) return new Response('Multiple repositories indexed. Available: cortex-hub, web, hidden', { status: 500 })
      if (repo.endsWith('proj-hub')) return new Response('Function lookupApiKey → src/a.ts:3-5', { status: 200 })
      return new Response("Symbol 'lookupApiKey' not found", { status: 200 })
    }))
  })

  async function context(body: Record<string, unknown>) {
    const res = await app.request('/api/intel/context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'lookupApiKey', ...body }),
    })
    return { status: res.status, text: await res.text() }
  }

  it('asks each project of the organization and keeps the one that found it', async () => {
    const { status, text } = await context({ orgId: 'org-a' })

    expect(status).toBe(200)
    expect(text).toContain('src/a.ts:3-5')
    expect(asked.sort()).toEqual(['proj-hub', 'proj-web'])
  })

  it('refuses to guess between organizations, and names no repo', async () => {
    const { status, text } = await context({})

    expect(status).toBe(500)
    expect(text).toContain('name the repo, or pass org')
    expect(text).not.toMatch(/hidden|Available/)
    expect(asked).toEqual([])
  })

  it('passes on a refusal from the graph without its list of every repo', async () => {
    testDb.exec('UPDATE projects SET indexed_symbols = 0')

    const { status, text } = await context({ orgId: 'org-a' })

    expect(status).toBe(500)
    expect(text).toContain('Multiple repositories indexed')
    expect(text).not.toMatch(/hidden|Available/)
  })
})
