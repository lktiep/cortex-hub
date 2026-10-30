import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { execFileSync } from 'child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// REPOS_DIR is read when intel.ts loads.
const reposDir = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? process.env.TEMP ?? '/tmp'}/intel-grep-${process.pid}`
  process.env.REPOS_DIR = dir
  return dir
})

let testDb: InstanceType<typeof Database>

vi.mock('../db/client.js', () => ({
  get db() {
    return testDb
  },
}))
vi.mock('../lib/embedder-factory.js', () => ({ createEmbedder: vi.fn() }))
vi.mock('../lib/reranker.js', () => ({ getReranker: vi.fn(), RERANK_OVERFETCH: 4 }))

import { Hono } from 'hono'
import { intelRouter } from './intel.js'

const app = new Hono()
app.route('/api/intel', intelRouter)

/** A checkout under REPOS_DIR with these files committed. */
function checkout(projectId: string, files: Record<string, string>) {
  const dir = join(reposDir, projectId)
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir })
  git('init', '-q')
  git('add', '.')
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init')
}

beforeAll(() => {
  checkout('proj-server', { 'src/Player.cs': 'case 144: // talk\ncase 145:\n', 'src/Map.cs': 'case 144: // warp\n' })
  checkout('proj-tools', { 'decoder.py': 'OPCODES = {144: "TalkNpc"}\n' })
  checkout('proj-other', { 'x.cs': 'case 144: // another organization\n' })
})

afterAll(() => rmSync(reposDir, { recursive: true, force: true }))

beforeEach(() => {
  testDb = new Database(':memory:')
  testDb.exec(readFileSync(join(__dirname, '../db/schema.sql'), 'utf-8'))
  testDb.exec(`
    INSERT INTO organizations (id, name, slug) VALUES ('org-game', 'Game', 'game'), ('org-other', 'Other', 'other');
    INSERT INTO projects (id, org_id, name, slug, indexed_symbols) VALUES
      ('proj-server', 'org-game',  'Server', 'server', 10),
      ('proj-tools',  'org-game',  'Tools',  'tools',  10),
      ('proj-docs',   'org-game',  'Docs',   'docs',   0),
      ('proj-other',  'org-other', 'Else',   'else',   10);
  `)
})

type GrepReply = {
  error?: string
  data: {
    searched: string[]
    notCloned: string[]
    filesOnly: boolean
    results: Array<{ repo: string; total: number; truncated: boolean; hits: Array<{ file: string; line: number }>; files: Array<{ file: string; count: number }> }>
  }
}

async function grep(body: Record<string, unknown>) {
  const res = await app.request('/api/intel/grep', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as GrepReply }
}

describe('POST /api/intel/grep', () => {
  it('searches every checkout of the organization and nothing outside it', async () => {
    const { status, json } = await grep({ pattern: '144', orgId: 'org-game' })
    expect(status).toBe(200)
    expect(json.data.searched).toEqual(['Server', 'Tools'])
    expect(json.data.notCloned).toEqual(['Docs'])
    const repos = json.data.results.map((r: { repo: string; total: number }) => `${r.repo}:${r.total}`)
    // The repo where the string is rare comes first.
    expect(repos).toEqual(['Tools:1', 'Server:2'])
    expect(JSON.stringify(json)).not.toContain('another organization')
  })

  it('narrows to one repo, and refuses a repo of another organization', async () => {
    const one = await grep({ pattern: 'case 14[0-9]', projectId: 'server', orgId: 'org-game' })
    expect(one.json.data.results).toHaveLength(1)
    expect(one.json.data.results[0]!.hits.map((h: { file: string; line: number }) => `${h.file}:${h.line}`))
      .toEqual(['src/Map.cs:1', 'src/Player.cs:1', 'src/Player.cs:2'])
    expect((await grep({ pattern: '144', projectId: 'proj-other', orgId: 'org-game' })).status).toBe(403)
  })

  it('lists no more lines than the limit across repos', async () => {
    const { json } = await grep({ pattern: '144', orgId: 'org-game', limit: 2 })
    const shown = json.data.results.reduce((n: number, r: { hits: unknown[] }) => n + r.hits.length, 0)
    expect(shown).toBe(2)
    expect(json.data.results.find((r) => r.repo === 'Server')!.truncated).toBe(true)
  })

  it('names files with a count each, rare repos first, within the limit', async () => {
    const { json } = await grep({ pattern: '144', orgId: 'org-game', files: true })
    expect(json.data.filesOnly).toBe(true)
    expect(json.data.results.map((r) => `${r.repo}:${r.total}`)).toEqual(['Tools:1', 'Server:2'])
    expect(json.data.results[1]!.files).toEqual([{ file: 'src/Map.cs', count: 1 }, { file: 'src/Player.cs', count: 1 }])
    expect(json.data.results.every((r) => r.hits.length === 0)).toBe(true)

    const capped = await grep({ pattern: '144', orgId: 'org-game', files: true, limit: 2 })
    expect(capped.json.data.results.find((r) => r.repo === 'Server')!).toMatchObject({ total: 2, truncated: true })
  })

  it('answers a broken pattern once, as a bad request', async () => {
    const { status, json } = await grep({ pattern: 'case (14', orgId: 'org-game' })
    expect(status).toBe(400)
    expect(json.error).toContain('git grep refused the pattern')
  })
})
