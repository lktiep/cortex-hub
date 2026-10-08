import type { ChildProcess } from 'child_process';
import { execFile, spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, rmSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import { join, extname } from 'path'
import { promisify } from 'util'
import { db } from '../db/client.js'
import { createLogger } from '@cortex/shared-utils'
import { embedProject } from './mem9-embedder.js'
import { buildKnowledgeFromDocs } from './docs-knowledge-builder.js'

const logger = createLogger('indexer')

// Track running processes for cancellation
const runningJobs = new Map<string, ChildProcess>()

const REPOS_DIR = process.env.REPOS_DIR ?? '/app/data/repos'

/**
 * Where every branch but the default one is checked out, a directory per
 * project. Hidden, so the GitNexus watchdog — which analyses each directory
 * directly under REPOS_DIR — never picks it up.
 */
const BRANCH_CHECKOUTS_DIR = join(REPOS_DIR, '.branches')

const execFileAsync = promisify(execFile)

/** Hand the event loop back so requests waiting on this process get answered. */
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

/** Strip the credentials buildAuthUrl puts into a URL before anything is logged. */
const redactCredentials = (text: string) => text.replace(/\/\/[^@]+@/g, '//<redacted>@')

interface ProjectRow {
  id: string
  git_repo_url: string | null
  git_provider: string | null
  git_username: string | null
  git_token: string | null
}

/**
 * Build authenticated git URL for private repos.
 * Supports: https://user:token@host/path.git
 */
export function buildAuthUrl(url: string, username?: string | null, token?: string | null): string {
  if (!token) return url

  try {
    const parsed = new URL(url)
    if (username) {
      parsed.username = encodeURIComponent(username)
    }
    parsed.password = encodeURIComponent(token)
    return parsed.toString()
  } catch {
    // For non-standard URLs (e.g., SSH), return as-is
    return url
  }
}

/**
 * The branch to index when the caller did not name one.
 *
 * Defaulting to the literal 'main' quietly indexed the wrong thing for every
 * repository that is still on 'master' — the clone succeeded, the checkout
 * fell back, and the job reported success against stale code. Ask the remote
 * what its HEAD points at instead, and cache the answer on the project so the
 * network round trip happens once.
 */
export async function resolveDefaultBranch(projectId: string): Promise<string> {
  const project = db.prepare(
    'SELECT git_repo_url, git_username, git_token, default_branch FROM projects WHERE id = ?'
  ).get(projectId) as {
    git_repo_url: string | null
    git_username: string | null
    git_token: string | null
    default_branch: string | null
  } | undefined

  if (project?.default_branch) return project.default_branch
  if (!project?.git_repo_url) return 'main'

  try {
    const authUrl = buildAuthUrl(project.git_repo_url, project.git_username, project.git_token)
    // Asynchronous: a slow remote must not stall every other request on this process.
    const { stdout: output } = await execFileAsync('git', ['ls-remote', '--symref', authUrl, 'HEAD'], {
      timeout: 15000,
      encoding: 'utf-8',
    })
    const match = output.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m)
    if (match?.[1]) {
      db.prepare('UPDATE projects SET default_branch = ? WHERE id = ?').run(match[1], projectId)
      logger.info(`Resolved default branch for ${projectId}: ${match[1]}`)
      return match[1]
    }
  } catch (err) {
    // A credential or network problem is the clone's business to report, not
    // this helper's: fall through to the old default so nothing new breaks.
    const msg = redactCredentials(String(err))
    logger.warn(`Could not resolve default branch for ${projectId}: ${msg.slice(0, 200)}`)
  }

  return 'main'
}

/**
 * Update job status in the database.
 */
function updateJob(jobId: string, updates: Record<string, unknown>) {
  const setClauses = Object.keys(updates)
    .map((k) => `${k} = ?`)
    .join(', ')
  const values = Object.values(updates)

  db.prepare(`UPDATE index_jobs SET ${setClauses} WHERE id = ?`).run(...values, jobId)
}

/**
 * Append to job log.
 */
function appendLog(jobId: string, text: string) {
  const current = db.prepare('SELECT log FROM index_jobs WHERE id = ?').get(jobId) as { log: string | null } | undefined
  const newLog = (current?.log ?? '') + text + '\n'
  // Keep last 10KB of logs
  const trimmed = newLog.length > 10240 ? newLog.slice(-10240) : newLog
  db.prepare('UPDATE index_jobs SET log = ? WHERE id = ?').run(trimmed, jobId)
}

