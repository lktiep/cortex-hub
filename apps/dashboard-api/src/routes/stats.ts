import { Hono } from 'hono'
import { db } from '../db/client.js'

export const statsRouter = new Hono()

const QDRANT_URL = () => process.env['QDRANT_URL'] || 'http://qdrant:6333'
const MEM0_URL = () => process.env['MEM0_URL'] || 'http://mem0:8000'

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
