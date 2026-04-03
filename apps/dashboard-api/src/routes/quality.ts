import { Hono } from 'hono'
import { db } from '../db/client.js'
import {
  calculateFromVerificationResults,
  scoreToGrade,
  approximateDimensionsFromTotal,
  assessPlanQuality,
  type VerificationResults,
  type Grade,
  type PlanInput,
} from '@cortex/shared-types'

export const qualityRouter = new Hono()

// ── Server-side session validation ──
// Warns (but doesn't block) if agent hasn't started a session.
// This provides enforcement for IDEs that don't support hooks (Cursor, Windsurf, etc.)
function validateSession(agentId: string, sessionId?: string): { valid: boolean; warning?: string } {
  if (sessionId) {
    // Verify session exists and is active
    const session = db.prepare(
      "SELECT id, status FROM session_handoffs WHERE id = ? AND status = 'active'"
    ).get(sessionId) as { id: string; status: string } | undefined

    if (!session) {
      return { valid: true, warning: `Session ${sessionId} not found or not active. Call cortex_session_start first.` }
    }
    return { valid: true }
  }

  // No session_id provided — check if agent has ANY active session
  const anySession = db.prepare(
    "SELECT id FROM session_handoffs WHERE from_agent = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1"
  ).get(agentId) as { id: string } | undefined

  if (!anySession) {
    return { valid: true, warning: `No active session for agent "${agentId}". Call cortex_session_start before submitting reports.` }
  }

  return { valid: true }
}

