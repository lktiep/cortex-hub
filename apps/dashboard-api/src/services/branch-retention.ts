import { execFile } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { VectorStore } from '@cortex/shared-mem9'
import { createLogger } from '@cortex/shared-utils'
import { db } from '../db/client.js'
import { buildAuthUrl, runWhenQueueIdle } from './indexer.js'

// ── Branch retention ──
//
// Every indexed branch keeps a full copy of its project's vectors: Qdrant point
// ids include the branch, so thirty feature branches of one repository came to
// ~350K points and pinned Qdrant at its memory limit. Nothing ever removed a
// branch, merged and deleted or not. The sweep below drops the vectors and the
// job history of a branch that is gone from the remote, whose work is already in
// the default branch, or that nothing has asked to index for
// BRANCH_RETENTION_DAYS. Indexing it again brings it back.

const logger = createLogger('branch-retention')
const execFileAsync = promisify(execFile)

const REPOS_DIR = process.env.REPOS_DIR ?? '/app/data/repos'
const BRANCH_CHECKOUTS_DIR = join(REPOS_DIR, '.branches')
const QDRANT_URL = process.env.QDRANT_URL ?? 'http://qdrant:6333'

const DAY_MS = 24 * 60 * 60 * 1000
const FIRST_SWEEP_DELAY_MS = 5 * 60 * 1000
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000

const redactCredentials = (text: string) => text.replace(/\/\/[^@]+@/g, '//<redacted>@')

/** Days a branch is kept after it was last indexed; 0 turns the sweep off. */
export function retentionDays(): number {
  const raw = process.env.BRANCH_RETENTION_DAYS?.trim()
  if (!raw) return 14
  const days = Number(raw)
  return Number.isFinite(days) && days > 0 ? days : 0
}

export interface IndexedBranch {
  branch: string
  /** created_at of the branch's newest job: when it was last pushed or asked for. */
  lastIndexedAt: string
}

export type PruneReason = 'deleted' | 'merged' | 'stale'

/**
 * Which indexed branches to drop.
 *
 * `remoteHeads` null means the remote could not be listed, or listed something
 * that cannot be this repository — then only age counts, never absence.
 * `merged` holds the branches whose work is already in the default branch.
 */
export function branchesToPrune(input: {
  indexed: IndexedBranch[]
  protectedBranches: ReadonlySet<string>
  remoteHeads: ReadonlySet<string> | null
  merged: ReadonlySet<string>
  now: number
  retentionDays: number
}): Array<{ branch: string; reason: PruneReason }> {
  const pruned: Array<{ branch: string; reason: PruneReason }> = []
  if (input.retentionDays <= 0) return pruned

  for (const { branch, lastIndexedAt } of input.indexed) {
    if (input.protectedBranches.has(branch)) continue
    if (input.remoteHeads && !input.remoteHeads.has(branch)) {
      pruned.push({ branch, reason: 'deleted' })
      continue
    }
    if (input.merged.has(branch)) {
      pruned.push({ branch, reason: 'merged' })
      continue
    }
    const last = Date.parse(lastIndexedAt)
    if (Number.isFinite(last) && input.now - last > input.retentionDays * DAY_MS) {
      pruned.push({ branch, reason: 'stale' })
    }
  }
  return pruned
}

/** Branch names on the remote, or null when it cannot be listed. */
async function listRemoteHeads(authUrl: string): Promise<Set<string> | null> {
  try {
    const { stdout } = await execFileAsync('git', ['ls-remote', '--heads', authUrl], {
      timeout: 15000,
      encoding: 'utf-8',
    })
    const heads = new Set<string>()
    for (const line of stdout.split('\n')) {
      const ref = line.split('\t')[1]
      if (ref?.startsWith('refs/heads/')) heads.add(ref.slice('refs/heads/'.length))
    }
    return heads
  } catch (err) {
    logger.warn(`ls-remote failed: ${redactCredentials(String(err)).slice(0, 200)}`)
    return null
  }
}

/** Blob of each of `files` in `rev`; a file the commit does not have is absent. */
async function blobsAt(git: (...args: string[]) => Promise<string>, rev: string, files: ReadonlySet<string>) {
  const blobs = new Map<string, string>()
  for (const line of (await git('ls-tree', '-r', rev)).split('\n')) {
    const [meta, path] = line.split('\t')
    if (meta && path !== undefined && files.has(path)) blobs.set(path, meta.split(' ')[2] ?? '')
  }
  return blobs
}

const sameBlobs = (a: Map<string, string>, b: Map<string, string>, files: ReadonlySet<string>) =>
  [...files].every((file) => a.get(file) === b.get(file))

/**
 * Which of `branches` have nothing the default branch lacks.
 *
 * Merged with a merge commit or fast-forwarded, a branch's head is in the
 * default branch's history. Squashed or rebased, it is not, but at some commit
 * of the default branch every file the branch changed reads as it does at the
 * branch's head. A branch still at the default branch's tip has not started
 * yet and is kept. The project's own checkouts are shallow, so the history
 * comes from a fetch of its own: commits and trees, no file contents.
 */
