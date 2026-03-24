import { Hono } from 'hono'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { join } from 'path'
import { db } from '../db/client.js'
import { startIndexing, cancelJob, buildAuthUrl } from '../services/indexer.js'
import { embedProject } from '../services/mem9-embedder.js'
import { buildKnowledgeFromDocs } from '../services/docs-knowledge-builder.js'

const REPOS_DIR = process.env.REPOS_DIR ?? '/app/data/repos'

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
  commit_hash: string | null
  commit_message: string | null
  triggered_by: string | null
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
    let triggeredBy = 'manual'
    try {
      const body = await c.req.json()
      if (body.branch) branch = body.branch
      if (body.triggeredBy) triggeredBy = body.triggeredBy
    } catch {
      // No body is OK, use default branch
    }

    // Create job record
    const jobId = `idx-${randomUUID().slice(0, 12)}`
    db.prepare(
      `INSERT INTO index_jobs (id, project_id, branch, status, progress, triggered_by) VALUES (?, ?, ?, 'pending', 0, ?)`
    ).run(jobId, projectId, branch, triggeredBy)

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
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10))
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') ?? '10', 10)))
  const offset = (page - 1) * limit

  try {
    const totalRow = db.prepare(
      'SELECT COUNT(*) as total FROM index_jobs WHERE project_id = ?'
    ).get(projectId) as { total: number }
    const total = totalRow?.total ?? 0

    const jobs = db.prepare(
      `SELECT id, branch, status, progress, total_files, symbols_found, error,
              commit_hash, commit_message, triggered_by,
              started_at, completed_at, created_at
       FROM index_jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(projectId, limit, offset) as IndexJob[]

    return c.json({ jobs, total, page, limit, totalPages: Math.ceil(total / limit) })
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

// ── Test Git Connection ──
indexingRouter.post('/:id/git/test', async (c) => {
  const projectId = c.req.param('id')

  try {
    const project = db.prepare(
      'SELECT git_repo_url, git_username, git_token FROM projects WHERE id = ?'
    ).get(projectId) as { git_repo_url: string | null; git_username: string | null; git_token: string | null } | undefined

    if (!project?.git_repo_url) return c.json({ success: false, error: 'No git repository URL configured' })

    const authUrl = buildAuthUrl(project.git_repo_url, project.git_username, project.git_token)

    const { execFileSync } = await import('child_process')
    try {
      const output = execFileSync('git', ['ls-remote', '--heads', authUrl], {
        timeout: 15000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      const branchCount = output.split('\n').filter(Boolean).length
      const defaultBranch = output.split('\n').filter(Boolean)
        .map((l) => l.split('\t')[1]?.replace('refs/heads/', '') ?? '')
        .find((b) => b === 'main' || b === 'master') ?? 'unknown'

      return c.json({
        success: true,
        message: `Connected successfully! Found ${branchCount} branch(es).`,
        branchCount,
        defaultBranch,
      })
    } catch (err: unknown) {
      const stderr = (err as { stderr?: string })?.stderr ?? String(err)
      // Sanitize: remove auth tokens from error output
      const sanitized = stderr.replace(/\/\/[^@]+@/g, '//<redacted>@')
      return c.json({ success: false, error: sanitized.slice(0, 500) })
    }
  } catch (error) {
    return c.json({ success: false, error: String(error).slice(0, 300) })
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

    // Use execFileSync (no shell) to avoid URL injection issues with @, :, etc.
    const { execFileSync } = await import('child_process')
    let output: string
    try {
      output = execFileSync('git', ['ls-remote', '--heads', authUrl], {
        timeout: 15000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err: unknown) {
      const stderr = (err as { stderr?: string })?.stderr ?? String(err)
      const sanitized = stderr.replace(/\/\/[^@]+@/g, '//<redacted>@')
      return c.json({ branches: [], error: sanitized.slice(0, 300) })
    }

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
      `SELECT j.branch, j.status, j.progress, j.total_files, j.symbols_found, 
              j.mem9_status, j.mem9_chunks,
              COALESCE(
                NULLIF(j.docs_knowledge_status, NULL),
                (SELECT docs_knowledge_status FROM index_jobs 
                 WHERE project_id = ? AND branch = j.branch 
                   AND docs_knowledge_count > 0
                 ORDER BY created_at DESC LIMIT 1)
              ) as docs_knowledge_status,
              COALESCE(
                NULLIF(j.docs_knowledge_count, 0),
                (SELECT docs_knowledge_count FROM index_jobs 
                 WHERE project_id = ? AND branch = j.branch 
                   AND docs_knowledge_count > 0
                 ORDER BY created_at DESC LIMIT 1),
                0
              ) as docs_knowledge_count,
              j.completed_at, j.created_at
       FROM index_jobs j
       WHERE j.project_id = ?
         AND j.id IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (PARTITION BY branch ORDER BY created_at DESC) as rn
             FROM index_jobs WHERE project_id = ?
           ) WHERE rn = 1
         )
       ORDER BY j.created_at DESC`
    ).all(projectId, projectId, projectId, projectId)

    return c.json({ branches: jobs })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Trigger Mem9 Embedding (standalone, per-branch) ──
indexingRouter.post('/:id/index/mem9', async (c) => {
  const projectId = c.req.param('id')
  const targetBranch = c.req.query('branch')

  try {
    // Find the target job: specific branch or latest completed
    const query = targetBranch
      ? `SELECT id, branch, status, mem9_status FROM index_jobs 
         WHERE project_id = ? AND branch = ? AND status = 'done' 
         ORDER BY completed_at DESC LIMIT 1`
      : `SELECT id, branch, status, mem9_status FROM index_jobs 
         WHERE project_id = ? AND status = 'done' 
         ORDER BY completed_at DESC LIMIT 1`

    const params = targetBranch ? [projectId, targetBranch] : [projectId]
    const latestJob = db.prepare(query).get(...params) as {
      id: string; branch: string; status: string; mem9_status: string
    } | undefined

    if (!latestJob) {
      return c.json({ error: 'No completed indexing job found. Run GitNexus indexing first.' }, 400)
    }

    // Check if mem9 is already running
    if (latestJob.mem9_status === 'embedding') {
      return c.json({ error: 'Mem9 embedding is already running for this branch.' }, 409)
    }

    const jobId = latestJob.id
    const branch = latestJob.branch

    // Mark as embedding
    db.prepare("UPDATE index_jobs SET mem9_status = 'embedding', mem9_chunks = 0 WHERE id = ?").run(jobId)

    // Fire and forget — run embedding in background
    embedProject(projectId, branch, jobId, (_progress, chunks) => {
      db.prepare('UPDATE index_jobs SET mem9_chunks = ? WHERE id = ?').run(chunks, jobId)
    }).then((result) => {
      db.prepare('UPDATE index_jobs SET mem9_status = ?, mem9_chunks = ? WHERE id = ?')
        .run(result.status, result.chunks, jobId)
    }).catch((err) => {
      db.prepare("UPDATE index_jobs SET mem9_status = 'error' WHERE id = ?").run(jobId)
      console.error('[mem9] Embedding failed:', err)
    })

    return c.json({ success: true, jobId, branch, status: 'embedding' }, 201)
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Get Mem9 Status ──
indexingRouter.get('/:id/index/mem9/status', (c) => {
  const projectId = c.req.param('id')

  try {
    const job = db.prepare(
      `SELECT id, branch, mem9_status, mem9_chunks, status as gitnexus_status, 
              symbols_found, total_files, completed_at
       FROM index_jobs 
       WHERE project_id = ? AND status = 'done'
       ORDER BY completed_at DESC LIMIT 1`
    ).get(projectId) as {
      id: string; branch: string; mem9_status: string; mem9_chunks: number;
      gitnexus_status: string; symbols_found: number; total_files: number; completed_at: string
    } | undefined

    if (!job) {
      return c.json({
        gitnexus: { status: 'none' },
        mem9: { status: 'none' },
      })
    }

    return c.json({
      jobId: job.id,
      branch: job.branch,
      gitnexus: {
        status: job.gitnexus_status,
        symbols: job.symbols_found,
        files: job.total_files,
        completedAt: job.completed_at,
      },
      mem9: {
        status: job.mem9_status ?? 'pending',
        chunks: job.mem9_chunks ?? 0,
      },
      docsKnowledge: {
        status: (job as Record<string, unknown>).docs_knowledge_status ?? null,
        count: (job as Record<string, unknown>).docs_knowledge_count ?? 0,
      },
    })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Manual trigger: Build knowledge from docs ──
indexingRouter.post('/:id/knowledge/build-from-docs', async (c) => {
  const projectId = c.req.param('id')

  try {
    const project = db.prepare(
      'SELECT id, git_repo_url FROM projects WHERE id = ?'
    ).get(projectId) as { id: string; git_repo_url: string | null } | undefined

    if (!project?.git_repo_url) {
      return c.json({ success: false, error: 'No git repository URL configured' }, 400)
    }

    const repoDir = join(REPOS_DIR, projectId)
    if (!existsSync(repoDir)) {
      return c.json({ success: false, error: 'Repository not cloned yet. Run indexing first.' }, 400)
    }

    // Run synchronously (API waits for completion)
    const result = await buildKnowledgeFromDocs(projectId, `manual-${Date.now()}`, repoDir)

    return c.json({
      success: true,
      docsFound: result.docsFound,
      docsProcessed: result.docsProcessed,
      chunksCreated: result.chunksCreated,
      errors: result.errors,
    })
  } catch (error) {
    return c.json({ success: false, error: String(error).slice(0, 300) }, 500)
  }
})
