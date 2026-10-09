import { Hono } from 'hono'
import { db } from '../db/client.js'

export const statsRouter = new Hono()

const QDRANT_URL = () => process.env['QDRANT_URL'] || 'http://qdrant:6333'


// ── Dashboard Stats (real data) ──
statsRouter.get('/overview', async (c) => {
  try {
    const keyCount = (db.prepare('SELECT COUNT(*) as count FROM api_keys').get() as { count: number }).count
    const agentCount = (db.prepare("SELECT COUNT(DISTINCT from_agent) as count FROM session_handoffs WHERE status = 'active'").get() as { count: number }).count
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
import { getGitNexusRepos } from './intel.js'

statsRouter.get('/overview-v2', async (c) => {
  try {
    // ── Pre-fetch GitNexus native repos ──
    let gitNexusRepos: Array<{ projectId: string; symbols: number | string }> = []
    try {
      gitNexusRepos = await getGitNexusRepos()
    } catch (e) {
      console.warn('[overview-v2] gitnexus list_repos error:', e)
    }

    // ── Basic counts ──
    const keyCount = (db.prepare('SELECT COUNT(*) as count FROM api_keys').get() as { count: number }).count
    const agentCount = (db.prepare("SELECT COUNT(DISTINCT from_agent) as count FROM session_handoffs WHERE status = 'active'").get() as { count: number }).count
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
        SELECT id, branch, status, mem9_status, mem9_chunks, mem9_progress, mem9_total_chunks,
               symbols_found, total_files, completed_at, created_at as started_at
        FROM index_jobs WHERE project_id = ? ORDER BY completed_at DESC, created_at DESC LIMIT 1
      `).get(p.id) as {
        id: string; branch: string; status: string; mem9_status: string | null
        mem9_chunks: number | null; mem9_progress: number | null; mem9_total_chunks: number | null
        symbols_found: number | null
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
        gitnexus: (() => {
          if (job) {
            return {
              status: job.status,
              symbols: job.symbols_found ?? p.indexed_symbols ?? 0,
              files: job.total_files ?? 0,
              branch: job.branch,
              completedAt: job.completed_at,
            }
          }
          const nativeJob = gitNexusRepos.find(r => r.projectId === p.id)
          if (nativeJob) {
            return {
              status: 'done',
              symbols: typeof nativeJob.symbols === 'number' ? nativeJob.symbols : p.indexed_symbols ?? 0,
              files: p.indexed_symbols ?? 0,
              branch: 'main',
              completedAt: p.created_at,
            }
          }
          return { status: 'none', symbols: 0, files: 0, branch: null, completedAt: null }
        })(),
        mem9: job ? {
          status: job.mem9_status ?? 'pending',
          chunks: job.mem9_chunks ?? 0,
          progress: job.mem9_progress ?? 0,
          totalChunks: job.mem9_total_chunks ?? 0,
        } : { status: 'none', chunks: 0, progress: 0, totalChunks: 0 },
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

    // ── Token savings (from Cortex tool calls) ──
    // Estimation model: tokens saved = (estimated grep/manual cost) - (cortex response tokens)
    // Grep alternative cost estimates per tool type (based on typical agent behavior):
    //   code_search: grep would scan ~20 files × ~500 tokens = 10,000 tokens baseline
    //   code_context: manual trace would read ~10 files × ~800 tokens = 8,000 tokens
    //   code_impact: manual impact analysis ~15 files × ~600 tokens = 9,000 tokens
    //   memory_search: agent would re-discover context ~3,000 tokens
    //   Other tools: conservative 2x savings
    const GREP_BASELINE: Record<string, number> = {
      code_search: 10000,
      code_context: 8000,
      code_impact: 9000,
      knowledge_search: 5000,
      memory_search: 3000,
      detect_changes: 6000,
      cypher: 7000,
    }

    let tokenSavings = { totalTokensSaved: 0, totalToolCalls: 0, avgTokensPerCall: 0, totalDataBytes: 0, topTools: [] as { tool: string; tokensSaved: number; calls: number }[] }
    try {
      const savingsOverall = db.prepare(`
        SELECT COUNT(*) as total_calls,
               COALESCE(SUM(output_size), 0) as total_output_bytes,
               COALESCE(SUM(input_size), 0) + COALESCE(SUM(output_size), 0) as total_data_bytes
        FROM query_logs WHERE status = 'ok'
      `).get() as { total_calls: number; total_output_bytes: number; total_data_bytes: number }

      const topTools = db.prepare(`
        SELECT tool, COUNT(*) as calls, COALESCE(SUM(output_size), 0) as output_bytes, COALESCE(SUM(compute_tokens), 0) as compute_tokens
        FROM query_logs WHERE status = 'ok'
        GROUP BY tool ORDER BY output_bytes DESC LIMIT 5
      `).all() as Array<{ tool: string; calls: number; output_bytes: number; compute_tokens: number }>

      // Calculate per-tool savings using baseline model
      const allTools = db.prepare(`
        SELECT tool, COUNT(*) as calls, COALESCE(SUM(output_size), 0) as output_bytes
        FROM query_logs WHERE status = 'ok'
        GROUP BY tool
      `).all() as Array<{ tool: string; calls: number; output_bytes: number }>

      let totalTokensSaved = 0
      for (const t of allTools) {
        const toolKey = t.tool.replace('cortex_', '')
        const baseline = GREP_BASELINE[toolKey]
        const cortexTokens = Math.round(t.output_bytes / 4)
        if (baseline !== undefined) {
          // Savings = (what grep would cost × calls) - (what cortex returned)
          const grepCost = baseline > 0 ? baseline * t.calls : cortexTokens * 3
          totalTokensSaved += Math.max(0, grepCost - cortexTokens)
        } else {
          // Unknown tool: conservative 2x estimate
          totalTokensSaved += cortexTokens
        }
      }

      tokenSavings = {
        totalTokensSaved,
        totalToolCalls: savingsOverall.total_calls,
        avgTokensPerCall: savingsOverall.total_calls > 0 ? Math.round(totalTokensSaved / savingsOverall.total_calls) : 0,
        totalDataBytes: savingsOverall.total_data_bytes,
        topTools: topTools.map(t => {
          const toolKey = t.tool.replace('cortex_', '')
          const baseline = GREP_BASELINE[toolKey]
          const cortexTokens = Math.round(t.output_bytes / 4)
          const saved = baseline !== undefined
            ? Math.max(0, (baseline > 0 ? baseline * t.calls : cortexTokens * 3) - cortexTokens)
            : cortexTokens
          return { tool: t.tool, tokensSaved: saved, calls: t.calls, computeTokens: t.compute_tokens }
        }),
      }
    } catch (e) { console.warn('[overview-v2] token savings error:', e) }

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
      tokenSavings,
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
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
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
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )`)
    db.exec(`INSERT OR IGNORE INTO budget_settings (id) VALUES (1)`)

    db.prepare(`UPDATE budget_settings SET 
      daily_limit = ?, monthly_limit = ?, alert_threshold = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
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
    const { agentId, tool, params, status, latencyMs, error, projectId, inputSize, outputSize, computeTokens, computeModel } = await c.req.json()
    const resolvedAgent = agentId || 'unknown'
    
    // Resolve project slug/name to actual internal UUID (e.g. "Do_An" -> "proj-12224eee")
    let resolvedProjectId = projectId || null
    if (resolvedProjectId && !resolvedProjectId.startsWith('proj-')) {
      const projRecord = db.prepare(
        "SELECT id FROM projects WHERE slug = ? COLLATE NOCASE OR name = ? COLLATE NOCASE OR slug LIKE ? COLLATE NOCASE"
      ).get(resolvedProjectId, resolvedProjectId, `%${resolvedProjectId}%`) as { id: string } | undefined
      if (projRecord) {
        resolvedProjectId = projRecord.id
      }
    }

    const stmt = db.prepare('INSERT INTO query_logs (agent_id, tool, params, latency_ms, status, error, project_id, input_size, output_size, compute_tokens, compute_model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    stmt.run(
      resolvedAgent,
      tool || 'unknown',
      params ? JSON.stringify(params) : null,
      latencyMs || 0,
      status || 'ok',
      error || null,
      resolvedProjectId,
      inputSize || 0,
      outputSize || 0,
      computeTokens || 0,
      computeModel || null
    )

    // Keep the calling session alive, and only that one. agentId here is the API key's
    // name, and the agents all call themselves "claude-code": matching from_agent touched
    // every active session on every machine (and other keys' sessions too) on each call,
    // so last_activity could not tell a live session from one abandoned days ago.
    // hub-mcp is stateless and sends no session id, so the caller's session is the one
    // the call names (cortex_session_end), else the key's newest active session —
    // preferring one in the project the call is about. Same rule as intel.ts uses to
    // find the caller's session; rows from before api_key_name fall back to from_agent.
    try {
      const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : null
      if (sessionId) {
        db.prepare(
          `UPDATE session_handoffs SET last_activity = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
           WHERE id = ? AND status = 'active'`
        ).run(sessionId)
      } else {
        db.prepare(
          `UPDATE session_handoffs SET last_activity = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
           WHERE id = (
             SELECT id FROM session_handoffs
              WHERE status = 'active'
                AND (api_key_name = ? OR (api_key_name IS NULL AND from_agent = ?))
              ORDER BY (project_id = ?) DESC, created_at DESC
              LIMIT 1
           )`
        ).run(resolvedAgent, resolvedAgent, resolvedProjectId)
      }
    } catch { /* non-critical */ }

    // Bridge backend LLM cost to the unified billing table
    if (computeTokens && computeTokens > 0 && computeModel) {
      const usageStmt = db.prepare('INSERT INTO usage_logs (agent_id, model, total_tokens, request_type, project_id) VALUES (?, ?, ?, ?, ?)')
      usageStmt.run(agentId || 'unknown', computeModel, computeTokens, 'tool', resolvedProjectId)
    }

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
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

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
        COALESCE(SUM(output_size), 0) as total_output_bytes,
        COALESCE(SUM(compute_tokens), 0) as compute_tokens
      FROM query_logs
      WHERE ${where}
      GROUP BY tool
      ORDER BY total_calls DESC
    `).all(...params) as Array<{
      tool: string; total_calls: number; success_count: number; error_count: number
      avg_latency_ms: number; avg_input_size: number | null; avg_output_size: number | null
      total_input_bytes: number; total_output_bytes: number; compute_tokens: number
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
      estimatedTokensSaved: (() => {
        const toolKey = t.tool.replace('cortex_', '')
        const baseline: Record<string, number> = { code_search: 10000, code_context: 8000, code_impact: 9000, knowledge_search: 5000, memory_search: 3000, detect_changes: 6000, cypher: 7000 }
        const cortexTokens = Math.round(t.total_output_bytes / 4)
        const b = baseline[toolKey]
        if (b !== undefined) return Math.max(0, (b > 0 ? b * t.total_calls : cortexTokens * 3) - cortexTokens)
        return cortexTokens
      })(),
      computeTokens: t.compute_tokens,
      totalInputBytes: t.total_input_bytes,
      totalOutputBytes: t.total_output_bytes,
    }))

    // Overall summary
    const totalCalls = enriched.reduce((s, t) => s + t.totalCalls, 0)
    const totalSuccess = enriched.reduce((s, t) => s + Math.round(t.totalCalls * t.successRate / 100), 0)
    const totalOutputBytes = enriched.reduce((s, t) => s + t.totalOutputBytes, 0)
    const totalInputBytes = enriched.reduce((s, t) => s + t.totalInputBytes, 0)
    const totalComputeTokens = enriched.reduce((s, t) => s + t.computeTokens, 0)

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
        estimatedTokensSaved: enriched.reduce((sum, t) => sum + (t.estimatedTokensSaved || 0), 0),
        totalComputeTokens,
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

// ── Workflow-quality helpers ──────────────────────────────────────────────────────────────
// created_at is written as strftime('%Y-%m-%dT%H:%M:%SZ'), so a cutoff has to carry the T and
// the Z or the string comparison silently widens: 'T' sorts above every digit, so a cutoff of
// "2026-09-28 11:00:00" also matches 09:00 on the same day, and a two-hour window became a day.
function isoCutoff(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString().replace(/\.\d+Z$/, 'Z')
}

// Words that carry no retrieval signal, so two queries differing only in these are the same query.
const QUERY_STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'to', 'for', 'and', 'or', 'is', 'are', 'was', 'how', 'what',
  'where', 'which', 'that', 'this', 'it', 'on', 'with', 'do', 'does', 'did', 'we', 'i', 'my',
])

function queryTokens(query: string): Set<string> {
  return new Set(
    query.toLowerCase().split(/[^a-z0-9_]+/).filter(w => w.length > 2 && !QUERY_STOP_WORDS.has(w))
  )
}

// Two searches that share half their meaningful words return nearly the same hits: recall@10 on
// this index is 1.000 (benchmarks/retrieval_bench.ts, n=15), so a reword cannot surface a file
// the first call missed. Spotting the reword is what lets the hint say something useful.
function isReword(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false
  let shared = 0
  for (const token of a) if (b.has(token)) shared++
  return shared / Math.min(a.size, b.size) >= 0.5
}

function loggedQueries(rows: Array<{ tool: string; params: string | null }>, toolFragment: string): string[] {
  const queries: string[] = []
  for (const row of rows) {
    if (!row.tool.includes(toolFragment)) continue
    try {
      const query = (JSON.parse(row.params ?? '{}') as { query?: unknown }).query
      if (typeof query === 'string' && query.trim()) queries.push(query)
    } catch {
      // params is free-form text for some tools; a row we cannot parse simply is not counted
    }
  }
  return queries
}

// Returns how many of these searches were rewordings of an earlier one in the same list.
function countRewords(queries: string[]): number {
  const distinct: Array<Set<string>> = []
  let rewords = 0
  for (const query of queries) {
    const tokens = queryTokens(query)
    if (distinct.some(seen => isReword(seen, tokens))) rewords++
    else distinct.push(tokens)
  }
  return rewords
}

// ── Session Compliance Check ──
// Scores how the session was worked, not how many different tools it touched.
//
// The previous version was usedTools / 13 across five categories, which made the best strategy
// for an A grade "call every tool once" — including cortex_cypher and cortex_code_impact on
// files that needed neither. This scores the things that actually change the outcome: recall
// before editing, one search read properly instead of three rewordings, gates reported, session
// closed. A signal that does not apply to a session is dropped from the denominator rather than
// counted against it.
statsRouter.get('/session-compliance/:sessionId', (c) => {
  const sessionId = c.req.param('sessionId')

  try {
    const session = db.prepare(
      'SELECT id, from_agent, created_at, status FROM session_handoffs WHERE id = ?'
    ).get(sessionId) as { id: string; from_agent: string; created_at: string; status: string } | undefined

    if (!session) return c.json({ error: 'Session not found' }, 404)

    const calls = db.prepare(`
      SELECT tool, params, status, created_at FROM query_logs
      WHERE agent_id = ? AND created_at >= ?
      ORDER BY id ASC
    `).all(session.from_agent, session.created_at) as Array<{
      tool: string; params: string | null; status: string; created_at: string
    }>

    const usedTools = new Set(calls.map(c2 => c2.tool))
    const has = (fragment: string) => calls.some(c2 => c2.tool.includes(fragment))

    const codeSearches = loggedQueries(calls, 'code_search')
    const rewords = countRewords(codeSearches)
    const failedCalls = calls.filter(c2 => c2.status && c2.status !== 'ok')

    // Recall belongs at the start of the session — after twenty calls it is archaeology, not context.
    const firstFew = calls.slice(0, 4).map(c2 => c2.tool)
    const recalledEarly = firstFew.some(t => t.includes('knowledge_search') || t.includes('memory_search'))

    type Signal = { id: string; weight: number; earned: number; detail: string }
    const signals: Signal[] = [
      {
        id: 'session-opened', weight: 10, earned: has('session_start') ? 1 : 0,
        detail: 'cortex_session_start ties the work to a project and a branch',
      },
      {
        id: 'recalled-early', weight: 20, earned: recalledEarly ? 1 : 0,
        detail: 'knowledge/memory recall in the first few calls, before any decisions were re-made',
      },
      {
        id: 'used-discovery', weight: 20,
        earned: has('code_search') || has('code_context') || has('cypher') ? 1 : 0,
        detail: 'the codebase was located with the index rather than guessed at',
      },
      {
        id: 'reported-quality', weight: 10, earned: has('quality_report') ? 1 : 0,
        detail: 'build/typecheck/lint results reached the hub',
      },
      {
        id: 'session-closed', weight: 15, earned: has('session_end') ? 1 : 0,
        detail: 'the session was closed, so the next one can pick it up',
      },
    ]

    // Search discipline only applies to a session that searched at all.
    if (codeSearches.length > 0) {
      signals.push({
        id: 'search-discipline', weight: 25,
        earned: Math.max(0, 1 - rewords / codeSearches.length),
        detail: `${codeSearches.length} code search(es), ${rewords} of them a rewording of an earlier one`,
      })
    }

    const totalWeight = signals.reduce((sum, sig) => sum + sig.weight, 0)
    const earnedWeight = signals.reduce((sum, sig) => sum + sig.weight * sig.earned, 0)
    const overallScore = Math.round((earnedWeight / totalWeight) * 100)

    const hints: string[] = []
    if (rewords > 0) {
      hints.push(
        `🔁 ${rewords} of ${codeSearches.length} code searches reworded an earlier query. ` +
        'Recall@10 on this index is 1.000 — a reword returns the same set. Read all ten hits, ' +
        'then ask a different question or switch tool (cortex_code_context for a symbol, rg for an exact literal).'
      )
    }
    if (!recalledEarly) {
      hints.push('📚 Run cortex_knowledge_search + cortex_memory_search at the start of the session, not after the decisions are made.')
    }
    const firstFailure = failedCalls[0]
    if (firstFailure && !has('knowledge_store')) {
      hints.push(`🧩 ${failedCalls.length} tool call(s) failed this session (${firstFailure.tool}). If you worked out why, cortex_knowledge_store it so nobody debugs it twice.`)
    }
    if (!has('session_end')) {
      hints.push('🔚 Close the session with cortex_session_end so its summary is searchable next time.')
    }

    return c.json({
      sessionId,
      agent: session.from_agent,
      overallScore,
      grade: overallScore >= 80 ? 'A' : overallScore >= 60 ? 'B' : overallScore >= 40 ? 'C' : 'D',
      signals,
      searches: { total: codeSearches.length, rewords },
      failedCalls: failedCalls.length,
      toolsUsed: [...usedTools],
      hints,
    })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Cortex Hints Engine ──
// One or two hints appended to every MCP tool response — the only steering channel that reaches
// every client regardless of its local rule files. That makes it expensive: a hint that fires on
// every call is a hint agents learn to skip. So it nags about outcomes, not about tool coverage.
statsRouter.get('/hints/:agentId', (c) => {
  const agentId = c.req.param('agentId')
  const currentTool = c.req.query('currentTool') ?? ''

  try {
    const calls = db.prepare(`
      SELECT tool, params, status FROM query_logs
      WHERE agent_id = ? AND created_at >= ?
      ORDER BY id ASC
    `).all(agentId, isoCutoff(2 * 60 * 60 * 1000)) as Array<{
      tool: string; params: string | null; status: string
    }>

    const has = (fragment: string) => calls.some(c2 => c2.tool.includes(fragment))
    const hints: string[] = []

    if (!has('session_start')) {
      hints.push('⚠️ Call cortex_session_start first — without it nothing you do is attached to a project, and the hooks block edits.')
    }

    if (currentTool.includes('code_search')) {
      const queries = loggedQueries(calls, 'code_search')
      // The call being answered is already logged, so the last query is this one.
      const current = queries[queries.length - 1]
      const earlier = queries.slice(0, -1)
      const isReworded = current !== undefined
        && earlier.some(q => isReword(queryTokens(q), queryTokens(current)))

      if (isReworded) {
        hints.push(
          '🔁 That is a rewording of a query you already ran, and it returns the same set: ' +
          'recall@10 on this index is 1.000, so nothing new can appear. Read all ten hits from the ' +
          'first call. If the answer is not among them, ask a different question, or use ' +
          'cortex_code_context for a known symbol and rg for an exact literal.'
        )
      } else if (earlier.length === 0) {
        hints.push(
          '📖 Scan all the hits before picking one: on this index the target file is rank 1 for ' +
          '8 of 15 benchmark queries but inside the top 10 for 15 of 15. One search read properly ' +
          'beats three searches skimmed.'
        )
      }
    }

    if (currentTool.includes('cypher')) {
      hints.push('💡 Cypher: labels(n) AS type for the type; n.id, n.name, n.filePath, n.startLine and n.endLine as properties. MATCH (n) WHERE n.name CONTAINS "X" RETURN n.name, labels(n) AS type LIMIT 20')
    }

    if (currentTool.includes('list_repos')) {
      hints.push('🔍 Use the projectId from this list with cortex_code_search, cortex_code_context or cortex_cypher.')
    }

    if (currentTool.includes('quality_report')) {
      if (!has('code_search') && !has('code_context') && !has('cypher')) {
        hints.push('🔍 This session reported quality without locating anything through the index. If you edited code you found by guesswork, check cortex_code_impact on what you touched.')
      }
      const failed = calls.filter(c2 => c2.status && c2.status !== 'ok')
      const firstFailed = failed[0]
      if (firstFailed && !has('knowledge_store')) {
        hints.push(`🧩 ${failed.length} call(s) failed earlier (${firstFailed.tool}). If you found the cause, cortex_knowledge_store it.`)
      }
    }

    if (currentTool.includes('session_end')) {
      if (!has('quality_report')) {
        hints.push('📊 Call cortex_quality_report with the build/typecheck/lint results before ending.')
      }
      if (!has('memory_store')) {
        hints.push('🧠 cortex_memory_store what this session decided — that is what the next one recalls.')
      }
    }

    // Two at most. Beyond that the block gets skimmed and the useful one goes with it.
    return c.json({ agentId, hints: hints.slice(0, 2), toolsUsedCount: new Set(calls.map(c2 => c2.tool)).size })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})


// ── Conductor: Live agent status (enriched with session identity) ──
statsRouter.get('/conductor/agents', (c) => {
  try {
    const cutoff30m = isoCutoff(30 * 60 * 1000)

    // Get active agents from query_logs (recent MCP tool calls)
    const agents = db.prepare(`
      SELECT
        COALESCE(agent_id, 'unknown') as agentId,
        COUNT(*) as queryCount,
        MAX(created_at) as lastActivity
      FROM query_logs
      WHERE created_at > ?
      GROUP BY agent_id
      ORDER BY lastActivity DESC
    `).all(cutoff30m) as Array<{ agentId: string; queryCount: number; lastActivity: string }>

    // Get recent tools used per agent
    const toolsQuery = db.prepare(`
      SELECT agent_id, tool, COUNT(*) as cnt
      FROM query_logs WHERE created_at > ? AND agent_id = ?
      GROUP BY tool ORDER BY cnt DESC LIMIT 5
    `)

    // Get latest session identity for each agent (from session_handoffs)
    const sessionQuery = db.prepare(`
      SELECT from_agent, hostname, os, ide, branch, role, capabilities, project, status, id as sessionId
      FROM session_handoffs
      WHERE from_agent = ? OR api_key_name = ?
      ORDER BY created_at DESC LIMIT 1
    `)

    // Get active tasks for each agent
    const taskQuery = db.prepare(`
      SELECT id, title, status FROM conductor_tasks
      WHERE assigned_to_agent = ? AND status IN ('assigned','accepted','in_progress')
      LIMIT 3
    `)

    const now = Date.now()
    const enriched = agents.map(a => {
      const lastMs = new Date(a.lastActivity.endsWith('Z') || a.lastActivity.includes('+') ? a.lastActivity : a.lastActivity + 'Z').getTime()
      const diffMin = (now - lastMs) / 60000

      // Get tools
      const tools = toolsQuery.all(cutoff30m, a.agentId) as Array<{ tool: string; cnt: number }>

      // Get session identity
      const session = sessionQuery.get(a.agentId, a.agentId) as {
        from_agent: string; hostname: string | null; os: string | null; ide: string | null;
        branch: string | null; role: string | null; capabilities: string | null;
        project: string | null; status: string; sessionId: string;
      } | undefined

      // Get active tasks
      let activeTasks: Array<{ id: string; title: string; status: string }> = []
      try { activeTasks = taskQuery.all(a.agentId) as typeof activeTasks } catch { /* table may not exist */ }

      return {
        agentId: a.agentId,
        queryCount: a.queryCount,
        lastActivity: a.lastActivity,
        status: diffMin < 5 ? 'online' as const : diffMin < 30 ? 'idle' as const : 'offline' as const,
        toolsUsed: tools.map(t => t.tool),
        // Session identity
        hostname: session?.hostname ?? null,
        os: session?.os ?? null,
        ide: session?.ide ?? null,
        branch: session?.branch ?? null,
        role: session?.role ?? null,
        capabilities: session?.capabilities ? JSON.parse(session.capabilities) : [],
        project: session?.project ?? null,
        sessionId: session?.sessionId ?? null,
        sessionStatus: session?.status ?? null,
        // Active tasks
        activeTasks,
      }
    })

    const online = enriched.filter(a => a.status === 'online').length
    const idle = enriched.filter(a => a.status === 'idle').length

    return c.json({ agents: enriched, online, idle, total: enriched.length })
  } catch (error) {
    return c.json({ agents: [], online: 0, idle: 0, total: 0, error: String(error) })
  }
})

// ── Conductor: Task list from conductor_tasks table ──
statsRouter.get('/conductor/tasks', (c) => {
  try {
    const limit = Number(c.req.query('limit') ?? 100)
    const owner = c.req.query('owner')
    
    let query = 'SELECT * FROM conductor_tasks'
    const params: unknown[] = []
    if (owner) {
      query += ' WHERE api_key_owner = ?'
      params.push(owner)
    }
    query += ' ORDER BY created_at DESC LIMIT ?'
    params.push(limit)
    
    const tasks = db.prepare(query).all(...params)
    
    const pending = db.prepare('SELECT COUNT(*) as c FROM conductor_tasks WHERE status = ?').get('pending') as { c: number }
    const active = db.prepare('SELECT COUNT(*) as c FROM conductor_tasks WHERE status IN (?,?,?)').get('assigned', 'accepted', 'in_progress') as { c: number }
    const completed = db.prepare('SELECT COUNT(*) as c FROM conductor_tasks WHERE status = ?').get('completed') as { c: number }
    
    return c.json({ 
      tasks, 
      stats: { pending: pending.c, active: active.c, completed: completed.c, total: tasks.length }
    })
  } catch (error) {
    return c.json({ tasks: [], stats: { pending: 0, active: 0, completed: 0, total: 0 }, error: String(error) })
  }
})
