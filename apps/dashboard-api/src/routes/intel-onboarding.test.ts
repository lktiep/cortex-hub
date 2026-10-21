import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const reposDir = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/intel-onboarding-${process.pid}`
  process.env.REPOS_DIR = dir
  return dir
})

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

let testDb: InstanceType<typeof Database>

function createTestDb() {
  const db = new Database(':memory:')
  db.exec(readFileSync(join(__dirname, '../db/schema.sql'), 'utf-8'))
  // Added by the runtime migration in db/client.ts, not by schema.sql.
  db.exec('ALTER TABLE session_handoffs ADD COLUMN api_key_name TEXT')
  return db
}

vi.mock('../db/client.js', () => ({ get db() { return testDb } }))
vi.mock('../lib/embedder-factory.js', () => ({ createEmbedder: () => ({ embed: async () => [0.1, 0.2, 0.3] }) }))
vi.mock('../lib/reranker.js', () => ({ getReranker: () => null, RERANK_OVERFETCH: 4 }))

import { Hono } from 'hono'
import { intelRouter, notIndexedYet, rewriteGitNexusHints } from './intel.js'

const app = new Hono()
app.route('/api/intel', intelRouter)

// One game, three repos: client and server indexed, tools registered a minute ago.
function seed() {
  testDb.exec(`
    INSERT INTO organizations (id, name, slug) VALUES ('org-g', 'Game', 'game'), ('org-x', 'Other', 'other');
    INSERT INTO projects (id, org_id, name, slug, indexed_symbols) VALUES
      ('proj-client', 'org-g', 'game-client', 'game-client', 900),
      ('proj-server', 'org-g', 'game-server', 'game-server', 700),
      ('proj-tools',  'org-g', 'game-tools',  'game-tools',  0),
      ('proj-else',   'org-x', 'elsewhere',   'elsewhere',   500);
  `)
}

function job(status: string, extra: { progress?: number; error?: string; started_at?: string } = {}) {
  testDb.prepare(
    `INSERT INTO index_jobs (id, project_id, status, progress, error, started_at, created_at)
     VALUES (?, 'proj-tools', ?, ?, ?, ?, '2026-10-21T10:00:00Z')`
  ).run(`job-${status}`, status, extra.progress ?? 0, extra.error ?? null, extra.started_at ?? null)
}

/** What the GitNexus watchdog wrote for proj-tools; see infra/gitnexus-entrypoint.sh. */
function graph(line: string) {
  mkdirSync(join(reposDir, '.graph-status'), { recursive: true })
  writeFileSync(join(reposDir, '.graph-status', 'proj-tools'), `${line}\n`)
}

/** The analyzer has written its output into the checkout. */
function analyzedCheckout() {
  mkdirSync(join(reposDir, 'proj-tools', '.gitnexus'), { recursive: true })
}

const NOW = Date.parse('2026-10-21T10:06:00Z')
const at = (iso: string) => Date.parse(iso) / 1000

async function post(path: string, body: Record<string, unknown>) {
  const res = await app.request(`/api/intel${path}`, {
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
})

afterEach(() => {
  vi.unstubAllGlobals()
  testDb.close()
  rmSync(reposDir, { recursive: true, force: true })
})

describe('a repo that is still being indexed', () => {
  it('says how far indexing has got', () => {
    job('analyzing', { progress: 40, started_at: '2026-10-21T10:01:00Z' })

    expect(notIndexedYet('game-tools', 'org-g', NOW)).toBe(
      '⏳ game-tools is still being indexed (analyzing, 40%, started 5 min ago). Use Grep/rg on your checkout meanwhile.',
    )
  })

  it('says why indexing failed, without the credentials in a clone URL', () => {
    job('error', { error: '\nfatal: could not read from https://x-access-token:secret1@example.com/acme/tools.git\nmore' })

    const text = notIndexedYet('game-tools', 'org-g', NOW)

    expect(text).toContain('Indexing game-tools failed: fatal: could not read from https://example.com/acme/tools.git.')
    expect(text).not.toContain('secret1')
  })

  it('says when indexing never started', () => {
    expect(notIndexedYet('game-tools', 'org-g', NOW)).toContain('has not been indexed')
  })

  // The index job is done once it has cloned the repo, before the graph exists.
  it('says the graph is waiting its turn when the clone is done but nothing has analysed it', () => {
    job('done')

    expect(notIndexedYet('game-tools', 'org-g', NOW)).toBe(
      '⏳ game-tools is cloned and waiting for its code graph to be built. Use Grep/rg on your checkout meanwhile.',
    )
  })

  it('says the graph is being built, even when the job counted symbols of its own', () => {
    job('done')
    testDb.prepare("UPDATE projects SET indexed_symbols = 42 WHERE id = 'proj-tools'").run()
    graph(`analyzing c0ffee12 ${at('2026-10-21T09:58:00Z')}`)

    expect(notIndexedYet('game-tools', 'org-g', NOW)).toBe(
      '⏳ The code graph of game-tools is being built (started 8 min ago; a large repo takes several). Use Grep/rg on your checkout meanwhile.',
    )
  })

  it('says why building the graph failed and when it is tried again', () => {
    job('done')
    graph(`failed c0ffee12 ${at('2026-10-21T10:01:00Z')} 2 137 600`)

    const text = notIndexedYet('game-tools', 'org-g', NOW)

    expect(text).toContain('Building the code graph of game-tools failed 2 times (the analyzer was killed, most likely out of memory)')
    expect(text).toContain('retried in 5 min, or on a new commit')
  })

  it('says nothing once the graph is built, or when the analyzer has run without a status to show', () => {
    job('done')
    graph(`analyzed c0ffee12 ${at('2026-10-21T10:01:00Z')}`)
    expect(notIndexedYet('game-tools', 'org-g', NOW)).toBeUndefined()

    rmSync(join(reposDir, '.graph-status'), { recursive: true })
    analyzedCheckout()
    testDb.prepare("UPDATE projects SET indexed_symbols = 42 WHERE id = 'proj-tools'").run()
    expect(notIndexedYet('game-tools', 'org-g', NOW)).toBeUndefined()
  })

  it('says nothing about an indexed repo, or one the hub does not know', () => {
    expect(notIndexedYet('game-client', 'org-g', NOW)).toBeUndefined()
    expect(notIndexedYet('legacy-clone', 'org-g', NOW)).toBeUndefined()
  })

  it('is what a search and a graph lookup answer, in place of the graph\'s 500', async () => {
    job('ingesting', { progress: 80 })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Repository "proj-tools" not found', { status: 500 })))

    const search = await post('/search', { query: 'login', projectId: 'game-tools', orgId: 'org-g' })
    const context = await post('/context', { name: 'login', projectId: 'game-tools', orgId: 'org-g' })

    expect(search.status).toBe(200)
    expect(search.json.data.formatted).toContain('game-tools is still being indexed (ingesting, 80%')
    expect(context.status).toBe(409)
    expect(context.json.error).toContain('game-tools is still being indexed')
  })

  it('does not stand in for the graph when the graph answers', async () => {
    job('analyzing')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Function login → src/login.ts:3', { status: 200 })))

    const context = await post('/context', { name: 'login', projectId: 'game-tools', orgId: 'org-g' })

    expect(context.status).toBe(200)
  })
})

describe('code search across the organization', () => {
  let searched: string[]

  beforeEach(() => {
    searched = []
    const scores: Record<string, number> = { 'proj-client': 0.42, 'proj-server': 0.61 }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const m = /\/collections\/cortex-project-([^/]+)\/points\/search$/.exec(url)
      if (!m) return new Response('Not found', { status: 404 })
      const id = `proj-${m[1]!.replace(/^proj-/, '')}`
      searched.push(id)
      if (!(id in scores)) return new Response('Not found: Collection doesn\'t exist', { status: 404 })
      const result = ['main', 'dev'].map((branch) => ({
        score: scores[id],
        payload: { file_path: `src/${id}.ts`, chunk_index: 0, branch, content: 'x' },
      }))
      return new Response(JSON.stringify({ result }), { status: 200 })
    }))
  })

  it('asks every repo of the organization once, and ranks the hits by score with their repo', async () => {
    const { status, json } = await post('/code-search', { query: 'login', orgId: 'org-g' })

    expect(status).toBe(200)
    expect(searched.sort()).toEqual(['proj-client', 'proj-server'])
    expect(json.data.results.map((r: { repo: string; filePath: string }) => `${r.repo}:${r.filePath}`)).toEqual([
      'game-server:src/proj-server.ts',
      'game-client:src/proj-client.ts',
    ])
  })

  it('leaves out the repo the caller already searched', async () => {
    const { json } = await post('/code-search', { query: 'login', orgId: 'org-g', exclude: 'game-client' })

    expect(searched).toEqual(['proj-server'])
    expect(json.data.results).toHaveLength(1)
  })

  it('takes its organization from the caller\'s checkout', async () => {
    const { status } = await post('/code-search', { query: 'login', scopeRepo: 'game-client' })

    expect(status).toBe(200)
    expect(searched).not.toContain('proj-else')
  })

  it('lists a file once, by its best chunk, and no more than perRepo files of one repo', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const server = url.includes('proj-server')
      const result = (server ? ['a', 'a', 'b', 'c'] : ['d']).map((f, i) => ({
        score: (server ? 0.7 : 0.5) - i / 100,
        payload: { file_path: `src/${f}.ts`, chunk_index: i, content: 'x' },
      }))
      return new Response(JSON.stringify({ result }), { status: 200 })
    }))

    const { json } = await post('/code-search', { query: 'login', orgId: 'org-g', perRepo: 2 })

    expect(json.data.results.map((r: { repo: string; filePath: string }) => `${r.repo}:${r.filePath}`)).toEqual([
      'game-server:src/a.ts',
      'game-server:src/b.ts',
      'game-client:src/d.ts',
    ])
  })

  // Every repo nobody put in an organization lands in the personal one, unrelated to the rest.
  it('lists no repos beside the caller\'s in the personal organization, but searches it when asked', async () => {
    testDb.exec(`INSERT INTO projects (id, org_id, name, slug, indexed_symbols) VALUES
      ('proj-mine', 'org-default', 'mine', 'mine', 10), ('proj-other', 'org-default', 'unrelated', 'unrelated', 10)`)

    const beside = await post('/code-search', { query: 'login', scopeRepo: 'mine', exclude: 'mine' })
    expect(beside.json.data.results).toEqual([])
    expect(searched).toEqual([])

    await post('/code-search', { query: 'login', scopeRepo: 'mine' })
    expect(searched.sort()).toEqual(['proj-mine', 'proj-other'])
  })

  it('refuses to guess between organizations', async () => {
    const { status, json } = await post('/code-search', { query: 'login' })

    expect(status).toBe(400)
    expect(json.error).toContain('name the repo, or pass org')
    expect(searched).toEqual([])
  })
})

// Every chunk is stored once per indexed branch; unfiltered, the copies used up the search depth.
describe('code search on a repo indexed on several branches', () => {
  let filters: unknown[]

  function qdrant(onlyOn?: string) {
    filters = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (!url.endsWith('/points/search')) return new Response('{"result":{}}', { status: 200 })
      const { filter } = JSON.parse(String(init?.body)) as { filter?: { must: Array<{ match: { value: string } }> } }
      filters.push(filter)
      const branch = filter?.must[0]?.match.value
      const result = onlyOn && branch !== undefined && branch !== onlyOn ? [] : [
        { score: 0.5, payload: { file_path: 'src/login.ts', chunk_index: 0, branch: branch ?? onlyOn, content: 'x' } },
      ]
      return new Response(JSON.stringify({ result }), { status: 200 })
    }))
  }

  beforeEach(() => {
    testDb.prepare("UPDATE projects SET default_branch = 'main' WHERE org_id = 'org-g'").run()
  })

  it('searches the default branch when the caller names none, and the branch it names', async () => {
    qdrant()

    await post('/code-search', { query: 'login', projectId: 'game-client', orgId: 'org-g' })
    await post('/code-search', { query: 'login', projectId: 'game-client', orgId: 'org-g', branch: 'dev' })
    await post('/code-search', { query: 'login', orgId: 'org-g' })

    const branches = filters.map((f) => (f as { must: Array<{ match: { value: string } }> } | undefined)?.must[0]?.match.value)
    expect(branches).toEqual(['main', 'dev', 'main', 'main'])
  })

  it('searches every branch when the default one holds nothing', async () => {
    qdrant('feature')

    const one = await post('/code-search', { query: 'login', projectId: 'game-client', orgId: 'org-g' })
    const org = await post('/code-search', { query: 'login', orgId: 'org-g', exclude: 'game-server' })

    expect(one.json.data.results).toHaveLength(1)
    expect(org.json.data.results).toHaveLength(1)
    expect(filters).toEqual([expect.anything(), undefined, expect.anything(), undefined])
  })
})

describe('graph flows from every repo of the organization', () => {
  it('print no "undefined" kind', () => {
    expect(rewriteGitNexusHints('1. Main → Visit (4 steps)\n   undefined problems → scripts/check.mjs:19')).toBe(
      '1. Main → Visit (4 steps)\n   problems → scripts/check.mjs:19',
    )
  })
})