async function mergedBranches(authUrl: string, defaultBranch: string, branches: string[]): Promise<Set<string>> {
  const merged = new Set<string>()
  if (branches.length === 0) return merged
  let dir: string | undefined
  try {
    const cwd = (dir = await mkdtemp(join(tmpdir(), 'cortex-sweep-')))
    const git = async (...args: string[]) =>
      (await execFileAsync('git', ['-C', cwd, ...args], { timeout: 120000, encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 })).stdout
    await git('init', '--quiet', '--bare')
    const refspecs = [defaultBranch, ...branches].map((b) => `+refs/heads/${b}:refs/heads/${b}`)
    await git('fetch', '--quiet', '--no-tags', '--filter=blob:none', authUrl, ...refspecs)
    const tip = (await git('rev-parse', `refs/heads/${defaultBranch}`)).trim()

    for (const branch of branches) {
      const head = (await git('rev-parse', `refs/heads/${branch}`)).trim()
      if (head === tip) continue
      const base = (await git('merge-base', tip, head)).trim()
      if (base === head) {
        merged.add(branch)
        continue
      }
      const files = new Set((await git('diff', '--no-renames', '--name-only', base, head)).split('\n').filter(Boolean))
      const want = await blobsAt(git, head, files)
      const current = await blobsAt(git, base, files)
      // Replay the default branch's changes to those files, one commit at a time.
      const log = await git('log', '--first-parent', '--reverse', '--diff-merges=first-parent', '--raw', '--no-abbrev', '--no-renames', '--format=', `${base}..${tip}`)
      for (const line of log.split('\n')) {
        const [, blob, status, file] = /^:\S+ \S+ \S+ (\S+) (\S)\t(.+)$/.exec(line) ?? []
        if (!blob || !file || !files.has(file)) continue
        if (status === 'D') current.delete(file)
        else current.set(file, blob)
        if (sameBlobs(current, want, files)) {
          merged.add(branch)
          break
        }
      }
    }
  } catch (err) {
    logger.warn(`merge check failed: ${redactCredentials(String(err)).slice(0, 200)}`)
    merged.clear()
  } finally {
    // It holds the authenticated URL in FETCH_HEAD.
    if (dir) await rm(dir, { recursive: true, force: true })
  }
  return merged
}

/** The branch the project's own checkout is on, from .git/HEAD. */
function checkedOutBranch(repoDir: string): string | null {
  try {
    const head = readFileSync(join(repoDir, '.git', 'HEAD'), 'utf-8').trim()
    return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : null
  } catch {
    return null
  }
}

/** Points matching `filter`; 0 when the project was never embedded. */
async function countPoints(store: VectorStore, filter: Record<string, unknown>): Promise<number> {
  try {
    return await store.count(filter)
  } catch (err) {
    // Only a missing collection means "no points". Any other failure has to
    // stop the branch's rows from going, or its points would outlive them.
    if (String(err).includes('(404)')) return 0
    throw err
  }
}

export interface PrunedBranch {
  branch: string
  reason: PruneReason
  /** Points deleted, or that a dry run would delete. */
  points: number
}

export interface SweepResult {
  projectId: string
  pruned: PrunedBranch[]
  /** Branches that matched but could not be removed; they are tried again next sweep. */
  failed: Array<{ branch: string; error: string }>
  checkoutRemoved: boolean
  /** Set when the project was not swept at all. */
  skipped?: string
}

/**
 * Drop the project's branches that are gone from the remote, merged into the
 * default branch, or idle too long.
 *
 * The default branch is never touched, nor the branch the project's own
 * checkout is on. A project whose default branch was never resolved is left
 * alone: guessing it would make the real one look like a feature branch.
 */
