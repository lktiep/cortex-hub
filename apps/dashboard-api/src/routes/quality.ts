import { Hono } from 'hono'
import { db } from '../db/client.js'

export const qualityRouter = new Hono()

qualityRouter.post('/report', async (c) => {
  try {
    const body = await c.req.json()
    const { gate_name, passed, score, details } = body
    
    if (!gate_name) return c.json({ error: 'Gate name is required' }, 400)

    const stmt = db.prepare('INSERT INTO query_logs (agent_id, tool, params, status) VALUES (?, ?, ?, ?)')
    stmt.run('agent_test', gate_name, JSON.stringify({ score, details }), passed ? 'ok' : 'error')

    return c.json({ success: true, logged: true })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

qualityRouter.get('/logs', (c) => {
  try {
    const limit = Number(c.req.query('limit') || '50')
    const stmt = db.prepare('SELECT * FROM query_logs ORDER BY created_at DESC LIMIT ?')
    const logs = stmt.all(limit)
    return c.json({ logs })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

export const sessionsRouter = new Hono()

/**
 * POST /start — Create a real session record
 * Body: { repo, mode?, agentId? }
 * Returns: session context with project info, standards, recent quality
 */
sessionsRouter.post('/start', async (c) => {
  try {
    const body = await c.req.json()
    const { repo, mode, agentId } = body

    // Normalize repo URL: strip .git suffix and trailing slash for consistent matching
    const normalizedRepo = repo
      ? repo.replace(/\.git$/, '').replace(/\/$/, '')
      : 'unknown'

    // Look up project by git_repo_url (handle .git suffix and trailing slash variants)
    let project: Record<string, unknown> | undefined
    if (repo) {
      const stmt = db.prepare(
        `SELECT * FROM projects
         WHERE git_repo_url IN (?, ?, ?, ?)`
      )
      project = stmt.get(
        normalizedRepo,
        `${normalizedRepo}.git`,
        `${normalizedRepo}/`,
        repo
      ) as Record<string, unknown> | undefined
    }

    // Reuse existing active session for same agent+repo (prevent garbage sessions)
    // Match normalized URL to handle .git suffix inconsistency
    let sessionId: string
    const existingSession = db.prepare(
      `SELECT id FROM session_handoffs
       WHERE from_agent = ? AND project IN (?, ?, ?, ?) AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`
    ).get(
      agentId ?? 'default',
      normalizedRepo,
      `${normalizedRepo}.git`,
      `${normalizedRepo}/`,
      repo ?? 'unknown'
    ) as { id: string } | undefined

    if (existingSession) {
      sessionId = existingSession.id
      // Touch the session — update timestamp
      db.prepare(
        `UPDATE session_handoffs SET created_at = datetime('now') WHERE id = ?`
      ).run(sessionId)
    } else {
      sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    }

    // Get recent quality logs (last 5)
    const qualityStmt = db.prepare('SELECT tool, status, created_at FROM query_logs ORDER BY created_at DESC LIMIT 5')
    const recentQuality = qualityStmt.all()

    // Get recent sessions (last 3) for context continuity
    const recentStmt = db.prepare('SELECT id, task_summary, created_at FROM session_handoffs ORDER BY created_at DESC LIMIT 3')
    const recentSessions = recentStmt.all()

    // Build mission brief from project data or defaults
    const projectName = (project?.name as string) ?? 'Unknown Project'
    const projectDesc = (project?.description as string) ?? ''
    const orgId = (project?.org_id as string) ?? ''

    // Store session record (only if new)
    if (!existingSession) {
      const insertStmt = db.prepare(
        'INSERT INTO session_handoffs (id, from_agent, project, task_summary, context, status) VALUES (?, ?, ?, ?, ?, ?)'
      )
      insertStmt.run(
        sessionId,
        agentId ?? 'default',
        normalizedRepo,
        `Session started: mode=${mode ?? 'development'}`,
        JSON.stringify({ repo, mode, agentId, projectId: project?.id }),
        'active'
      )
    }

    return c.json({
      sessionId,
      status: 'active',
      mode: mode ?? 'development',
      project: project ? {
        id: project.id,
        name: projectName,
        description: projectDesc,
        orgId,
        repo: project.git_repo_url,
        indexedAt: project.indexed_at,
        indexedSymbols: project.indexed_symbols,
      } : null,
      standards: [
        'SOLID Principles',
        'Clean Architecture',
        'Phase Gate Enforcement (build, typecheck, lint must pass)',
      ],
      recentQuality,
      recentSessions,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

sessionsRouter.get('/all', (c) => {
  try {
    const limit = Number(c.req.query('limit') || '50')
    const status = c.req.query('status') // optional filter: active, completed
    const stmt = status
      ? db.prepare('SELECT * FROM session_handoffs WHERE status = ? ORDER BY created_at DESC LIMIT ?')
      : db.prepare('SELECT * FROM session_handoffs ORDER BY created_at DESC LIMIT ?')
    const sessions = status ? stmt.all(status, limit) : stmt.all(limit)
    return c.json({ sessions })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

/**
 * PATCH /:id/complete — Close/complete a session
 * Body: { task_summary?, status? }
 */
sessionsRouter.patch('/:id/complete', async (c) => {
  const { id } = c.req.param()
  try {
    const body = await c.req.json().catch(() => ({}))
    const { task_summary, status } = body as { task_summary?: string; status?: string }

    const existing = db.prepare('SELECT id FROM session_handoffs WHERE id = ?').get(id)
    if (!existing) return c.json({ error: 'Session not found' }, 404)

    db.prepare(
      `UPDATE session_handoffs 
       SET status = ?, task_summary = COALESCE(?, task_summary)
       WHERE id = ?`
    ).run(status ?? 'completed', task_summary ?? null, id)

    return c.json({ success: true, id, status: status ?? 'completed' })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

/**
 * DELETE /:id — Remove a session record
 */
sessionsRouter.delete('/:id', (c) => {
  const { id } = c.req.param()
  try {
    db.prepare('DELETE FROM session_handoffs WHERE id = ?').run(id)
    return c.json({ success: true })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