// ── Symbol extraction patterns per language ──
const SYMBOL_PATTERNS: Record<string, RegExp[]> = {
  // TypeScript / JavaScript
  '.ts':  [/(?:export\s+)?(?:async\s+)?function\s+(\w+)/g, /(?:export\s+)?class\s+(\w+)/g, /(?:export\s+)?interface\s+(\w+)/g, /(?:export\s+)?type\s+(\w+)\s*=/g, /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/g, /(?:export\s+)?enum\s+(\w+)/g],
  '.tsx': [/(?:export\s+)?(?:async\s+)?function\s+(\w+)/g, /(?:export\s+)?class\s+(\w+)/g, /(?:export\s+)?interface\s+(\w+)/g, /(?:export\s+)?type\s+(\w+)\s*=/g, /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/g],
  '.js':  [/(?:export\s+)?(?:async\s+)?function\s+(\w+)/g, /(?:export\s+)?class\s+(\w+)/g, /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/g],
  '.jsx': [/(?:export\s+)?(?:async\s+)?function\s+(\w+)/g, /(?:export\s+)?class\s+(\w+)/g, /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/g],
  // Python
  '.py':  [/^(?:async\s+)?def\s+(\w+)/gm, /^class\s+(\w+)/gm],
  // Go
  '.go':  [/^func\s+(?:\([^)]+\)\s+)?(\w+)/gm, /^type\s+(\w+)\s+(?:struct|interface)/gm],
  // Rust
  '.rs':  [/^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/gm, /^(?:pub\s+)?struct\s+(\w+)/gm, /^(?:pub\s+)?enum\s+(\w+)/gm, /^(?:pub\s+)?trait\s+(\w+)/gm, /^(?:pub\s+)?type\s+(\w+)/gm],
  // Java / Kotlin
  '.java': [/(?:public|private|protected)?\s*(?:static\s+)?(?:class|interface|enum)\s+(\w+)/g, /(?:public|private|protected)\s+\w+\s+(\w+)\s*\(/g],
  '.kt':   [/(?:fun|class|interface|object|enum\s+class)\s+(\w+)/g],
  // Ruby
  '.rb':  [/^(?:\s*)def\s+(\w+)/gm, /^(?:\s*)class\s+(\w+)/gm, /^(?:\s*)module\s+(\w+)/gm],
  // PHP
  '.php': [/function\s+(\w+)/g, /class\s+(\w+)/g, /interface\s+(\w+)/g],
  // Vue / Svelte (extract script sections)
  '.vue': [/(?:export\s+)?(?:async\s+)?function\s+(\w+)/g, /(?:const|let|var)\s+(\w+)\s*=/g],
  '.svelte': [/(?:export\s+)?(?:async\s+)?function\s+(\w+)/g, /(?:const|let|var)\s+(\w+)\s*=/g],
  // SQL
  '.sql': [/CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|FUNCTION|PROCEDURE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:\w+\.)?(\w+)/gi],
  // CSS
  '.css': [/\.([a-zA-Z][\w-]+)\s*\{/g],
  // C# (.NET)
  '.cs': [/(?:public|private|protected|internal)?\s*(?:static\s+)?(?:async\s+)?(?:class|interface|struct|enum|record)\s+(\w+)/g, /(?:public|private|protected|internal)\s+(?:static\s+)?(?:async\s+)?[\w<>\[\]]+\s+(\w+)\s*\(/g],
  // Swift
  '.swift': [/(?:public\s+|private\s+|internal\s+|open\s+)?(?:class|struct|enum|protocol|func)\s+(\w+)/g],
  // Dart
  '.dart': [/(?:class|mixin|extension|enum)\s+(\w+)/g, /(?:Future|void|int|String|bool|double|dynamic)\s+(\w+)\s*\(/g],
  // Scala
  '.scala': [/(?:class|object|trait|def)\s+(\w+)/g],
  // Elixir
  '.ex':  [/def(?:p)?\s+(\w+)/g, /defmodule\s+([\w.]+)/g],
  '.exs': [/def(?:p)?\s+(\w+)/g, /defmodule\s+([\w.]+)/g],
  // Lua
  '.lua': [/function\s+(?:[\w.:]*)(\w+)/g, /local\s+function\s+(\w+)/g],
  // R
  '.r': [/(\w+)\s*<-\s*function/gi],
  // C / C++
  '.c':   [/^\w[\w\s*]+\s+(\w+)\s*\([^)]*\)\s*\{/gm, /^(?:typedef\s+)?struct\s+(\w+)/gm],
  '.h':   [/^\w[\w\s*]+\s+(\w+)\s*\([^)]*\)/gm, /^(?:typedef\s+)?struct\s+(\w+)/gm],
  '.cpp': [/^\w[\w\s*:]+\s+(\w+)\s*\([^)]*\)\s*(?:const\s*)?\{/gm, /^class\s+(\w+)/gm],
  '.hpp': [/^class\s+(\w+)/gm, /^\w[\w\s*:]+\s+(\w+)\s*\([^)]*\)/gm],
  // Objective-C
  '.m':   [/@(?:interface|implementation|protocol)\s+(\w+)/g, /^[-+]\s*\([^)]+\)\s*(\w+)/gm],
  // Shell
  '.sh':  [/^(\w+)\s*\(\)/gm, /^function\s+(\w+)/gm],
  // Perl
  '.pl':  [/^sub\s+(\w+)/gm, /^package\s+(\w+)/gm],
  '.pm':  [/^sub\s+(\w+)/gm, /^package\s+(\w+)/gm],
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.turbo', 'coverage', '.cache', 'vendor', '.pnpm-store', 'bin', 'obj', 'packages', '.vs', '.idea'])
const SOURCE_EXTENSIONS = new Set(Object.keys(SYMBOL_PATTERNS))
// Count ALL source/config files for total file count (broader than symbol extraction)
const ALL_SOURCE_EXTENSIONS = new Set([
  ...SOURCE_EXTENSIONS,
  '.md', '.json', '.yaml', '.yml', '.html', '.toml', '.env', '.sh', '.bash',
  '.xml', '.graphql', '.gql', '.proto', '.dockerfile', '.tf', '.hcl',
  '.svelte', '.astro', '.mdx', '.prisma', '.lock', '.conf', '.cfg', '.ini',
  '.csproj', '.sln', '.xaml', '.resx', '.props', '.targets', '.fsproj', '.vbproj',
  '.gradle', '.pom', '.cmake', '.makefile', '.mk',
  '.plist', '.storyboard', '.xib', '.pbxproj',
  '.txt', '.rst', '.adoc', '.csv', '.tsv',
])
const MAX_FILE_SIZE = 512 * 1024 // 512KB

