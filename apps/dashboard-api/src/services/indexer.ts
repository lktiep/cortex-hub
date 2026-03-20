import { spawn, ChildProcess } from 'child_process'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { db } from '../db/client.js'
import { createLogger } from '@cortex/shared-utils'

const logger = createLogger('indexer')

// Track running processes for cancellation
const runningJobs = new Map<string, ChildProcess>()

const REPOS_DIR = process.env.REPOS_DIR ?? '/data/repos'

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
      appendLog(jobId, text.trim())
    })

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString()
      stderr += text
      appendLog(jobId, `[stderr] ${text.trim()}`)
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

/**
 * Main indexing pipeline — runs async (fire-and-forget from API).
 */
export async function startIndexing(projectId: string, jobId: string, branch: string): Promise<void> {
  const project = db.prepare('SELECT id, git_repo_url, git_provider, git_username, git_token FROM projects WHERE id = ?')
    .get(projectId) as ProjectRow | undefined

  if (!project?.git_repo_url) {
    updateJob(jobId, { status: 'error', error: 'Project has no git repository URL', completed_at: new Date().toISOString() })
    return
  }

  const repoDir = join(REPOS_DIR, projectId)

  try {
    // ── Step 1: Clone ──
    updateJob(jobId, { status: 'cloning', progress: 5, started_at: new Date().toISOString() })
    logger.info(`[${jobId}] Cloning ${project.git_repo_url} branch=${branch}`)

    // Clean previous clone
    if (existsSync(repoDir)) {
      rmSync(repoDir, { recursive: true, force: true })
    }
    mkdirSync(repoDir, { recursive: true })

    const authUrl = buildAuthUrl(project.git_repo_url, project.git_username, project.git_token)
    const cloneResult = await runCommand('git', [
      'clone', '--branch', branch, '--depth', '1', '--single-branch', authUrl, '.'
    ], repoDir, jobId)

    if (cloneResult.code !== 0) {
      updateJob(jobId, { status: 'error', error: `git clone failed (exit ${cloneResult.code})`, progress: 5, completed_at: new Date().toISOString() })
      return
    }

    updateJob(jobId, { progress: 25 })
    logger.info(`[${jobId}] Clone complete`)

    // ── Step 2: GitNexus Analyze (non-fatal) ──
    updateJob(jobId, { status: 'analyzing', progress: 30 })
    logger.info(`[${jobId}] Running gitnexus analyze`)

    const analyzeResult = await runCommand('npx', [
      '-y', 'gitnexus', 'analyze', '.', '--force'
    ], repoDir, jobId)

    // Parse symbols count from gitnexus output
    let symbolsFound = 0
    let totalFiles = 0
    const symbolMatch = analyzeResult.stdout.match(/(\d+)\s*symbols?/i)
    const fileMatch = analyzeResult.stdout.match(/(\d+)\s*files?/i)
    if (symbolMatch?.[1]) symbolsFound = parseInt(symbolMatch[1], 10)
    if (fileMatch?.[1]) totalFiles = parseInt(fileMatch[1], 10)

    if (analyzeResult.code !== 0) {
      // GitNexus failed (e.g. GLIBC mismatch) — graceful degradation
      appendLog(jobId, `[warn] gitnexus failed (exit ${analyzeResult.code}), falling back to file counting`)
      logger.warn(`[${jobId}] GitNexus failed (non-fatal): exit ${analyzeResult.code}`)

      // Fallback: count files ourselves
      try {
        const fallbackResult = await runCommand('find', [
          '.', '-type', 'f',
          '(', '-name', '*.ts', '-o', '-name', '*.js', '-o', '-name', '*.tsx', '-o', '-name', '*.jsx',
          '-o', '-name', '*.py', '-o', '-name', '*.go', '-o', '-name', '*.rs', '-o', '-name', '*.java',
          '-o', '-name', '*.rb', '-o', '-name', '*.php', '-o', '-name', '*.vue', '-o', '-name', '*.svelte',
          '-o', '-name', '*.css', '-o', '-name', '*.html', '-o', '-name', '*.json', '-o', '-name', '*.yaml',
          '-o', '-name', '*.yml', '-o', '-name', '*.md', '-o', '-name', '*.sql', ')',
          '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.git/*', '-not', '-path', '*/dist/*',
          '-not', '-path', '*/build/*', '-not', '-path', '*/.next/*',
        ], repoDir, jobId)
        totalFiles = fallbackResult.stdout.split('\n').filter(Boolean).length
        appendLog(jobId, `Fallback file count: ${totalFiles} source files`)
      } catch {
        appendLog(jobId, `[warn] File counting also failed, continuing with 0`)
      }
    }

    updateJob(jobId, { progress: 70, symbols_found: symbolsFound, total_files: totalFiles })
    logger.info(`[${jobId}] GitNexus analyze complete: ${symbolsFound} symbols, ${totalFiles} files`)

    // ── Step 3: mem0 Ingest (branch-scoped) ──
    updateJob(jobId, { status: 'ingesting', progress: 80 })
    logger.info(`[${jobId}] Ingesting to mem0 (branch-scoped)`)

    try {
      const mem0Url = process.env.MEM0_URL ?? 'http://mem0:8000'
      const summary = `Project ${project.id} indexed on branch "${branch}": ${symbolsFound} symbols across ${totalFiles} files. Repository: ${project.git_repo_url}`

      // Branch-scoped memory: user_id = "project-{id}:branch-{name}"
      // This enables branch-level isolation when searching
      const branchUserId = `project-${projectId}:branch-${branch}`
      const baseUserId = `project-${projectId}`

      // Store branch-specific memory
      await fetch(`${mem0Url}/v1/memories/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: summary }],
          user_id: branchUserId,
          metadata: {
            type: 'index',
            project_id: projectId,
            branch,
            symbols: symbolsFound,
            files: totalFiles,
            indexed_at: new Date().toISOString(),
          }
        }),
        signal: AbortSignal.timeout(15000),
      })

      // Also store a base project-level memory (for fallback queries without branch)
      await fetch(`${mem0Url}/v1/memories/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: `[branch:${branch}] ${summary}` }],
          user_id: baseUserId,
          metadata: {
            type: 'index',
            project_id: projectId,
            branch,
            symbols: symbolsFound,
            files: totalFiles,
            indexed_at: new Date().toISOString(),
          }
        }),
        signal: AbortSignal.timeout(15000),
      })

      appendLog(jobId, `mem0 ingest OK (branch-scoped: ${branchUserId})`)
    } catch (err) {
      // mem0 failure is non-fatal — log but continue
      appendLog(jobId, `[warn] mem0 ingest failed: ${err}`)
      logger.warn(`[${jobId}] mem0 ingest failed (non-fatal): ${err}`)
    }

    updateJob(jobId, { progress: 95 })

    // ── Step 4: Update Project ──
    db.prepare(
      `UPDATE projects SET indexed_at = datetime('now'), indexed_symbols = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(symbolsFound, projectId)

    updateJob(jobId, {
      status: 'done',
      progress: 100,
      completed_at: new Date().toISOString()
    })

    logger.info(`[${jobId}] Indexing complete!`)

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

/**
 * Cancel a running indexing job.
 */
export function cancelJob(jobId: string): boolean {
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