export async function sweepProjectBranches(
  projectId: string,
  opts: { dryRun?: boolean; now?: number; retentionDays?: number } = {},
): Promise<SweepResult> {
  const result: SweepResult = { projectId, pruned: [], failed: [], checkoutRemoved: false }
  const days = opts.retentionDays ?? retentionDays()
  if (days <= 0) return { ...result, skipped: 'BRANCH_RETENTION_DAYS is 0' }

  const project = db.prepare(
    'SELECT git_repo_url, git_username, git_token, default_branch FROM projects WHERE id = ?'
  ).get(projectId) as {
    git_repo_url: string | null
    git_username: string | null
    git_token: string | null
    default_branch: string | null
  } | undefined
  if (!project) return { ...result, skipped: 'no such project' }
  if (!project.default_branch) return { ...result, skipped: 'default branch not resolved yet' }
  const defaultBranch = project.default_branch

  const indexed = db.prepare(
    'SELECT branch, MAX(created_at) AS lastIndexedAt FROM index_jobs WHERE project_id = ? AND branch IS NOT NULL GROUP BY branch ORDER BY branch'
  ).all(projectId) as IndexedBranch[]

  const protectedBranches = new Set([defaultBranch])
  const checkedOut = checkedOutBranch(join(REPOS_DIR, projectId))
  if (checkedOut) protectedBranches.add(checkedOut)

  // Only ask the remote when there is something it could rule on.
  let remoteHeads: Set<string> | null = null
  let merged = new Set<string>()
  if (project.git_repo_url && indexed.some(({ branch }) => !protectedBranches.has(branch))) {
    const authUrl = buildAuthUrl(project.git_repo_url, project.git_username, project.git_token)
    const heads = await listRemoteHeads(authUrl)
    // A listing without the default branch is an empty repository, a moved URL
    // or an answer from something else; absence from it proves nothing.
    if (heads?.has(defaultBranch)) {
      remoteHeads = heads
      const onRemote = indexed.map(({ branch }) => branch).filter((b) => !protectedBranches.has(b) && heads.has(b))
      merged = await mergedBranches(authUrl, defaultBranch, onRemote)
    }
  }

  const candidates = branchesToPrune({
    indexed,
    protectedBranches,
    remoteHeads,
    merged,
    now: opts.now ?? Date.now(),
    retentionDays: days,
  })
  if (candidates.length === 0) return result

  const store = new VectorStore({ url: QDRANT_URL, collection: `cortex-project-${projectId}` })

  for (const { branch, reason } of candidates) {
    const filter = {
      must: [
        { key: 'project_id', match: { value: projectId } },
        { key: 'branch', match: { value: branch } },
      ],
    }
    try {
      const points = await countPoints(store, filter)
      if (!opts.dryRun) {
        if (points > 0) await store.deleteByFilter(filter)
        // After the points: if their delete fails the rows stay, and the next
        // sweep finds the branch again. Without its rows a later push indexes
        // the branch afresh instead of finding it "already indexed". A pending
        // row is a request that arrived during the sweep and waits behind it.
        db.prepare("DELETE FROM index_jobs WHERE project_id = ? AND branch = ? AND status != 'pending'").run(projectId, branch)
      }
      result.pruned.push({ branch, reason, points })
    } catch (err) {
      result.failed.push({ branch, error: String(err).slice(0, 200) })
    }
  }

  // Every branch but the default shares one checkout; once none is left, so is
  // any use for it.
  const checkout = join(BRANCH_CHECKOUTS_DIR, projectId)
  const featureBranchesLeft = (db.prepare(
    'SELECT COUNT(DISTINCT branch) AS n FROM index_jobs WHERE project_id = ? AND branch != ?'
  ).get(projectId, defaultBranch) as { n: number }).n
  if (!opts.dryRun && featureBranchesLeft === 0 && existsSync(checkout)) {
    await rm(checkout, { recursive: true, force: true })
    result.checkoutRemoved = true
  }

  return result
}

/**
 * Sweep one project inside its index queue, so no job of the project runs
 * alongside. Null when a job was running or waiting; the next sweep retries.
 */
export function sweepProjectBranchesWhenIdle(
  projectId: string,
  opts: { dryRun?: boolean; now?: number; retentionDays?: number } = {},
): Promise<SweepResult | null> {
  return runWhenQueueIdle(projectId, 'branch-sweep', () => sweepProjectBranches(projectId, opts))
}

const REASON_TEXT: Record<PruneReason, string> = {
  deleted: 'gone from the remote',
  merged: 'merged into the default branch',
  stale: 'idle',
}

/** Sweep every project with a repository, one after another. */
export async function sweepAllBranches(): Promise<SweepResult[]> {
  const projects = db.prepare('SELECT id FROM projects WHERE git_repo_url IS NOT NULL').all() as Array<{ id: string }>
  const results: SweepResult[] = []
  for (const { id } of projects) {
    try {
      const result = await sweepProjectBranchesWhenIdle(id)
      if (!result) {
        logger.info(`Branch sweep: ${id} is indexing, next sweep`)
        continue
      }
      results.push(result)
      for (const p of result.pruned) {
        logger.info(`Branch sweep: ${id} dropped ${p.branch} (${REASON_TEXT[p.reason]}), ${p.points} points`)
      }
      for (const f of result.failed) logger.warn(`Branch sweep: ${id} could not drop ${f.branch}: ${f.error}`)
      if (result.checkoutRemoved) logger.info(`Branch sweep: ${id} has no feature branch left, checkout removed`)
    } catch (err) {
      logger.warn(`Branch sweep: ${id} failed: ${String(err).slice(0, 200)}`)
    }
  }
  return results
}

/** Sweep a few minutes after start, then every six hours. Off when BRANCH_RETENTION_DAYS is 0. */
export function scheduleBranchSweep(): void {
  const days = retentionDays()
  if (days <= 0) {
    logger.info('Branch sweep off (BRANCH_RETENTION_DAYS=0)')
    return
  }
  logger.info(`Branch sweep on: branches gone from the remote, merged, or idle for ${days} days are dropped`)
  const run = () => void sweepAllBranches().catch((err) => logger.warn(`Branch sweep failed: ${String(err).slice(0, 200)}`))
  setTimeout(run, FIRST_SWEEP_DELAY_MS).unref()
  setInterval(run, SWEEP_INTERVAL_MS).unref()
}