/**
 * Walk directory recursively and extract symbols from source files.
 * Pure JS — no native dependencies.
 *
 * It reads and scans every file synchronously on the thread that serves the
 * API, so it hands the event loop back every few files: a search arriving
 * mid-index waits for one slice of the walk, not all of it.
 */
async function extractSymbolsFromDir(dir: string): Promise<{ totalFiles: number; symbolsFound: number; symbolNames: string[] }> {
  let totalFiles = 0
  const allSymbols: string[] = []

  async function walk(currentDir: string): Promise<void> {
    let entries: string[]
    try {
      entries = readdirSync(currentDir)
    } catch {
      return
    }

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue

      const fullPath = join(currentDir, entry)
      let stat
      try {
        stat = statSync(fullPath)
      } catch {
        continue
      }

      if (stat.isDirectory()) {
        await walk(fullPath)
      } else if (stat.isFile()) {
        const ext = extname(entry).toLowerCase()
        if (!ALL_SOURCE_EXTENSIONS.has(ext)) continue
        if (stat.size > MAX_FILE_SIZE) continue

        totalFiles++
        if (totalFiles % 50 === 0) await yieldToEventLoop()

        // Only extract symbols from code files (not config/docs)
        const patterns = SYMBOL_PATTERNS[ext]
        if (!patterns) continue

        try {
          const content = readFileSync(fullPath, 'utf-8')
          for (const pattern of patterns) {
            const regex = new RegExp(pattern.source, pattern.flags)
            let match
            while ((match = regex.exec(content)) !== null) {
              const name = match[1]
              if (name && name.length > 1 && !name.startsWith('_')) {
                allSymbols.push(name)
              }
            }
          }
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  await walk(dir)
  return { totalFiles, symbolsFound: allSymbols.length, symbolNames: allSymbols }
}

/**
 * Run a shell command and return a promise.
 */
function runCommand(cmd: string, args: string[], cwd: string, jobId: string): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, PATH: process.env.PATH } })
    runningJobs.set(jobId, child)

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString()
      stdout += text
      appendLog(jobId, redactCredentials(text.trim()))
    })

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString()
      stderr += text
      appendLog(jobId, `[stderr] ${redactCredentials(text.trim())}`)
    })

    child.on('close', (code) => {
      runningJobs.delete(jobId)
      resolve({ stdout: stdout + stderr, code: code ?? 0 })
    })

    child.on('error', (err) => {
      runningJobs.delete(jobId)
      reject(err)
    })
  })
}


