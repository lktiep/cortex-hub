import { Hono } from 'hono'
import { db } from '../db/client.js'

export const statsRouter = new Hono()

const QDRANT_URL = () => process.env['QDRANT_URL'] || 'http://qdrant:6333'


// ── Dashboard Stats (real data) ──
statsRouter.get('/overview', async (c) => {
  try {
    const keyCount = (db.prepare('SELECT COUNT(*) as count FROM api_keys').get() as { count: number }).count
    const agentCount = (db.prepare('SELECT COUNT(DISTINCT agent_id) as count FROM query_logs').get() as { count: number }).count
    const totalQueries = (db.prepare('SELECT COUNT(*) as count FROM query_logs').get() as { count: number }).count
    const totalSessions = (db.prepare('SELECT COUNT(*) as count FROM session_handoffs').get() as { count: number }).count
    const orgCount = (db.prepare('SELECT COUNT(*) as count FROM organizations').get() as { count: number }).count
    const projectCount = (db.prepare('SELECT COUNT(*) as count FROM projects').get() as { count: number }).count

    // Memory nodes from Qdrant
    let memoryNodes = 0
    try {
      const res = await fetch(`${QDRANT_URL()}/collections`, { signal: AbortSignal.timeout(3000) })
      if (res.ok) {
        const data = (await res.json()) as { result?: { collections?: { name: string }[] } }
        const collections = data.result?.collections ?? []
        // Sum point counts across all collections
        for (const col of collections) {
          try {
            const colRes = await fetch(`${QDRANT_URL()}/collections/${col.name}`, { signal: AbortSignal.timeout(2000) })
            if (colRes.ok) {
              const colData = (await colRes.json()) as { result?: { points_count?: number } }
              memoryNodes += colData.result?.points_count ?? 0
            }
          } catch { /* skip */ }
        }
      }
    } catch { /* qdrant offline */ }

    // Today's stats
    const today = new Date().toISOString().split('T')[0]
    const todayQueries = (db.prepare("SELECT COUNT(*) as count FROM query_logs WHERE created_at >= ?").get(`${today}T00:00:00`) as { count: number }).count
    const todayTokens = (db.prepare("SELECT COALESCE(SUM(total_tokens), 0) as total FROM usage_logs WHERE created_at >= ?").get(`${today}T00:00:00`) as { total: number }).total

    return c.json({
      activeKeys: keyCount,
      totalAgents: agentCount,
      memoryNodes,
      uptime: Math.floor(process.uptime()),
      totalQueries,
      totalSessions,
      organizations: orgCount,
      projects: projectCount,
      today: { queries: todayQueries, tokens: todayTokens },
    })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Enriched Overview (v2) — single call for dashboard ──
statsRouter.get('/overview-v2', async (c) => {
  try {
    // ── Basic counts ──
    const keyCount = (db.prepare('SELECT COUNT(*) as count FROM api_keys').get() as { count: number }).count
    const agentCount = (db.prepare('SELECT COUNT(DISTINCT agent_id) as count FROM query_logs').get() as { count: number }).count
    const totalQueries = (db.prepare('SELECT COUNT(*) as count FROM query_logs').get() as { count: number }).count
    const totalSessions = (db.prepare('SELECT COUNT(*) as count FROM session_handoffs').get() as { count: number }).count
    const orgCount = (db.prepare('SELECT COUNT(*) as count FROM organizations').get() as { count: number }).count
    const today = new Date().toISOString().split('T')[0]
    const todayStart = `${today} 00:00:00`  // SQLite uses space, not T
    const todayQueries = (db.prepare("SELECT COUNT(*) as count FROM query_logs WHERE created_at >= ?").get(todayStart) as { count: number }).count
    const todayTokens = (db.prepare("SELECT COALESCE(SUM(total_tokens), 0) as total FROM usage_logs WHERE created_at >= ?").get(todayStart) as { total: number }).total

    // ── Memory nodes from Qdrant ──
    let memoryNodes = 0
    try {
      const res = await fetch(`${QDRANT_URL()}/collections`, { signal: AbortSignal.timeout(3000) })
      if (res.ok) {
        const data = (await res.json()) as { result?: { collections?: { name: string }[] } }
        const collections = data.result?.collections ?? []
        for (const col of collections) {
          try {
            const colRes = await fetch(`${QDRANT_URL()}/collections/${col.name}`, { signal: AbortSignal.timeout(2000) })
            if (colRes.ok) {
              const colData = (await colRes.json()) as { result?: { points_count?: number } }
              memoryNodes += colData.result?.points_count ?? 0
            }
          } catch { /* skip */ }
        }
      }
    } catch { /* qdrant offline */ }

    // ── Per-project summaries with index/mem9 status ──
    const projects = db.prepare(`
      SELECT p.id, p.name, p.slug, p.git_provider, p.git_repo_url,
             p.indexed_symbols, p.indexed_at, p.created_at
      FROM projects p ORDER BY p.created_at DESC
    `).all() as Array<{
      id: string; name: string; slug: string; git_provider: string | null
      git_repo_url: string | null; indexed_symbols: number | null
      indexed_at: string | null; created_at: string
    }>

    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    const projectSummaries = projects.map((p) => {
      // Latest indexing job
      const job = db.prepare(`
        SELECT id, branch, status, mem9_status, mem9_chunks,
               symbols_found, total_files, completed_at, created_at as started_at
        FROM index_jobs WHERE project_id = ? ORDER BY completed_at DESC, created_at DESC LIMIT 1
      `).get(p.id) as {
        id: string; branch: string; status: string; mem9_status: string | null
        mem9_chunks: number | null; symbols_found: number | null
        total_files: number | null; completed_at: string | null; started_at: string
      } | undefined

      // Weekly query count
      const weeklyQueries = (db.prepare(
        'SELECT COUNT(*) as count FROM query_logs WHERE project_id = ? AND created_at >= ?'
      ).get(p.id, weekAgo) as { count: number }).count

      // Active sessions
      const activeSessions = (db.prepare(
        "SELECT COUNT(*) as count FROM session_handoffs WHERE project_id = ? AND status = 'active'"
      ).get(p.id) as { count: number }).count

      // Knowledge documents for this project
      // Note: buildKnowledgeFromDocs normalizes project_id to slug, so we query by both ID and slug
      let knowledgeDocs = 0
      let knowledgeChunks = 0
      try {
        const kStats = db.prepare(
          "SELECT COUNT(*) as docs, COALESCE(SUM(chunk_count), 0) as chunks FROM knowledge_documents WHERE (project_id = ? OR project_id = ?) AND status = 'active'"
        ).get(p.id, p.slug.toLowerCase()) as { docs: number; chunks: number }
        knowledgeDocs = kStats.docs
        knowledgeChunks = kStats.chunks
      } catch { /* knowledge table may not exist yet */ }

      return {
        id: p.id,
        name: p.name,
        slug: p.slug,
        gitProvider: p.git_provider,
        gitRepoUrl: p.git_repo_url,
        gitnexus: job ? {
          status: job.status,
          symbols: job.symbols_found ?? p.indexed_symbols ?? 0,
          files: job.total_files ?? 0,
          branch: job.branch,
          completedAt: job.completed_at,
        } : { status: 'none', symbols: 0, files: 0, branch: null, completedAt: null },
        mem9: job ? {
          status: job.mem9_status ?? 'pending',
          chunks: job.mem9_chunks ?? 0,
        } : { status: 'none', chunks: 0 },
        knowledge: {
          docs: knowledgeDocs,
          chunks: knowledgeChunks,
        },
        weeklyQueries,
        activeSessions,
        createdAt: p.created_at,
      }
    })

    // ── Quality summary ──
    const lastReport = db.prepare(
      'SELECT grade, score_total, created_at FROM quality_reports ORDER BY created_at DESC LIMIT 1'
    ).get() as { grade: string; score_total: number; created_at: string } | undefined

    const reportsToday = (db.prepare(
      "SELECT COUNT(*) as count FROM quality_reports WHERE created_at >= ?"
    ).get(todayStart) as { count: number }).count

    const avgScore = (db.prepare(
      'SELECT AVG(score_total) as avg FROM quality_reports'
    ).get() as { avg: number | null }).avg ?? 0

    // ── Knowledge stats ──
    let knowledgeStats = { totalDocs: 0, totalChunks: 0, totalHits: 0 }
    try {
      const kDocs = (db.prepare('SELECT COUNT(*) as count FROM knowledge_documents').get() as { count: number }).count
      const kChunks = (db.prepare('SELECT COALESCE(SUM(chunk_count), 0) as total FROM knowledge_documents').get() as { total: number }).total
      const kHits = (db.prepare('SELECT COALESCE(SUM(hit_count), 0) as total FROM knowledge_documents').get() as { total: number }).total
      knowledgeStats = { totalDocs: kDocs, totalChunks: kChunks, totalHits: kHits }
    } catch (e) { console.warn('[overview-v2] knowledge stats error:', e) }

    return c.json({
      activeKeys: keyCount,
      totalAgents: agentCount,
      memoryNodes,
      uptime: Math.floor(process.uptime()),
      totalQueries,
      totalSessions,
      organizations: orgCount,
      today: { queries: todayQueries, tokens: todayTokens },
      projects: projectSummaries,
      quality: {
        lastGrade: lastReport?.grade ?? 'N/A',
        lastScore: lastReport?.score_total ?? 0,
        reportsToday,
        averageScore: Math.round(avgScore),
      },
      knowledge: knowledgeStats,
    })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Activity Feed (recent events) ──
statsRouter.get('/activity', (c) => {
  const limit = Number(c.req.query('limit') ?? 30)

  try {
    // Combine query_logs+session_handoffs into a unified activity feed
    const queryLogs = db.prepare(`
      SELECT 'query' as type, agent_id, tool as detail, status, latency_ms, created_at
      FROM query_logs ORDER BY created_at DESC LIMIT ?
    `).all(limit) as { type: string; agent_id: string; detail: string; status: string; latency_ms: number | null; created_at: string }[]

    const sessions = db.prepare(`
      SELECT 'session' as type, from_agent as agent_id, task_summary as detail, status, 0 as latency_ms, created_at
      FROM session_handoffs ORDER BY created_at DESC LIMIT ?
    `).all(limit) as { type: string; agent_id: string; detail: string; status: string; latency_ms: number | null; created_at: string }[]

    // Merge and sort by time
    const activity = [...queryLogs, ...sessions]
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
      .slice(0, limit)

    return c.json({ activity })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Budget (get/set token limits) ──
statsRouter.get('/budget', (c) => {
  try {
    // Create budget table if not exists
    db.exec(`CREATE TABLE IF NOT EXISTS budget_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      daily_limit INTEGER DEFAULT 0,
      monthly_limit INTEGER DEFAULT 0,
      alert_threshold REAL DEFAULT 0.8,
      updated_at TEXT DEFAULT (datetime('now'))
    )`)
    db.exec(`INSERT OR IGNORE INTO budget_settings (id) VALUES (1)`)

    const budget = db.prepare('SELECT * FROM budget_settings WHERE id = 1').get() as {
      daily_limit: number; monthly_limit: number; alert_threshold: number
    }

    // Current usage
    const today = new Date().toISOString().split('T')[0]
    const monthStart = today?.substring(0, 7) + '-01'
    const dailyUsed = (db.prepare("SELECT COALESCE(SUM(total_tokens), 0) as total FROM usage_logs WHERE created_at >= ?").get(`${today}T00:00:00`) as { total: number }).total
    const monthlyUsed = (db.prepare("SELECT COALESCE(SUM(total_tokens), 0) as total FROM usage_logs WHERE created_at >= ?").get(`${monthStart}T00:00:00`) as { total: number }).total

    return c.json({
      ...budget,
      dailyUsed,
      monthlyUsed,
      dailyAlert: budget.daily_limit > 0 && dailyUsed >= budget.daily_limit * budget.alert_threshold,
      monthlyAlert: budget.monthly_limit > 0 && monthlyUsed >= budget.monthly_limit * budget.alert_threshold,
    })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

statsRouter.post('/budget', async (c) => {
  try {
    const body = await c.req.json()
    const { dailyLimit, monthlyLimit, alertThreshold } = body

    db.exec(`CREATE TABLE IF NOT EXISTS budget_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      daily_limit INTEGER DEFAULT 0,
      monthly_limit INTEGER DEFAULT 0,
      alert_threshold REAL DEFAULT 0.8,
      updated_at TEXT DEFAULT (datetime('now'))
    )`)
    db.exec(`INSERT OR IGNORE INTO budget_settings (id) VALUES (1)`)

    db.prepare(`UPDATE budget_settings SET 
      daily_limit = ?, monthly_limit = ?, alert_threshold = ?, updated_at = datetime('now')
      WHERE id = 1
    `).run(dailyLimit ?? 0, monthlyLimit ?? 0, alertThreshold ?? 0.8)

    return c.json({ success: true })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Admin: Restart Docker service ──
statsRouter.post('/admin/restart/:service', async (c) => {
  const service = c.req.param('service')
  const allowed = ['cortex-llm-proxy', 'cortex-qdrant']

  if (!allowed.includes(service)) {
    return c.json({ error: `Cannot restart "${service}". Allowed: ${allowed.join(', ')}` }, 400)
  }

  try {
    const { exec } = await import('child_process')
    const { promisify } = await import('util')
    const execAsync = promisify(exec)

    await execAsync(`docker restart ${service}`, { timeout: 30000 })
    return c.json({ success: true, service, message: `${service} restarted` })
  } catch (err) {
    return c.json({ error: `Failed to restart ${service}`, details: String(err) }, 500)
  }
})

// ── Telemetry: Log MCP Tool Queries ──
statsRouter.post('/query-log', async (c) => {
  try {
    const { agentId, tool, params, status, latencyMs, error, projectId, inputSize, outputSize } = await c.req.json()
    const stmt = db.prepare('INSERT INTO query_logs (agent_id, tool, params, latency_ms, status, error, project_id, input_size, output_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    stmt.run(
      agentId || 'unknown', 
      tool || 'unknown',
      params ? JSON.stringify(params) : null,
      latencyMs || 0,
      status || 'ok',
      error || null,
      projectId || null,
      inputSize || 0,
      outputSize || 0
    )
    return c.json({ success: true })
  } catch (err) {
    return c.json({ error: String(err) }, 500)
  }
})

// ── Per-Project Analytics ──
statsRouter.get('/projects/:id/analytics', (c) => {
  const projectId = c.req.param('id')

  try {
    const queryCount = (db.prepare('SELECT COUNT(*) as count FROM query_logs WHERE project_id = ?').get(projectId) as { count: number }).count
    const sessionCount = (db.prepare('SELECT COUNT(*) as count FROM session_handoffs WHERE project_id = ?').get(projectId) as { count: number }).count
    const keyCount = (db.prepare('SELECT COUNT(*) as count FROM api_keys WHERE project_id = ?').get(projectId) as { count: number }).count
    const tokenUsage = (db.prepare('SELECT COALESCE(SUM(total_tokens), 0) as total FROM usage_logs WHERE project_id = ?').get(projectId) as { total: number }).total

    // Quality scores for this project
    const avgLatency = (db.prepare('SELECT AVG(latency_ms) as avg FROM query_logs WHERE project_id = ? AND latency_ms IS NOT NULL').get(projectId) as { avg: number | null }).avg ?? 0
    const errorRate = queryCount > 0
      ? (db.prepare("SELECT COUNT(*) as count FROM query_logs WHERE project_id = ? AND status = 'error'").get(projectId) as { count: number }).count / queryCount * 100
      : 0

    // Daily trend (7 days)
    const trend = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const day = d.toISOString().split('T')[0]
      const count = (db.prepare("SELECT COUNT(*) as count FROM query_logs WHERE project_id = ? AND created_at >= ? AND created_at < date(?, '+1 day')").get(projectId, `${day}T00:00:00`, day) as { count: number }).count
      trend.push({ day, count })
    }

    return c.json({
      projectId,
      queries: queryCount,
      sessions: sessionCount,
      apiKeys: keyCount,
      totalTokens: tokenUsage,
      avgLatency: Math.round(avgLatency),
      errorRate: Math.round(errorRate * 10) / 10,
      trend,
    })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Tool Analytics — per-tool metrics for measuring Cortex effectiveness ──
statsRouter.get('/tool-analytics', (c) => {
  const days = Number(c.req.query('days') ?? 7)
  const agentId = c.req.query('agentId')
  const projectId = c.req.query('projectId')

  try {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19)

    // Build WHERE clause dynamically
    const conditions = ['created_at >= ?']
    const params: unknown[] = [since]
    if (agentId) { conditions.push('agent_id = ?'); params.push(agentId) }
    if (projectId) { conditions.push('project_id = ?'); params.push(projectId) }
    const where = conditions.join(' AND ')

    // Per-tool breakdown
    const tools = db.prepare(`
      SELECT 
        tool,
        COUNT(*) as total_calls,
        SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) as success_count,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
        ROUND(AVG(latency_ms)) as avg_latency_ms,
        ROUND(AVG(CASE WHEN input_size > 0 THEN input_size ELSE NULL END)) as avg_input_size,
        ROUND(AVG(CASE WHEN output_size > 0 THEN output_size ELSE NULL END)) as avg_output_size,
        COALESCE(SUM(input_size), 0) as total_input_bytes,
        COALESCE(SUM(output_size), 0) as total_output_bytes
      FROM query_logs
      WHERE ${where}
      GROUP BY tool
      ORDER BY total_calls DESC
    `).all(...params) as Array<{
      tool: string; total_calls: number; success_count: number; error_count: number
      avg_latency_ms: number; avg_input_size: number | null; avg_output_size: number | null
      total_input_bytes: number; total_output_bytes: number
    }>

    // Enrich with success rate and estimated tokens
    const enriched = tools.map(t => ({
      tool: t.tool,
      totalCalls: t.total_calls,
      successRate: Math.round((t.success_count / t.total_calls) * 100 * 10) / 10,
      errorCount: t.error_count,
      avgLatencyMs: t.avg_latency_ms,
      avgInputSize: t.avg_input_size,
      avgOutputSize: t.avg_output_size,
      // Estimate tokens: ~4 chars per token (conservative)
      estimatedTokensSaved: Math.round(t.total_output_bytes / 4),
      totalInputBytes: t.total_input_bytes,
      totalOutputBytes: t.total_output_bytes,
    }))

    // Overall summary
    const totalCalls = enriched.reduce((s, t) => s + t.totalCalls, 0)
    const totalSuccess = enriched.reduce((s, t) => s + Math.round(t.totalCalls * t.successRate / 100), 0)
    const totalOutputBytes = enriched.reduce((s, t) => s + t.totalOutputBytes, 0)
    const totalInputBytes = enriched.reduce((s, t) => s + t.totalInputBytes, 0)

    // Per-agent breakdown
    const agents = db.prepare(`
      SELECT agent_id, COUNT(*) as calls, 
             SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) as successes
      FROM query_logs WHERE ${where}
      GROUP BY agent_id ORDER BY calls DESC
    `).all(...params) as Array<{ agent_id: string; calls: number; successes: number }>

    // Daily trend
    const trend: Array<{ day: string; calls: number; errors: number }> = []
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i)
      const day = d.toISOString().split('T')[0] as string
      const dayConditions = [`created_at >= '${day} 00:00:00'`, `created_at < date('${day}', '+1 day')`]
      if (agentId) dayConditions.push(`agent_id = '${agentId}'`)
      if (projectId) dayConditions.push(`project_id = '${projectId}'`)
      const dayWhere = dayConditions.join(' AND ')
      const dayStat = db.prepare(`SELECT COUNT(*) as calls, SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors FROM query_logs WHERE ${dayWhere}`).get() as { calls: number; errors: number }
      trend.push({ day, calls: dayStat.calls, errors: dayStat.errors ?? 0 })
    }

    return c.json({
      period: { days, since },
      summary: {
        totalCalls,
        overallSuccessRate: totalCalls > 0 ? Math.round((totalSuccess / totalCalls) * 100 * 10) / 10 : 0,
        estimatedTokensSaved: Math.round(totalOutputBytes / 4),
        totalDataBytes: totalInputBytes + totalOutputBytes,
        activeAgents: agents.length,
      },
      tools: enriched,
      agents: agents.map(a => ({
        agentId: a.agent_id,
        totalCalls: a.calls,
        successRate: Math.round((a.successes / a.calls) * 100 * 10) / 10,
      })),
      trend,
    })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Session Compliance Check ──
// Returns which Cortex tools were used/missed in a session, with a compliance score
statsRouter.get('/session-compliance/:sessionId', (c) => {
  const sessionId = c.req.param('sessionId')

  try {
    // Get session info to find agent_id and time range
    const session = db.prepare(
      'SELECT id, from_agent, created_at, status FROM session_handoffs WHERE id = ?'
    ).get(sessionId) as { id: string; from_agent: string; created_at: string; status: string } | undefined

    if (!session) return c.json({ error: 'Session not found' }, 404)

    // Get all tool calls made by this agent since session started
    const toolCalls = db.prepare(`
      SELECT DISTINCT tool FROM query_logs 
      WHERE agent_id = ? AND created_at >= ?
      ORDER BY tool
    `).all(session.from_agent, session.created_at) as Array<{ tool: string }>

    const usedTools = new Set(toolCalls.map(t => t.tool))

    // Define recommended tool categories
    const recommendedTools = {
      discovery: ['cortex_code_search', 'cortex_code_context', 'cortex_cypher'],
      safety: ['cortex_code_impact', 'cortex_detect_changes'],
      learning: ['cortex_knowledge_search', 'cortex_memory_search'],
      contribution: ['cortex_knowledge_store', 'cortex_memory_store'],
      lifecycle: ['cortex_session_start', 'cortex_session_end', 'cortex_quality_report'],
    }

    // Calculate per-category compliance
    const categories = Object.entries(recommendedTools).map(([category, tools]) => {
      const used = tools.filter(t => usedTools.has(t))
      const missing = tools.filter(t => !usedTools.has(t))
      return {
        category,
        used,
        missing,
        score: tools.length > 0 ? Math.round((used.length / tools.length) * 100) : 100,
      }
    })

    // Overall compliance score
    const totalRecommended = Object.values(recommendedTools).flat()
    const totalUsed = totalRecommended.filter(t => usedTools.has(t))
    const overallScore = Math.round((totalUsed.length / totalRecommended.length) * 100)

    // Generate improvement hints
    const hints: string[] = []
    const missingDiscovery = categories.find(c => c.category === 'discovery')?.missing ?? []
    const missingSafety = categories.find(c => c.category === 'safety')?.missing ?? []
    const missingLearning = categories.find(c => c.category === 'learning')?.missing ?? []
    const missingContribution = categories.find(c => c.category === 'contribution')?.missing ?? []

    if (missingDiscovery.length > 0) {
      hints.push(`🔍 Use ${missingDiscovery.join(', ')} BEFORE grep/find for AST-aware search`)
    }
    if (missingSafety.length > 0) {
      hints.push(`🛡️ Use ${missingSafety.join(', ')} before editing core files to check blast radius`)
    }
    if (missingLearning.length > 0) {
      hints.push(`📚 Use ${missingLearning.join(', ')} when encountering errors — someone may have solved it already`)
    }
    if (missingContribution.length > 0) {
      hints.push(`💡 Use ${missingContribution.join(', ')} to share your findings with other agents`)
    }

    return c.json({
      sessionId,
      agent: session.from_agent,
      overallScore,
      grade: overallScore >= 80 ? 'A' : overallScore >= 60 ? 'B' : overallScore >= 40 ? 'C' : 'D',
      toolsUsed: [...usedTools],
      totalUsed: totalUsed.length,
      totalRecommended: totalRecommended.length,
      categories,
      hints,
    })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Cortex Hints Engine ──
// Returns contextual hints based on which tools an agent has/hasn't used recently
statsRouter.get('/hints/:agentId', (c) => {
  const agentId = c.req.param('agentId')
  const currentTool = c.req.query('currentTool')

  try {
    // Get tools used by this agent in the last 2 hours (current session window)
    const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19)
    const recentTools = db.prepare(`
      SELECT DISTINCT tool FROM query_logs 
      WHERE agent_id = ? AND created_at >= ?
    `).all(agentId, since) as Array<{ tool: string }>

    const used = new Set(recentTools.map(t => t.tool))
    const hints: string[] = []

    // Context-aware hints based on current tool and what's missing
    if (!used.has('cortex_session_start')) {
      hints.push('⚠️ Start your session first: cortex_session_start tracks your work and enables compliance.')
    }

    if (currentTool === 'cortex_code_search' || currentTool === 'cortex_cypher' || currentTool === 'cortex_code_context') {
      // Agent is doing code discovery — remind about impact checking
      if (!used.has('cortex_code_impact')) {
        hints.push('🛡️ Before editing, run cortex_code_impact to check blast radius of your changes.')
      }
      // P2: Suggest alternatives when search may fail
      if (currentTool === 'cortex_code_search' && !used.has('cortex_code_context')) {
        hints.push('🔍 If code_search returns empty (repo has 0 flows), try cortex_code_context or cortex_cypher for symbol-level queries.')
      }
      if (currentTool === 'cortex_code_context' && !used.has('cortex_list_repos')) {
        hints.push('📦 If you get "symbol not found", use cortex_list_repos to find the correct projectId for your repository.')
      }
      if (currentTool === 'cortex_cypher') {
        hints.push('💡 Cypher tips: Use labels(n) for type, n.name and n.filePath as properties. Example: MATCH (n) WHERE n.name CONTAINS "X" RETURN n.name, labels(n) LIMIT 20')
      }
    }

    if (currentTool === 'cortex_list_repos') {
      // Agent is discovering repos — suggest next code tools
      hints.push('🔍 Now use the projectId from the list with cortex_code_search, cortex_code_context, or cortex_cypher.')
    }

    if (currentTool === 'cortex_quality_report') {
      // Agent is reporting quality — check if they used discovery/safety tools
      if (!used.has('cortex_code_search') && !used.has('cortex_cypher')) {
        hints.push('🔍 You reported quality without using code search tools. Try cortex_code_search or cortex_cypher next time for better code understanding.')
      }
      if (!used.has('cortex_knowledge_store') && !used.has('cortex_memory_store')) {
        hints.push('💡 Consider using cortex_knowledge_store or cortex_memory_store to share your findings.')
      }
    }

    if (currentTool === 'cortex_session_end') {
      // Session ending — give overall compliance hint
      if (!used.has('cortex_quality_report')) {
        hints.push('📊 You should call cortex_quality_report with build/typecheck/lint results before ending.')
      }
      if (!used.has('cortex_memory_store')) {
        hints.push('🧠 Store what you learned: cortex_memory_store persists insights for your next session.')
      }
    }

    // General hints based on low tool coverage
    const discoveryTools = ['cortex_code_search', 'cortex_code_context', 'cortex_cypher']
    const usedDiscovery = discoveryTools.filter(t => used.has(t)).length
    if (usedDiscovery === 0 && used.size > 2) {
      hints.push('🔍 You haven\'t used any code discovery tools yet. Try cortex_code_search before grep for better results.')
    }

    return c.json({ agentId, hints, toolsUsedCount: used.size })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

