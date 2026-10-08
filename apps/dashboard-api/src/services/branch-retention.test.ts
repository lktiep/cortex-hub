import { describe, it, expect, vi, beforeEach, afterAll, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/branch-retention-test-${process.pid}`
  process.env.REPOS_DIR = `${dir}/repos`
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
  })
  return dir
})

// ── Qdrant, as points that carry only what the sweep filters on ──

interface Point { project_id: string; branch: string }

const qdrant = vi.hoisted(() => ({
  points: [] as Point[],
  /** Status every count answers with instead of a number, when set. */
  countStatus: 0,
  /** Held open by a test to see what waits behind a delete. */
  deleteHold: Promise.resolve() as Promise<void>,
  /** Called as a delete starts, before the hold. */
  onDelete: () => {},
  events: [] as string[],
}))

type Filter = { must: Array<{ key: keyof Point; match: { value: string } }> }
const matches = (filter: Filter) => (point: Point) => filter.must.every((c) => point[c.key] === c.match.value)

vi.mock('@cortex/shared-mem9', () => ({
  VectorStore: class {
    async count(filter: Filter) {
      if (qdrant.countStatus) throw new Error(`Qdrant count failed (${qdrant.countStatus}): no`)
      return qdrant.points.filter(matches(filter)).length
    }
    async deleteByFilter(filter: Filter) {
      qdrant.onDelete()
      await qdrant.deleteHold
      const keep = qdrant.points.filter((p) => !matches(filter)(p))
      qdrant.events.push(`delete ${qdrant.points.length - keep.length}`)
      qdrant.points = keep
    }
  },
}))

vi.mock('./mem9-embedder.js', () => ({
  embedProject: vi.fn(async (_projectId: string, branch: string) => {
    qdrant.events.push(`embed ${branch}`)
    return { status: 'done', chunks: 1, embedded: 1, reused: 0, unchanged: 0, removed: 0, errors: [] }
  }),
}))

vi.mock('./docs-knowledge-builder.js', () => ({
  buildKnowledgeFromDocs: vi.fn(async () => ({ docsFound: 0, docsProcessed: 0, chunksCreated: 0 })),
}))

let testDb: InstanceType<typeof Database>

vi.mock('../db/client.js', () => ({
  get db() {
    return testDb
  },
}))

import { branchesToPrune, retentionDays, sweepProjectBranches, sweepProjectBranchesWhenIdle } from './branch-retention.js'
import { indexQueueIdle, requestIndexing } from './indexer.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT = 'proj-retention'
const NOW = Date.parse('2026-10-09T00:00:00Z')
const RECENT = '2026-10-08T00:00:00Z'
const OLD = '2026-09-01T00:00:00Z'
const remote = join(root, 'remote.git')
const work = join(root, 'work')
const defaultCheckout = join(root, 'repos', PROJECT)
const branchCheckout = join(root, 'repos', '.branches', PROJECT)

function createTestDb() {
  const db = new Database(':memory:')
  db.exec(readFileSync(join(__dirname, '../db/schema.sql'), 'utf-8'))
  // Added by the runtime migration in db/client.ts, not by schema.sql.
  for (const column of [
    'triggered_by TEXT', 'commit_hash TEXT', 'commit_message TEXT', 'mem9_status TEXT',
    'mem9_chunks INTEGER DEFAULT 0', 'mem9_progress INTEGER DEFAULT 0', 'mem9_total_chunks INTEGER DEFAULT 0',
    'docs_knowledge_status TEXT', 'docs_knowledge_count INTEGER DEFAULT 0',
  ]) {
    db.exec(`ALTER TABLE index_jobs ADD COLUMN ${column}`)
  }
  return db
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** Put `branch` on the remote. */
function push(branch: string) {
  git(work, 'switch', '-C', branch)
  writeFileSync(join(work, 'index.ts'), `export const branch = '${branch}'\n`)
  git(work, 'add', '.')
  git(work, 'commit', '-m', branch)
  git(work, 'push', '-f', 'origin', branch)
}

/** An index job for `branch` created at `at`, and `points` points for it. */
function indexed(branch: string, at: string, points = 2) {
  testDb.prepare(
    `INSERT INTO index_jobs (id, project_id, branch, status, mem9_status, created_at) VALUES (?, ?, ?, 'done', 'done', ?)`
  ).run(`job-${branch}-${at}`, PROJECT, branch, at)
  for (let i = 0; i < points; i++) qdrant.points.push({ project_id: PROJECT, branch })
}

const branchesWithJobs = () =>
  (testDb.prepare('SELECT DISTINCT branch FROM index_jobs WHERE project_id = ? ORDER BY branch').all(PROJECT) as Array<{ branch: string }>)
    .map((row) => row.branch)
const branchesWithPoints = () => [...new Set(qdrant.points.map((p) => p.branch))].sort()

beforeEach(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  git(root, 'init', '--bare', '-b', 'main', remote)
  git(work, 'init', '-b', 'main')
  git(work, 'remote', 'add', 'origin', `file://${remote}`)
  for (const branch of ['main', 'feat-live', 'feat-old']) push(branch)

  testDb = createTestDb()
  testDb.exec(`
    INSERT INTO organizations (id, name, slug) VALUES ('org-1', 'Org', 'org');
    INSERT INTO projects (id, org_id, name, slug, git_repo_url, default_branch)
      VALUES ('${PROJECT}', 'org-1', 'Retention', 'retention', 'file://${remote}', 'main');
  `)

  qdrant.points = []
  qdrant.countStatus = 0
  qdrant.deleteHold = Promise.resolve()
  qdrant.onDelete = () => {}
  qdrant.events = []
})

