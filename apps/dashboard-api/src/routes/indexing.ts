import { Hono } from 'hono'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { join } from 'path'
import { db } from '../db/client.js'
import { startIndexing, cancelJob, buildAuthUrl } from '../services/indexer.js'

const REPOS_DIR = process.env.REPOS_DIR ?? '/data/repos'

export const indexingRouter = new Hono()

interface IndexJob {
  id: string
  project_id: string
  branch: string
  status: string
  progress: number
  total_files: number
  symbols_found: number
  log: string | null
  error: string | null
  started_at: string | null
  completed_at: string | null
  created_at: string
}

// ── Start Indexing ──
indexingRouter.post('/:id/index', async (c) => {
  const projectId = c.req.param('id')

  try {
    // Verify project exists and has a git URL
    const project = db.prepare('SELECT id, git_repo_url FROM projects WHERE id = ?').get(projectId) as {
      id: string
      git_repo_url: string | null
    } | undefined

    if (!project) return c.json({ error: 'Project not found' }, 404)
    if (!project.git_repo_url) return c.json({ error: 'Project has no git repository URL configured' }, 400)

    // Check if there's already a running job
    const activeJob = db.prepare(
      `SELECT id FROM index_jobs WHERE project_id = ? AND status IN ('pending', 'cloning', 'analyzing', 'ingesting')`
    ).get(projectId) as { id: string } | undefined

    if (activeJob) {
      return c.json({ error: 'An indexing job is already running', jobId: activeJob.id }, 409)
    }

    // Parse branch from body
    let branch = 'main'
    try {
      const body = await c.req.json()
      if (body.branch) branch = body.branch
    } catch {
      // No body is OK, use default branch
    }

    // Create job record
    const jobId = `idx-${randomUUID().slice(0, 12)}`
    db.prepare(
      `INSERT INTO index_jobs (id, project_id, branch, status, progress) VALUES (?, ?, ?, 'pending', 0)`
    ).run(jobId, projectId, branch)

    // Fire and forget — run indexing in background
    startIndexing(projectId, jobId, branch).catch(() => {
      // Error is already logged by indexer.ts
    })

    return c.json({ jobId, status: 'pending', branch }, 201)
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Get Current Index Status ──
indexingRouter.get('/:id/index/status', (c) => {
  const projectId = c.req.param('id')

  try {
    const job = db.prepare(
      `SELECT * FROM index_jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`
    ).get(projectId) as IndexJob | undefined

    if (!job) return c.json({ status: 'none', message: 'No indexing jobs found' })

    return c.json({
      jobId: job.id,
      branch: job.branch,
      status: job.status,
      progress: job.progress,
      totalFiles: job.total_files,
      symbolsFound: job.symbols_found,
      error: job.error,
      log: job.log,
      startedAt: job.started_at,
      completedAt: job.completed_at,
      createdAt: job.created_at,
    })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Get Index History ──
indexingRouter.get('/:id/index/history', (c) => {
  const projectId = c.req.param('id')

  try {
    const jobs = db.prepare(
      `SELECT id, branch, status, progress, total_files, symbols_found, error, started_at, completed_at, created_at
       FROM index_jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 20`
    ).all(projectId) as IndexJob[]

    return c.json({ jobs })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Cancel Running Job ──
indexingRouter.post('/:id/index/cancel', (c) => {
  const projectId = c.req.param('id')

  try {
    // Find running job
    const activeJob = db.prepare(
      `SELECT id FROM index_jobs WHERE project_id = ? AND status IN ('pending', 'cloning', 'analyzing', 'ingesting') ORDER BY created_at DESC LIMIT 1`
    ).get(projectId) as { id: string } | undefined

    if (!activeJob) return c.json({ error: 'No active indexing job found' }, 404)

    const cancelled = cancelJob(activeJob.id)
    if (!cancelled) {
      // Process already exited, just mark as error
      db.prepare(
        `UPDATE index_jobs SET status = 'error', error = 'Cancelled by user', completed_at = datetime('now') WHERE id = ?`
      ).run(activeJob.id)
    }

    return c.json({ success: true, jobId: activeJob.id })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── List Remote Branches ──
indexingRouter.get('/:id/branches', async (c) => {
  const projectId = c.req.param('id')

  try {
    const project = db.prepare(
      'SELECT git_repo_url, git_username, git_token FROM projects WHERE id = ?'
    ).get(projectId) as { git_repo_url: string | null; git_username: string | null; git_token: string | null } | undefined

    if (!project?.git_repo_url) return c.json({ branches: [], error: 'No git repository URL' })

    const authUrl = buildAuthUrl(project.git_repo_url, project.git_username, project.git_token)

    // Use git ls-remote to list branches without cloning
    const { execSync } = await import('child_process')
    const output = execSync(`git ls-remote --heads "${authUrl}" 2>/dev/null`, {
      timeout: 15000,
      encoding: 'utf-8',
    })

    const branches = output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const ref = line.split('\t')[1] ?? ''
        return ref.replace('refs/heads/', '')
      })
      .filter(Boolean)
      .sort((a, b) => {
        // main/master first, then alphabetical
        if (a === 'main' || a === 'master') return -1
        if (b === 'main' || b === 'master') return 1
        return a.localeCompare(b)
      })

    return c.json({ branches })
  } catch (error) {
    return c.json({ branches: [], error: `Failed to list branches: ${String(error).slice(0, 200)}` })
  }
})

// ── Branch Diff (files changed vs base branch) ──
indexingRouter.get('/:id/branches/diff', async (c) => {
  const projectId = c.req.param('id')
  const branch = c.req.query('branch')
  const base = c.req.query('base') ?? 'main'

  if (!branch) return c.json({ error: 'branch query param required' }, 400)
  if (branch === base) return c.json({ diff: [], message: 'Same branch' })

  try {
    const repoDir = join(REPOS_DIR, projectId)

    if (!existsSync(repoDir)) {
      return c.json({ diff: [], message: 'Repository not cloned yet. Run indexing on main first.' })
    }

    const { execSync } = await import('child_process')

    // Fetch the branch if not already available
    try {
      execSync(`git fetch origin ${branch} 2>/dev/null`, { cwd: repoDir, timeout: 15000 })
    } catch {
      // Branch may already be local
    }

    // Get diff summary: files changed between base and branch
    const output = execSync(
      `git diff --name-status origin/${base}...origin/${branch} 2>/dev/null || echo ""`,
      { cwd: repoDir, encoding: 'utf-8', timeout: 10000 }
    )

    const diff = output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [status, ...fileParts] = line.split('\t')
        const file = fileParts.join('\t')
        return {
          status: status === 'A' ? 'added' : status === 'D' ? 'deleted' : status === 'M' ? 'modified' : status ?? 'unknown',
          file,
        }
      })
      .filter((d) => d.file)

    const summary = {
      added: diff.filter((d) => d.status === 'added').length,
      modified: diff.filter((d) => d.status === 'modified').length,
      deleted: diff.filter((d) => d.status === 'deleted').length,
      total: diff.length,
    }

    return c.json({ branch, base, diff, summary })
  } catch (error) {
    return c.json({ diff: [], error: `Diff failed: ${String(error).slice(0, 200)}` })
  }
})

// ── Per-Branch Index Summary ──
indexingRouter.get('/:id/index/branches', (c) => {
  const projectId = c.req.param('id')

  try {
    // Get the latest job per branch
    const jobs = db.prepare(
      `SELECT branch, status, progress, total_files, symbols_found, completed_at, created_at
       FROM index_jobs
       WHERE project_id = ?
         AND id IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (PARTITION BY branch ORDER BY created_at DESC) as rn
             FROM index_jobs WHERE project_id = ?
           ) WHERE rn = 1
         )
       ORDER BY created_at DESC`
    ).all(projectId, projectId)

    return c.json({ branches: jobs })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