// ── Job queue ──
//
// Every push used to start its own pipeline. Agents in worktrees push several
// branches of one project within minutes, and each pipeline re-cloned into the
// same directory and re-embedded the whole tree: the job row said 'done' before
// its embedding started, so nothing stopped the next one from stacking on top.
// Now each project runs one job at a time, through embedding and docs, and a
// branch waiting in line absorbs any further request for it.

interface QueuedJob {
  jobId: string
  branch: string
  force: boolean
}

interface ProjectQueue {
  running: QueuedJob | null
  waiting: QueuedJob[]
  idle: Promise<void>
}

const queues = new Map<string, ProjectQueue>()

export interface IndexRequest {
  jobId: string
  branch: string
  /** Waiting behind another job of the same project. */
  queued: boolean
  /** Folded into a job already waiting for this branch; no new row was made. */
  coalesced: boolean
}

/**
 * Ask for a branch to be indexed.
 *
 * Without `force`, a job that finds the branch already indexed at the remote's
 * commit — and the checkout still on it — finishes at once without cloning or
 * embedding. Pass `force` when a person asked for the work to be done again.
 */
export function requestIndexing(
  projectId: string,
  branch: string,
  opts: { triggeredBy?: string; force?: boolean } = {},
): IndexRequest {
  const triggeredBy = opts.triggeredBy ?? 'manual'
  let queue = queues.get(projectId)

  // A job for this branch has not started yet: when it does it clones the
  // branch as it is then, which already includes whatever this request is for.
  const waiting = queue?.waiting.find((job) => job.branch === branch)
  if (waiting) {
    if (opts.force) waiting.force = true
    appendLog(waiting.jobId, `↪ A ${triggeredBy} request for ${branch} joined this job`)
    return { jobId: waiting.jobId, branch, queued: true, coalesced: true }
  }

  const jobId = `idx-${randomUUID().slice(0, 12)}`
  db.prepare(
    `INSERT INTO index_jobs (id, project_id, branch, status, progress, triggered_by, created_at) VALUES (?, ?, ?, 'pending', 0, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`
  ).run(jobId, projectId, branch, triggeredBy)

  if (!queue) {
    queue = { running: null, waiting: [], idle: Promise.resolve() }
    queues.set(projectId, queue)
  }
  queue.waiting.push({ jobId, branch, force: opts.force ?? false })

  const queued = queue.running !== null
  if (queued) {
    appendLog(jobId, `⏳ Queued behind ${queue.running?.jobId} (${queue.running?.branch})`)
  } else {
    queue.idle = drain(projectId, queue)
  }
  return { jobId, branch, queued, coalesced: false }
}

/**
 * Run a project's jobs one after another until none is left.
 *
 * `running` is set before the first await, so a request arriving while this
 * starts sees the queue busy and only joins it.
 */