afterEach(() => {
  delete process.env.BRANCH_RETENTION_DAYS
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('branchesToPrune', () => {
  const base = {
    protectedBranches: new Set(['main']),
    remoteHeads: new Set(['main', 'live']) as ReadonlySet<string> | null,
    now: NOW,
    retentionDays: 14,
  }

  it('drops a branch gone from the remote, and one idle past the retention', () => {
    expect(branchesToPrune({
      ...base,
      indexed: [
        { branch: 'live', lastIndexedAt: RECENT },
        { branch: 'gone', lastIndexedAt: RECENT },
        { branch: 'live', lastIndexedAt: OLD },
      ],
    })).toEqual([
      { branch: 'gone', reason: 'deleted' },
      { branch: 'live', reason: 'stale' },
    ])
  })

  it('keeps a branch one day short of the retention', () => {
    const lastIndexedAt = new Date(NOW - 13 * 24 * 60 * 60 * 1000).toISOString()
    expect(branchesToPrune({ ...base, indexed: [{ branch: 'live', lastIndexedAt }] })).toEqual([])
  })

  it('never drops a protected branch, gone and idle or not', () => {
    expect(branchesToPrune({
      ...base,
      remoteHeads: new Set(['live']),
      indexed: [{ branch: 'main', lastIndexedAt: OLD }],
    })).toEqual([])
  })

  it('goes by age alone when the remote could not be listed', () => {
    expect(branchesToPrune({
      ...base,
      remoteHeads: null,
      indexed: [{ branch: 'gone', lastIndexedAt: RECENT }, { branch: 'old', lastIndexedAt: OLD }],
    })).toEqual([{ branch: 'old', reason: 'stale' }])
  })

  it('drops nothing with a retention of 0', () => {
    expect(branchesToPrune({ ...base, retentionDays: 0, indexed: [{ branch: 'gone', lastIndexedAt: OLD }] })).toEqual([])
  })
})

describe('retentionDays', () => {
  it('is 14 unless set, and 0 for anything that is not a positive number', () => {
    expect(retentionDays()).toBe(14)
    for (const [value, days] of [['7', 7], ['0', 0], ['-3', 0], ['two', 0], [' ', 14]] as const) {
      process.env.BRANCH_RETENTION_DAYS = value
      expect(retentionDays()).toBe(days)
    }
  })
})

describe('sweepProjectBranches', () => {
  beforeEach(() => {
    indexed('main', OLD)
    indexed('feat-live', RECENT)
    indexed('feat-old', OLD)
    indexed('feat-gone', RECENT, 3)
  })

  it("drops the vectors and jobs of branches gone from the remote or idle, and nothing else", async () => {
    const result = await sweepProjectBranches(PROJECT, { now: NOW })
    expect(result).toEqual({
      projectId: PROJECT,
      pruned: [
        { branch: 'feat-gone', reason: 'deleted', points: 3 },
        { branch: 'feat-old', reason: 'stale', points: 2 },
      ],
      failed: [],
      checkoutRemoved: false,
    })
    expect(branchesWithJobs()).toEqual(['feat-live', 'main'])
    expect(branchesWithPoints()).toEqual(['feat-live', 'main'])
  })

  it('changes nothing on a dry run', async () => {
    const result = await sweepProjectBranches(PROJECT, { now: NOW, dryRun: true })
    expect(result.pruned.map((p) => p.branch)).toEqual(['feat-gone', 'feat-old'])
    expect(branchesWithJobs()).toEqual(['feat-gone', 'feat-live', 'feat-old', 'main'])
    expect(qdrant.points).toHaveLength(9)
  })

  it("keeps the branch the project's own checkout is on", async () => {
    mkdirSync(join(defaultCheckout, '.git'), { recursive: true })
    writeFileSync(join(defaultCheckout, '.git', 'HEAD'), 'ref: refs/heads/feat-gone\n')
    const result = await sweepProjectBranches(PROJECT, { now: NOW })
    expect(result.pruned.map((p) => p.branch)).toEqual(['feat-old'])
  })

  it('trusts no listing that lacks the default branch, and goes by age alone', async () => {
    testDb.prepare('UPDATE projects SET default_branch = ? WHERE id = ?').run('trunk', PROJECT)
    const result = await sweepProjectBranches(PROJECT, { now: NOW })
    // 'main' is a feature branch now, and old; 'feat-gone' is recent.
    expect(result.pruned.map((p) => [p.branch, p.reason])).toEqual([['feat-old', 'stale'], ['main', 'stale']])
  })

  it('leaves a project whose default branch was never resolved alone', async () => {
    testDb.prepare('UPDATE projects SET default_branch = NULL WHERE id = ?').run(PROJECT)
    const result = await sweepProjectBranches(PROJECT, { now: NOW })
    expect(result).toMatchObject({ pruned: [], skipped: 'default branch not resolved yet' })
    expect(branchesWithJobs()).toHaveLength(4)
  })

  it('keeps the jobs of a branch whose points could not be counted', async () => {
    qdrant.countStatus = 500
    const result = await sweepProjectBranches(PROJECT, { now: NOW })
    expect(result.pruned).toEqual([])
    expect(result.failed.map((f) => f.branch)).toEqual(['feat-gone', 'feat-old'])
    expect(branchesWithJobs()).toHaveLength(4)
  })

  it('drops the jobs of a project that was never embedded', async () => {
    qdrant.countStatus = 404
    const result = await sweepProjectBranches(PROJECT, { now: NOW })
    expect(result.pruned.map((p) => [p.branch, p.points])).toEqual([['feat-gone', 0], ['feat-old', 0]])
    expect(branchesWithJobs()).toEqual(['feat-live', 'main'])
  })

  it('removes the shared checkout once no feature branch is left', async () => {
    mkdirSync(branchCheckout, { recursive: true })
    expect((await sweepProjectBranches(PROJECT, { now: NOW })).checkoutRemoved).toBe(false)
    expect(existsSync(branchCheckout)).toBe(true)

    const later = NOW + 30 * 24 * 60 * 60 * 1000
    const result = await sweepProjectBranches(PROJECT, { now: later })
    expect(result.pruned.map((p) => p.branch)).toEqual(['feat-live'])
    expect(result.checkoutRemoved).toBe(true)
    expect(existsSync(branchCheckout)).toBe(false)
    expect(branchesWithJobs()).toEqual(['main'])
  })

  it('is off with a retention of 0', async () => {
    const result = await sweepProjectBranches(PROJECT, { now: NOW, retentionDays: 0 })
    expect(result).toMatchObject({ pruned: [], skipped: 'BRANCH_RETENTION_DAYS is 0' })
  })
})

describe('sweepProjectBranchesWhenIdle', () => {
  it('waits for nothing and runs nothing while the project is indexing', async () => {
    indexed('feat-gone', OLD)
    requestIndexing(PROJECT, 'main', { triggeredBy: 'push' })
    expect(await sweepProjectBranchesWhenIdle(PROJECT, { now: NOW })).toBeNull()
    await indexQueueIdle(PROJECT)
    expect(branchesWithJobs()).toContain('feat-gone')
  })

  it('holds an index request that arrives mid-sweep until the sweep is done, and keeps it', async () => {
    indexed('feat-old', OLD)
    let release!: () => void
    qdrant.deleteHold = new Promise<void>((resolve) => (release = resolve))
    const deleting = new Promise<void>((resolve) => (qdrant.onDelete = resolve))

    const sweep = sweepProjectBranchesWhenIdle(PROJECT, { now: NOW })
    // Past the point where the sweep chose its branches, and for the very
    // branch being dropped: the new job must survive the drop.
    await deleting
    const request = requestIndexing(PROJECT, 'feat-old', { triggeredBy: 'push' })
    expect(request.queued).toBe(true)
    expect(testDb.prepare('SELECT log FROM index_jobs WHERE id = ?').get(request.jobId)).toEqual({
      log: expect.stringContaining('Queued behind branch-sweep'),
    })

    release()
    expect((await sweep)?.pruned.map((p) => p.branch)).toEqual(['feat-old'])
    await indexQueueIdle(PROJECT)
    expect(qdrant.events).toEqual(['delete 2', 'embed feat-old'])
    expect(testDb.prepare('SELECT status FROM index_jobs WHERE id = ?').get(request.jobId)).toEqual({ status: 'done' })
  })
})