// ── POST /report — Submit a quality gate report ──
// Accepts both legacy format and new 4-dimension format
qualityRouter.post('/report', async (c) => {
  try {
    const body = await c.req.json()
    const {
      gate_name,
      agent_id,
      session_id,
      project_id,
      passed,
      score,
      details,
      results, // VerificationResults (new format)
    } = body

    if (!gate_name) return c.json({ error: 'gate_name is required' }, 400)

    // Identity resolution: keep agent_id from self-report, track API key name separately
    const apiKeyName = c.req.header('X-API-Key-Owner') || null
    const agentId = agent_id || 'unknown'

    // Server-side enforcement: validate session
    const sessionCheck = validateSession(agentId, session_id)

    const reportId = `qr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`

    let scoreBuild = 0
    let scoreRegression = 0
    let scoreStandards = 0
    let scoreTraceability = 0
    let scoreTotal = 0
    let grade: Grade = 'F'
    let reportPassed = false

    if (results) {
      // New format: auto-calculate from verification results
      const calculated = calculateFromVerificationResults(results as VerificationResults)
      scoreBuild = calculated.dimensions.build
      scoreRegression = calculated.dimensions.regression
      scoreStandards = calculated.dimensions.standards
      scoreTraceability = calculated.dimensions.traceability
      scoreTotal = calculated.total
      grade = calculated.grade
      reportPassed = calculated.passed
    } else if (score !== undefined && score !== null) {
      // Legacy format: approximate dimensions from single score
      const dims = approximateDimensionsFromTotal(Number(score))
      scoreBuild = dims.build
      scoreRegression = dims.regression
      scoreStandards = dims.standards
      scoreTraceability = dims.traceability
      scoreTotal = Number(score)
      grade = scoreToGrade(scoreTotal)
      reportPassed = passed ?? grade !== 'F'
    } else {
      // Minimal format: just passed/failed
      scoreTotal = passed ? 100 : 0
      grade = passed ? 'A' : 'F'
      reportPassed = !!passed
      if (passed) {
        scoreBuild = 25
        scoreRegression = 25
        scoreStandards = 25
        scoreTraceability = 25
      }
    }

    // Ensure api_key_name column exists (safe migration)
    try { db.exec('ALTER TABLE quality_reports ADD COLUMN api_key_name TEXT') } catch { /* already exists */ }

    const stmt = db.prepare(`
      INSERT INTO quality_reports (id, project_id, agent_id, session_id, gate_name,
        score_build, score_regression, score_standards, score_traceability,
        score_total, grade, passed, details, api_key_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      reportId, project_id || null, agentId, session_id || null, gate_name,
      scoreBuild, scoreRegression, scoreStandards, scoreTraceability,
      scoreTotal, grade, reportPassed ? 1 : 0,
      details ? (typeof details === 'string' ? details : JSON.stringify(details)) : null,
      apiKeyName
    )

    // Also log to query_logs for backward compatibility
    const logStmt = db.prepare('INSERT INTO query_logs (agent_id, tool, params, status) VALUES (?, ?, ?, ?)')
    logStmt.run(agentId, gate_name, JSON.stringify({ score: scoreTotal, grade, details }), reportPassed ? 'ok' : 'error')

    return c.json({
      success: true,
      ...(sessionCheck.warning ? { warning: sessionCheck.warning } : {}),
      report: {
        id: reportId,
        gate_name,
        score_build: scoreBuild,
        score_regression: scoreRegression,
        score_standards: scoreStandards,
        score_traceability: scoreTraceability,
        score_total: scoreTotal,
        grade,
        passed: reportPassed,
      },
    })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── GET /reports — List quality reports with filters + pagination ──
qualityRouter.get('/reports', (c) => {
  try {
    const page = Math.max(1, Number(c.req.query('page') || '1'))
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') || '20')))
    const offset = (page - 1) * limit
    const projectId = c.req.query('project_id')
    const agentId = c.req.query('agent_id')
    const grade = c.req.query('grade')

    let where = 'WHERE 1=1'
    const params: unknown[] = []

    if (projectId) {
      where += ' AND project_id = ?'
      params.push(projectId)
    }
    if (agentId) {
      where += ' AND agent_id = ?'
      params.push(agentId)
    }
    if (grade) {
      where += ' AND grade = ?'
      params.push(grade)
    }

    const total = (db.prepare(`SELECT COUNT(*) as count FROM quality_reports ${where}`).get(...params) as { count: number }).count
    const reports = db.prepare(
      `SELECT * FROM quality_reports ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset)

    return c.json({
      reports,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── GET /reports/latest — Most recent report (or per project) ──
qualityRouter.get('/reports/latest', (c) => {
  try {
    const projectId = c.req.query('project_id')

    if (projectId) {
      const report = db.prepare(
        'SELECT * FROM quality_reports WHERE project_id = ? ORDER BY created_at DESC LIMIT 1'
      ).get(projectId)
      return c.json({ report: report || null })
    }

    const report = db.prepare(
      'SELECT * FROM quality_reports ORDER BY created_at DESC LIMIT 1'
    ).get()
    return c.json({ report: report || null })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── GET /trends — Quality score trend over time ──
qualityRouter.get('/trends', (c) => {
  try {
    const days = Number(c.req.query('days') || '30')
    const projectId = c.req.query('project_id')

    let sql = `
      SELECT
        date(created_at) as date,
        ROUND(AVG(score_total), 1) as avg_score,
        ROUND(AVG(score_build), 1) as avg_build,
        ROUND(AVG(score_regression), 1) as avg_regression,
        ROUND(AVG(score_standards), 1) as avg_standards,
        ROUND(AVG(score_traceability), 1) as avg_traceability,
        COUNT(*) as report_count,
        MIN(grade) as worst_grade,
        MAX(grade) as best_grade
      FROM quality_reports
      WHERE created_at >= datetime('now', '-' || ? || ' days')
    `
    const params: unknown[] = [days]

    if (projectId) {
      sql += ' AND project_id = ?'
      params.push(projectId)
    }

    sql += ' GROUP BY date(created_at) ORDER BY date ASC'

    const trends = db.prepare(sql).all(...params)
    return c.json({ trends, days })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── GET /summary — Aggregated quality summary ──
qualityRouter.get('/summary', (c) => {
  try {
    const summary = db.prepare(`
      SELECT
        COUNT(*) as total_reports,
        ROUND(AVG(score_total), 1) as avg_score,
        ROUND(AVG(score_build), 1) as avg_build,
        ROUND(AVG(score_regression), 1) as avg_regression,
        ROUND(AVG(score_standards), 1) as avg_standards,
        ROUND(AVG(score_traceability), 1) as avg_traceability,
        SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) as passed_count,
        SUM(CASE WHEN passed = 0 THEN 1 ELSE 0 END) as failed_count,
        SUM(CASE WHEN grade = 'A' THEN 1 ELSE 0 END) as grade_a,
        SUM(CASE WHEN grade = 'B' THEN 1 ELSE 0 END) as grade_b,
        SUM(CASE WHEN grade = 'C' THEN 1 ELSE 0 END) as grade_c,
        SUM(CASE WHEN grade = 'D' THEN 1 ELSE 0 END) as grade_d,
        SUM(CASE WHEN grade = 'F' THEN 1 ELSE 0 END) as grade_f
      FROM quality_reports
    `).get()

    const latest = db.prepare(
      'SELECT * FROM quality_reports ORDER BY created_at DESC LIMIT 1'
    ).get()

    return c.json({ summary, latest })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── POST /plan-quality — Assess plan quality (8 criteria, threshold >= 8.0) ──
qualityRouter.post('/plan-quality', async (c) => {
  try {
    const body = await c.req.json() as PlanInput
    if (!body.plan) return c.json({ error: 'plan is required' }, 400)
    if (!body.request) return c.json({ error: 'request is required' }, 400)

    const result = assessPlanQuality(body)
    return c.json({ result })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── GET /logs — Backward compatible (reads from query_logs) with pagination ──
qualityRouter.get('/logs', (c) => {
  try {
    const page = Math.max(1, Number(c.req.query('page') || '1'))
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') || '20')))
    const offset = (page - 1) * limit

    const total = (db.prepare('SELECT COUNT(*) as count FROM query_logs').get() as { count: number }).count
    const logs = db.prepare('SELECT * FROM query_logs ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset)

    return c.json({
      logs,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Sessions Router (unchanged) ──
export const sessionsRouter = new Hono()

sessionsRouter.post('/start', async (c) => {
  try {
    const body = await c.req.json()
    const { repo, mode, agentId: bodyAgentId, hostname, os, ide, branch, capabilities, role } = body

    // Identity resolution: keep self-reported agentId, API key name tracked separately
    const agentId = bodyAgentId
    const apiKeyName = c.req.header('X-API-Key-Owner') || null

    // Safe migration: add api_key_name column if not exists
    try {
      db.exec("ALTER TABLE session_handoffs ADD COLUMN api_key_name TEXT")
    } catch { /* column already exists */ }

    if (!agentId) {
      return c.json({ error: 'agentId is required. Identify your agent (e.g., "claude-code", "antigravity", "cursor").' }, 400)
    }

    const normalizedRepo = repo
      ? repo.replace(/\.git$/, '').replace(/\/$/, '')
      : 'unknown'

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

    let sessionId: string
    const existingSession = db.prepare(
      `SELECT id FROM session_handoffs
       WHERE from_agent = ? AND project IN (?, ?, ?, ?) AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`
    ).get(
      agentId,
      normalizedRepo,
      `${normalizedRepo}.git`,
      `${normalizedRepo}/`,
      repo ?? 'unknown'
    ) as { id: string } | undefined

    if (existingSession) {
      sessionId = existingSession.id
      db.prepare(
        `UPDATE session_handoffs SET created_at = datetime('now') WHERE id = ?`
      ).run(sessionId)
    } else {
      sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    }

    // Recent quality — now reads from quality_reports first, falls back to query_logs
    let recentQuality = db.prepare(
      'SELECT gate_name as tool, grade, score_total, passed, created_at FROM quality_reports ORDER BY created_at DESC LIMIT 5'
    ).all()
    if (recentQuality.length === 0) {
      recentQuality = db.prepare(
        'SELECT tool, status, created_at FROM query_logs ORDER BY created_at DESC LIMIT 5'
      ).all()
    }

    const recentStmt = db.prepare('SELECT id, task_summary, created_at FROM session_handoffs ORDER BY created_at DESC LIMIT 3')
    const recentSessions = recentStmt.all()

    const projectName = (project?.name as string) ?? 'Unknown Project'
    const projectDesc = (project?.description as string) ?? ''
    const orgId = (project?.org_id as string) ?? ''

    // Resolve project display name: use DB project name if found, otherwise extract from repo URL
    const resolvedProject = projectName !== 'Unknown Project'
      ? projectName
      : normalizedRepo !== 'unknown'
        ? normalizedRepo.split('/').pop() ?? normalizedRepo
        : 'unknown'

    if (!existingSession) {
      const insertStmt = db.prepare(
        'INSERT INTO session_handoffs (id, from_agent, project, task_summary, context, status, api_key_name, hostname, os, ide, branch, capabilities, role, last_activity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime(\'now\'))'
      )
      insertStmt.run(
        sessionId,
        agentId,
        resolvedProject,
        `Session started: mode=${mode ?? 'development'}`,
        JSON.stringify({ repo, mode, agentId, projectId: project?.id }),
        'active',
        apiKeyName,
        hostname ?? null,
        os ?? null,
        ide ?? null,
        branch ?? null,
        JSON.stringify(capabilities ?? []),
        role ?? null
      )
    }

    return c.json({
      sessionId,
      status: 'active',
      mode: mode ?? 'development',
      identity: { agentId, hostname, os, ide, branch, capabilities, role },
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
    // Auto-close stale sessions: mark "active" sessions older than 2 hours as "completed"
    db.prepare(
      `UPDATE session_handoffs
       SET status = 'completed',
           task_summary = task_summary || ' [auto-closed: stale >2h]'
       WHERE status = 'active'
         AND created_at <= datetime('now', '-2 hours')`
    ).run()

    const limit = Number(c.req.query('limit') || '50')
    const status = c.req.query('status')
    const stmt = status
      ? db.prepare('SELECT * FROM session_handoffs WHERE status = ? ORDER BY created_at DESC LIMIT ?')
      : db.prepare('SELECT * FROM session_handoffs ORDER BY created_at DESC LIMIT ?')
    const rawSessions = (status ? stmt.all(status, limit) : stmt.all(limit)) as Array<Record<string, unknown>>

    // Enrich each session with token savings from query_logs
    const sessionsWithSavings = rawSessions.map((session) => {
      try {
        const agentId = session.from_agent as string
        const sessionCreatedAt = session.created_at as string
        // For completed sessions, look at tool calls made by same agent within a 4-hour window
        // For active sessions, look from session start to now
        const savings = db.prepare(`
          SELECT COUNT(*) as tool_calls,
                 COALESCE(SUM(output_size), 0) as output_bytes,
                 COALESCE(SUM(input_size), 0) + COALESCE(SUM(output_size), 0) as data_bytes
          FROM query_logs
          WHERE agent_id = ? AND created_at >= ? AND created_at <= datetime(?, '+4 hours')
            AND status = 'ok'
        `).get(agentId, sessionCreatedAt, sessionCreatedAt) as {
          tool_calls: number; output_bytes: number; data_bytes: number
        }

        return {
          ...session,
          savings: {
            toolCalls: savings.tool_calls,
            tokensSaved: Math.round(savings.output_bytes / 4),
            dataBytes: savings.data_bytes,
          },
        }
      } catch {
        return { ...session, savings: { toolCalls: 0, tokensSaved: 0, dataBytes: 0 } }
      }
    })

    return c.json({ sessions: sessionsWithSavings })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

sessionsRouter.post('/:id/end', async (c) => {
  const { id } = c.req.param()
  try {
    const body = await c.req.json().catch(() => ({}))
    const { summary } = body as { summary?: string }

    const existing = db.prepare('SELECT id, status, created_at FROM session_handoffs WHERE id = ?').get(id) as
      { id: string; status: string; created_at: string } | undefined
    if (!existing) return c.json({ error: 'Session not found' }, 404)

    const durationMs = existing.created_at
      ? Date.now() - new Date(existing.created_at).getTime()
      : null

    db.prepare(
      `UPDATE session_handoffs
       SET status = 'completed', task_summary = COALESCE(?, task_summary)
       WHERE id = ?`
    ).run(summary ?? null, id)

    return c.json({
      success: true,
      session: {
        id,
        status: 'completed',
        duration: durationMs ? Math.round(durationMs / 1000) : null,
      },
    })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

sessionsRouter.patch('/:id/complete', async (c) => {
  const { id } = c.req.param()
  try {
    const body = await c.req.json().catch(() => ({}))
    const { task_summary, status } = body as { task_summary?: string; status?: string }

    const existing = db.prepare('SELECT id FROM session_handoffs WHERE id = ?').get(id)
    if (!existing) return c.json({ error: 'Session not found' }, 404)

    // Get session details before closing (for recipe capture)
    const session = db.prepare('SELECT from_agent, project_id, project FROM session_handoffs WHERE id = ?')
      .get(id) as { from_agent: string; project_id: string | null; project: string } | undefined

    db.prepare(
      `UPDATE session_handoffs
       SET status = ?, task_summary = COALESCE(?, task_summary)
       WHERE id = ?`
    ).run(status ?? 'completed', task_summary ?? null, id)

    // Fire-and-forget recipe capture from session summary (OpenSpace-inspired)
    if (task_summary && task_summary.length > 50 && session) {
      import('../services/recipe-capture.js').then(({ captureFromSession }) =>
        captureFromSession({
          sessionId: id,
          summary: task_summary,
          agentId: session.from_agent,
          projectId: session.project_id,
        }).catch(e =>
          console.warn('[recipe-capture] Session capture error:', (e as Error).message)
        )
      ).catch(() => { /* module load failure — non-critical */ })
    }

    return c.json({ success: true, id, status: status ?? 'completed' })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

sessionsRouter.delete('/:id', (c) => {
  const { id } = c.req.param()
  try {
    db.prepare('DELETE FROM session_handoffs WHERE id = ?').run(id)
    return c.json({ success: true })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})
