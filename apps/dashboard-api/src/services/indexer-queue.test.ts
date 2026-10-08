import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/indexer-queue-test-${process.pid}`
  process.env.REPOS_DIR = `${dir}/repos`
  // Every git here, the indexer's included, runs without the machine's own
  // config: no signing, no hooks, no rewritten URLs.
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
  })
  return dir
})

// ── Embedding that the test holds open, to see what runs alongside it ──

const embedding = vi.hoisted(() => ({
  branches: [] as string[],
  dirs: [] as string[],
  active: 0,
  maxActive: 0,
  hold: Promise.resolve() as Promise<void>,
}))

vi.mock('./mem9-embedder.js', () => ({
  embedProject: vi.fn(async (_projectId: string, branch: string, _jobId: string, _onProgress: unknown, repoDir: string) => {
    embedding.branches.push(branch)
    embedding.dirs.push(repoDir)
    embedding.active++
    embedding.maxActive = Math.max(embedding.maxActive, embedding.active)
    try {
      await embedding.hold
    } finally {
      embedding.active--
    }
    return { status: 'done', chunks: 3, embedded: 3, reused: 0, unchanged: 0, removed: 0, errors: [] }
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

import { requestIndexing, indexQueueIdle, cancelJob, recoverInterruptedJobs } from './indexer.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT = 'proj-queue'
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

/** Commit a change to `branch` and push it, returning the new head. */
function push(branch: string, content: string): string {
  git(work, 'switch', '-C', branch)
  writeFileSync(join(work, 'index.ts'), `export const value = '${content}'\n`)
  git(work, 'add', '.')
  git(work, 'commit', '-m', content)
  git(work, 'push', '-f', 'origin', branch)
  return git(work, 'rev-parse', 'HEAD')
}

/** Holds every embedding open until the returned function is called. */
function holdEmbedding(): () => void {
  let release!: () => void
  embedding.hold = new Promise<void>((resolve) => (release = resolve))
  return release
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 25))
  expect(check()).toBe(true)
}

type JobRow = Record<string, unknown> & { status: string; log: string | null }
const job = (id: string) => testDb.prepare('SELECT * FROM index_jobs WHERE id = ?').get(id) as JobRow
const jobsFor = (branch: string) =>
  testDb.prepare('SELECT * FROM index_jobs WHERE branch = ? ORDER BY rowid').all(branch) as JobRow[]

beforeEach(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  git(root, 'init', '--bare', '-b', 'main', remote)
  git(work, 'init', '-b', 'main')
  git(work, 'remote', 'add', 'origin', `file://${remote}`)

  testDb = createTestDb()
  testDb.exec(`
    INSERT INTO organizations (id, name, slug) VALUES ('org-1', 'Org', 'org');
    INSERT INTO projects (id, org_id, name, slug, git_repo_url, default_branch)
      VALUES ('${PROJECT}', 'org-1', 'Queue', 'queue', 'file://${remote}', 'main');
  `)

  embedding.branches = []
  embedding.dirs = []
  embedding.active = 0
  embedding.maxActive = 0
  embedding.hold = Promise.resolve()
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('index queue', () => {
  it('runs one job per project at a time, embedding included', async () => {
    push('main', 'one')
    push('feat', 'two')
    const release = holdEmbedding()

    const main = requestIndexing(PROJECT, 'main', { triggeredBy: 'push' })
    const feat = requestIndexing(PROJECT, 'feat', { triggeredBy: 'push' })
    expect(main).toMatchObject({ queued: false, coalesced: false })
    expect(feat).toMatchObject({ queued: true, coalesced: false })

    await until(() => embedding.branches.length === 1)
    expect(job(feat.jobId).status).toBe('pending')
    expect(job(feat.jobId).log).toContain(`Queued behind ${main.jobId} (main)`)

    release()
    await indexQueueIdle(PROJECT)
    expect(embedding.branches).toEqual(['main', 'feat'])
    expect(embedding.maxActive).toBe(1)
    expect([job(main.jobId), job(feat.jobId)].map((row) => [row.status, row.mem9_status])).toEqual([
      ['done', 'done'],
      ['done', 'done'],
    ])
  })

  it('folds further requests for a waiting branch into its job', async () => {
    push('main', 'one')
    push('feat', 'two')
    const release = holdEmbedding()

    requestIndexing(PROJECT, 'main', { triggeredBy: 'push' })
    await until(() => embedding.branches.length === 1)
    const first = requestIndexing(PROJECT, 'feat', { triggeredBy: 'push' })
    const second = requestIndexing(PROJECT, 'feat', { triggeredBy: 'push' })
    const third = requestIndexing(PROJECT, 'feat', { triggeredBy: 'manual', force: true })
    expect(second).toEqual({ jobId: first.jobId, branch: 'feat', queued: true, coalesced: true })
    expect(third.jobId).toBe(first.jobId)
    expect(jobsFor('feat')).toHaveLength(1)
    expect(job(first.jobId).log).toContain('A manual request for feat joined this job')

    release()
    await indexQueueIdle(PROJECT)
    expect(embedding.branches).toEqual(['main', 'feat'])
  })

  it('skips a branch that is already indexed at the commit the remote is on', async () => {
    const head = push('main', 'one')
    requestIndexing(PROJECT, 'main', { triggeredBy: 'push' })
    await indexQueueIdle(PROJECT)

    const again = requestIndexing(PROJECT, 'main', { triggeredBy: 'push' })
    await indexQueueIdle(PROJECT)
    expect(embedding.branches).toEqual(['main'])
    const row = job(again.jobId)
    expect(row).toMatchObject({ status: 'done', mem9_status: 'done', mem9_progress: 100, mem9_chunks: 3 })
    expect(head.startsWith(String(row.commit_hash))).toBe(true)
    expect(row.log).toContain('is already indexed at')
  })

  it('indexes again once the branch has a new commit', async () => {
    push('main', 'one')
    requestIndexing(PROJECT, 'main', { triggeredBy: 'push' })
    await indexQueueIdle(PROJECT)

    const head = push('main', 'two')
    const again = requestIndexing(PROJECT, 'main', { triggeredBy: 'push' })
    await indexQueueIdle(PROJECT)
    expect(embedding.branches).toEqual(['main', 'main'])
    expect(head.startsWith(String(job(again.jobId).commit_hash))).toBe(true)
  })

  it('indexes the same commit again when forced', async () => {
    push('main', 'one')
    requestIndexing(PROJECT, 'main', { triggeredBy: 'push' })
    await indexQueueIdle(PROJECT)

    requestIndexing(PROJECT, 'main', { triggeredBy: 'manual', force: true })
    await indexQueueIdle(PROJECT)
    expect(embedding.branches).toEqual(['main', 'main'])
  })

  it('checks a feature branch out beside the default one, leaving it alone', async () => {
    const mainHead = push('main', 'one')
    const featHead = push('feat', 'two')
    for (const branch of ['main', 'feat', 'main']) {
      requestIndexing(PROJECT, branch, { triggeredBy: 'push' })
      await indexQueueIdle(PROJECT)
    }
    // main still has its own checkout at its commit, so the third request is a skip.
    expect(embedding.branches).toEqual(['main', 'feat'])
    expect(embedding.dirs).toEqual([defaultCheckout, branchCheckout])
    expect(git(defaultCheckout, 'rev-parse', 'HEAD')).toBe(mainHead)
    expect(git(branchCheckout, 'rev-parse', 'HEAD')).toBe(featHead)
  })

  it('checks a feature branch out again after another one took the shared checkout', async () => {
    push('feat-a', 'one')
    push('feat-b', 'two')
    for (const branch of ['feat-a', 'feat-b', 'feat-a']) {
      requestIndexing(PROJECT, branch, { triggeredBy: 'push' })
      await indexQueueIdle(PROJECT)
    }
    expect(embedding.branches).toEqual(['feat-a', 'feat-b', 'feat-a'])
    expect(git(branchCheckout, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat-a')
  })

  it('updates the default checkout in place, keeping the GitNexus graph', async () => {
    push('main', 'one')
    requestIndexing(PROJECT, 'main', { triggeredBy: 'push' })
    await indexQueueIdle(PROJECT)
    mkdirSync(join(defaultCheckout, '.gitnexus'))
    writeFileSync(join(defaultCheckout, '.gitnexus', 'meta.json'), '{}')
    writeFileSync(join(defaultCheckout, 'leftover.log'), 'build output')

    const head = push('main', 'two')
    const again = requestIndexing(PROJECT, 'main', { triggeredBy: 'push' })
    await indexQueueIdle(PROJECT)
    expect(job(again.jobId).status).toBe('done')
    expect(git(defaultCheckout, 'rev-parse', 'HEAD')).toBe(head)
    expect(readFileSync(join(defaultCheckout, 'index.ts'), 'utf-8')).toContain('two')
    expect(existsSync(join(defaultCheckout, '.gitnexus', 'meta.json'))).toBe(true)
    expect(existsSync(join(defaultCheckout, 'leftover.log'))).toBe(false)
    expect(existsSync(join(root, 'repos', `${PROJECT}.cloning`))).toBe(false)
  })

  it('clones afresh when the checkout cannot be updated', async () => {
    const head = push('main', 'one')
    mkdirSync(join(defaultCheckout, '.git'), { recursive: true })
    const run = requestIndexing(PROJECT, 'main', { triggeredBy: 'push' })
    await indexQueueIdle(PROJECT)
    expect(job(run.jobId).status).toBe('done')
    expect(job(run.jobId).log).toContain('cloning it again')
    expect(git(defaultCheckout, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('does not skip a commit whose embedding failed', async () => {
    push('main', 'one')
    const first = requestIndexing(PROJECT, 'main', { triggeredBy: 'push' })
    await indexQueueIdle(PROJECT)
    testDb.prepare(`UPDATE index_jobs SET mem9_status = 'error' WHERE id = ?`).run(first.jobId)

    requestIndexing(PROJECT, 'main', { triggeredBy: 'push' })
    await indexQueueIdle(PROJECT)
    expect(embedding.branches).toEqual(['main', 'main'])
  })

  it('cancels a job that has not started', async () => {
    push('main', 'one')
    push('feat', 'two')
    const release = holdEmbedding()

    requestIndexing(PROJECT, 'main', { triggeredBy: 'push' })
    await until(() => embedding.branches.length === 1)
    const feat = requestIndexing(PROJECT, 'feat', { triggeredBy: 'push' })
    expect(cancelJob(feat.jobId)).toBe(true)
    expect(job(feat.jobId)).toMatchObject({ status: 'error', error: 'Cancelled by user' })

    release()
    await indexQueueIdle(PROJECT)
    expect(embedding.branches).toEqual(['main'])
    expect(job(feat.jobId).status).toBe('error')
  })
})

describe('recoverInterruptedJobs', () => {
  it('closes the work a previous process left open and nothing else', () => {
    testDb.exec(`
      INSERT INTO index_jobs (id, project_id, status, mem9_status, docs_knowledge_status) VALUES
        ('waiting',   '${PROJECT}', 'pending',   NULL,        NULL),
        ('cloning',   '${PROJECT}', 'cloning',   NULL,        NULL),
        ('embedding', '${PROJECT}', 'done',      'embedding', NULL),
        ('docs',      '${PROJECT}', 'done',      'done',      'building'),
        ('finished',  '${PROJECT}', 'done',      'done',      'done');
    `)
    expect(recoverInterruptedJobs()).toEqual({ jobs: 2, embeddings: 1, docs: 1 })
    expect(job('waiting')).toMatchObject({ status: 'error', error: 'Interrupted by restart' })
    expect(job('cloning').status).toBe('error')
    expect(job('embedding')).toMatchObject({ status: 'done', mem9_status: 'error' })
    expect(job('docs')).toMatchObject({ status: 'done', docs_knowledge_status: 'error' })
    expect(job('finished')).toMatchObject({ status: 'done', mem9_status: 'done', docs_knowledge_status: 'done', error: null })
  })
})