async function drain(projectId: string, queue: ProjectQueue): Promise<void> {
  let job: QueuedJob | undefined
  while ((job = queue.waiting.shift())) {
    queue.running = job
    try {
      const row = db.prepare('SELECT status FROM index_jobs WHERE id = ?').get(job.jobId) as { status: string } | undefined
      // Gone with its project, or cancelled while it waited.
      if (row?.status === 'pending') await indexBranch(projectId, job.jobId, job.branch, job.force)
    } catch (err) {
      logger.error(`[${job.jobId}] Index job crashed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      queue.running = null
    }
  }
  queues.delete(projectId)
}

/** Resolves once the project has no job running or waiting. */
export function indexQueueIdle(projectId: string): Promise<void> {
  return queues.get(projectId)?.idle ?? Promise.resolve()
}

/**
 * Run `work` in the project's queue as if it were a job, when the queue is idle.
 *
 * For work that must not overlap an index of the project — deleting a branch's
 * vectors while an embedding of that branch scrolls and writes them leaves the
 * job 'done' over points that are gone. A request that arrives meanwhile waits
 * behind `label` as it would behind a job, and runs once `work` settles.
 * Resolves to null without running `work` when a job is running or waiting.
 */
export async function runWhenQueueIdle<T>(projectId: string, label: string, work: () => Promise<T>): Promise<T | null> {
  if (queues.has(projectId)) return null

  const queue: ProjectQueue = { running: { jobId: label, branch: 'maintenance', force: false }, waiting: [], idle: Promise.resolve() }
  queues.set(projectId, queue)
  const result = Promise.resolve().then(work)
  const release = () => {
    queue.running = null
    if (queue.waiting.length > 0) return drain(projectId, queue)
    queues.delete(projectId)
  }
  queue.idle = result.then(release, release)
  return result
}

// ── Already indexed? ──

interface IndexedJobRow {
  id: string
  status: string
  mem9_status: string | null
  commit_hash: string | null
  commit_message: string | null
  symbols_found: number
  total_files: number
  mem9_chunks: number
  mem9_total_chunks: number
  docs_knowledge_status: string | null
  docs_knowledge_count: number
}

/** The commit a branch points at on the remote, or null if the remote cannot say. */
async function remoteBranchHead(authUrl: string, branch: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['ls-remote', authUrl, `refs/heads/${branch}`], {
      timeout: 15000,
      encoding: 'utf-8',
    })
    const sha = stdout.split(/\s/, 1)[0] ?? ''
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null
  } catch (err) {
    logger.warn(`ls-remote for ${branch} failed: ${redactCredentials(String(err)).slice(0, 200)}`)
    return null
  }
}

/** The commit the project's checkout is on, or null without one. */
async function checkoutHead(repoDir: string): Promise<string | null> {
  if (!existsSync(join(repoDir, '.git'))) return null
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, timeout: 5000, encoding: 'utf-8' })
    return stdout.trim()
  } catch {
    return null
  }
}

/**
 * Where a branch of the project is checked out.
 *
 * The default branch keeps the project's own directory: the one GitNexus builds
 * the code graph from and file reads resolve to. Every other branch shares a
 * second directory, so indexing a feature branch leaves the graph on the
 * default branch instead of dragging it to whichever branch was pushed last.
 */
async function checkoutFor(projectId: string, branch: string): Promise<{ repoDir: string; isDefault: boolean }> {
  const isDefault = branch === (await resolveDefaultBranch(projectId))
  return { repoDir: join(isDefault ? REPOS_DIR : BRANCH_CHECKOUTS_DIR, projectId), isDefault }
}

/**
 * Bring a checkout to the head of `branch`, updating it in place when it exists.
 *
 * Cloning afresh deleted the directory and the `.gitnexus/` graph inside it, so
 * every push cost GitNexus a full analysis — the kind that ran it out of
 * memory. A shallow fetch into the existing checkout keeps the graph, and the
 * analysis that follows only has to cover what changed. A fresh clone is left
 * for a directory that is missing or that git cannot update.
 */
async function syncCheckout(repoDir: string, branch: string, authUrl: string, jobId: string): Promise<boolean> {
  if (existsSync(join(repoDir, '.git'))) {
    const steps = [
      // The project's credentials may have changed since the clone.
      ['remote', 'set-url', 'origin', authUrl],
      ['fetch', '--depth', '1', '--no-tags', 'origin', `refs/heads/${branch}`],
      ['checkout', '--force', '-B', branch, 'FETCH_HEAD'],
      // Leftovers of the previous commit go; the graph stays.
      ['clean', '-ffdx', '-e', '.gitnexus'],
    ]
    // Named outright: with a broken .git, git would look for a repository in
    // the parent directories and clean that one instead.
    const pinned = [`--git-dir=${join(repoDir, '.git')}`, `--work-tree=${repoDir}`]
    let updated = true
    for (const args of steps) {
      if ((await runCommand('git', [...pinned, ...args], repoDir, jobId)).code !== 0) {
        updated = false
        break
      }
    }
    if (updated) return true
    appendLog(jobId, '[warn] Could not update the checkout in place — cloning it again')
  }

  await rm(repoDir, { recursive: true, force: true })
  mkdirSync(repoDir, { recursive: true })
  const clone = await runCommand('git', [
    'clone', '--branch', branch, '--depth', '1', '--single-branch', authUrl, '.',
  ], repoDir, jobId)
  return clone.code === 0
}

/**
 * The job that already indexed what the remote holds for this branch, if any.
 *
 * Three things have to agree: the branch's last job that ran finished both
 * stages, the remote still points at the commit that job indexed, and the
 * checkout is still on that commit. Every branch but the default one shares a
 * checkout, so indexing another of them in between means this one has to be
 * checked out again even though its vectors are current.
 */
async function findIndexedCommit(
  projectId: string, jobId: string, branch: string, authUrl: string, repoDir: string,
): Promise<IndexedJobRow | null> {
  const last = db.prepare(
    `SELECT id, status, mem9_status, commit_hash, commit_message, symbols_found, total_files,
            mem9_chunks, mem9_total_chunks, docs_knowledge_status, docs_knowledge_count
     FROM index_jobs
     WHERE project_id = ? AND branch = ? AND id != ? AND started_at IS NOT NULL
     ORDER BY created_at DESC, rowid DESC LIMIT 1`
  ).get(projectId, branch, jobId) as IndexedJobRow | undefined

  if (last?.status !== 'done' || last.mem9_status !== 'done' || !last.commit_hash) return null

  const remote = await remoteBranchHead(authUrl, branch)
  if (!remote?.startsWith(last.commit_hash)) return null
  if ((await checkoutHead(repoDir)) !== remote) return null
  return last
}

/**
 * Main indexing pipeline for one job; the queue runs it.
 */
async function indexBranch(projectId: string, jobId: string, branch: string, force: boolean): Promise<void> {
  const project = db.prepare('SELECT id, git_repo_url, git_provider, git_username, git_token FROM projects WHERE id = ?')
    .get(projectId) as ProjectRow | undefined

  if (!project?.git_repo_url) {
    updateJob(jobId, { status: 'error', error: 'Project has no git repository URL', completed_at: new Date().toISOString() })
    return
  }

  const cloningSentinel = join(REPOS_DIR, `${projectId}.cloning`)
  const authUrl = buildAuthUrl(project.git_repo_url, project.git_username, project.git_token)

  try {
    updateJob(jobId, { status: 'cloning', progress: 5, started_at: new Date().toISOString() })
    const { repoDir, isDefault } = await checkoutFor(projectId, branch)

    // ── Step 0: Nothing new to index ──
    if (!force) {
      const indexed = await findIndexedCommit(projectId, jobId, branch, authUrl, repoDir)
      if (indexed) {
        updateJob(jobId, {
          status: 'done',
          progress: 100,
          completed_at: new Date().toISOString(),
          commit_hash: indexed.commit_hash,
          commit_message: indexed.commit_message,
          symbols_found: indexed.symbols_found,
          total_files: indexed.total_files,
          mem9_status: 'done',
          mem9_progress: 100,
          mem9_chunks: indexed.mem9_chunks,
          mem9_total_chunks: indexed.mem9_total_chunks,
          docs_knowledge_status: indexed.docs_knowledge_status,
          docs_knowledge_count: indexed.docs_knowledge_count,
        })
        appendLog(jobId, `⏭ ${branch} is already indexed at ${indexed.commit_hash} (job ${indexed.id}) — nothing to do`)
        logger.info(`[${jobId}] ${branch} already indexed at ${indexed.commit_hash}, skipped`)
        return
      }
    }

    // ── Step 1: Check out ──
    logger.info(`[${jobId}] Checking out ${redactCredentials(project.git_repo_url)} branch=${branch}`)

    mkdirSync(REPOS_DIR, { recursive: true })
    // Keeps the GitNexus watchdog off the default checkout while it changes.
    if (isDefault) writeFileSync(cloningSentinel, '')
    try {
      if (!(await syncCheckout(repoDir, branch, authUrl, jobId))) {
        updateJob(jobId, { status: 'error', error: `git could not check out ${branch}`, progress: 5, completed_at: new Date().toISOString() })
        return
      }
    } finally {
      if (isDefault) rmSync(cloningSentinel, { force: true })
    }

    updateJob(jobId, { progress: 25 })
    logger.info(`[${jobId}] Checkout complete`)

    // ── Step 1b: Extract commit info from HEAD ──
    try {
      const git = (args: string[]) =>
        execFileAsync('git', args, { cwd: repoDir, encoding: 'utf-8', timeout: 5000 }).then((r) => r.stdout.trim())
      const commitHash = await git(['rev-parse', '--short', 'HEAD'])
      const commitMessage = await git(['log', '-1', '--format=%s'])
      updateJob(jobId, { commit_hash: commitHash, commit_message: commitMessage.slice(0, 200) })
      appendLog(jobId, `📌 Commit: ${commitHash} — ${commitMessage.slice(0, 100)}`)
      logger.info(`[${jobId}] HEAD commit: ${commitHash} — ${commitMessage.slice(0, 60)}`)
    } catch {
      // Non-fatal — commit info is nice-to-have
      logger.warn(`[${jobId}] Could not extract commit info`)
    }

    // ── Step 2: GitNexus Analyze ──
    // Try CLI first (only works if gitnexus is installed in this container),
    // then the pure JS fallback.
    updateJob(jobId, { status: 'analyzing', progress: 30 })
    logger.info(`[${jobId}] Running gitnexus analyze`)

    let symbolsFound = 0
    let totalFiles = 0
    let symbolNames: string[] = []

    // Strategy 1: Try local CLI (fast, uses Tree-sitter AST)
    let gitnexusSuccess = false
    try {
      const analyzeResult = await runCommand('gitnexus', [
        'analyze', '.', '--force', '--embeddings'
      ], repoDir, jobId)

      const symbolMatch = analyzeResult.stdout.match(/(\d+)\s*symbols?/i)
      const fileMatch = analyzeResult.stdout.match(/(\d+)\s*files?/i)
      if (symbolMatch?.[1]) symbolsFound = parseInt(symbolMatch[1], 10)
      if (fileMatch?.[1]) totalFiles = parseInt(fileMatch[1], 10)

      if (analyzeResult.code === 0 && (symbolsFound > 0 || totalFiles > 0)) {
        gitnexusSuccess = true
        appendLog(jobId, `GitNexus: ${totalFiles} files, ${symbolsFound} symbols`)
      }
    } catch {
      // gitnexus not installed locally — expected in cortex-api container
    }

    // Strategy 2: Pure JS fallback (regex-based, no native deps)
    if (!gitnexusSuccess) {
      appendLog(jobId, `[info] Using pure JS symbol extraction (gitnexus CLI not available)`)
      logger.info(`[${jobId}] Using pure JS fallback extraction`)

      const fallback = await extractSymbolsFromDir(repoDir)
      totalFiles = fallback.totalFiles
      symbolsFound = fallback.symbolsFound
      symbolNames = fallback.symbolNames
      appendLog(jobId, `Extracted: ${totalFiles} files, ${symbolsFound} symbols`)
    }

    if (symbolNames.length > 0) {
      appendLog(jobId, `Sample symbols: ${symbolNames.slice(0, 20).join(', ')}`)
    }

    updateJob(jobId, { progress: 90, symbols_found: symbolsFound, total_files: totalFiles })
    logger.info(`[${jobId}] Analysis complete: ${symbolsFound} symbols, ${totalFiles} files`)

    // ── Step 3: Update Project ──
    db.prepare(
      `UPDATE projects SET indexed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), indexed_symbols = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`
    ).run(symbolsFound, projectId)

    updateJob(jobId, {
      status: 'done',
      progress: 100,
      completed_at: new Date().toISOString()
    })

    logger.info(`[${jobId}] Indexing complete!`)

    // ── Steps 4-5: Embed, then learn from the docs ──
    // Awaited: the next job of this project must not start on top of them.
    await embedAndBuildDocs(projectId, jobId, branch, repoDir)
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    logger.error(`[${jobId}] Indexing failed: ${errorMsg}`)
    updateJob(jobId, {
      status: 'error',
      error: errorMsg,
      completed_at: new Date().toISOString()
    })
  }
}

async function embedAndBuildDocs(projectId: string, jobId: string, branch: string, repoDir: string): Promise<void> {
  updateJob(jobId, { mem9_status: 'embedding' })
  appendLog(jobId, '🧠 Starting mem9 embedding...')

  try {
    const result = await embedProject(projectId, branch, jobId, (progress, chunks, totalChunks) => {
      db.prepare('UPDATE index_jobs SET mem9_chunks = ?, mem9_progress = ?, mem9_total_chunks = ? WHERE id = ?')
        .run(chunks, progress, totalChunks, jobId)
    }, repoDir)
    updateJob(jobId, { mem9_status: result.status, mem9_chunks: result.chunks })
    appendLog(
      jobId,
      `${result.status === 'done' ? '✅' : '⚠️'} mem9 ${result.status}: ${result.chunks} chunks — ` +
        `${result.embedded ?? 0} embedded, ${result.reused ?? 0} reused, ` +
        `${result.unchanged ?? 0} unchanged, ${result.removed ?? 0} removed`,
    )
    if (result.errors.length > 0) {
      appendLog(jobId, `⚠️ mem9 errors: ${result.errors.slice(0, 3).join('; ')}`)
    }
    logger.info(`[${jobId}] mem9 ${result.status}: ${result.chunks} chunks, ${result.embedded ?? 0} embedded`)
  } catch (err) {
    updateJob(jobId, { mem9_status: 'error' })
    appendLog(jobId, `❌ mem9 failed: ${err}`)
    logger.warn(`[${jobId}] mem9 failed (non-fatal): ${err}`)
    return
  }

  updateJob(jobId, { docs_knowledge_status: 'building' })
  appendLog(jobId, '📚 Building knowledge from documentation...')
  try {
    const docsResult = await buildKnowledgeFromDocs(projectId, jobId, repoDir)
    updateJob(jobId, {
      docs_knowledge_status: 'done',
      docs_knowledge_count: docsResult.docsProcessed,
    })
    appendLog(jobId, `📚 Docs knowledge: ${docsResult.docsProcessed}/${docsResult.docsFound} docs → ${docsResult.chunksCreated} chunks`)
    logger.info(`[${jobId}] Docs knowledge complete: ${docsResult.docsProcessed} docs processed`)
  } catch (err) {
    updateJob(jobId, { docs_knowledge_status: 'error' })
    appendLog(jobId, `⚠️ Docs knowledge failed (non-fatal): ${err}`)
    logger.warn(`[${jobId}] Docs knowledge failed: ${err}`)
  }
}

/**
 * Cancel an indexing job: drop it from its queue if it has not started, or
 * stop the process it is running.
 */
export function cancelJob(jobId: string): boolean {
  for (const queue of queues.values()) {
    const at = queue.waiting.findIndex((job) => job.jobId === jobId)
    if (at >= 0) {
      queue.waiting.splice(at, 1)
      updateJob(jobId, { status: 'error', error: 'Cancelled by user', completed_at: new Date().toISOString() })
      return true
    }
  }

  const child = runningJobs.get(jobId)
  if (child) {
    child.kill('SIGTERM')
    runningJobs.delete(jobId)
    updateJob(jobId, {
      status: 'error',
      error: 'Cancelled by user',
      completed_at: new Date().toISOString()
    })
    return true
  }
  return false
}

/**
 * Close the jobs a previous process left open.
 *
 * The queue lives in memory, so a restart forgets it. Without this a job that
 * was running or waiting stays 'pending' or 'embedding' forever and the
 * dashboard shows it busy. Call once at startup, before taking requests. Not
 * re-run automatically: a job that took the process down would do it again.
 */
export function recoverInterruptedJobs(): { jobs: number; embeddings: number; docs: number } {
  const jobs = db.prepare(
    `UPDATE index_jobs SET status = 'error', error = 'Interrupted by restart', completed_at = ?
     WHERE status IN ('pending', 'cloning', 'analyzing', 'ingesting')`
  ).run(new Date().toISOString()).changes
  const embeddings = db.prepare(
    `UPDATE index_jobs SET mem9_status = 'error' WHERE mem9_status = 'embedding'`
  ).run().changes
  const docs = db.prepare(
    `UPDATE index_jobs SET docs_knowledge_status = 'error' WHERE docs_knowledge_status = 'building'`
  ).run().changes

  if (jobs + embeddings + docs > 0) {
    logger.warn(`Closed work interrupted by a restart: ${jobs} jobs, ${embeddings} embeddings, ${docs} docs builds`)
  }
  return { jobs, embeddings, docs }
}
