import { Hono } from 'hono'
import { db } from '../db/client.js'

export const usageRouter = new Hono()

// ── Usage Summary ──
usageRouter.get('/summary', (c) => {
  try {
    const totalRow = db
      .prepare(
        `SELECT 
          COUNT(*) as total_requests,
          COALESCE(SUM(total_tokens), 0) as total_tokens,
          COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
          COALESCE(SUM(completion_tokens), 0) as completion_tokens
         FROM usage_logs`
      )
      .get() as Record<string, number>

    const todayRow = db
      .prepare(
        `SELECT 
          COUNT(*) as requests,
          COALESCE(SUM(total_tokens), 0) as tokens
         FROM usage_logs 
         WHERE date(created_at) = date('now')`
      )
      .get() as Record<string, number>

    // Estimate cost ($0.005 per 1K tokens blended rate)
    const totalTokens = totalRow?.total_tokens ?? 0
    const estimatedCost = (totalTokens / 1000) * 0.005

    return c.json({
      totalRequests: totalRow?.total_requests ?? 0,
      totalTokens,
      promptTokens: totalRow?.prompt_tokens ?? 0,
      completionTokens: totalRow?.completion_tokens ?? 0,
      todayRequests: todayRow?.requests ?? 0,
      todayTokens: todayRow?.tokens ?? 0,
      estimatedCost: Math.round(estimatedCost * 100) / 100,
    })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Usage by Model ──
usageRouter.get('/by-model', (c) => {
  try {
    const rows = db
      .prepare(
        `SELECT 
          model,
          COUNT(*) as requests,
          SUM(total_tokens) as total_tokens,
          SUM(prompt_tokens) as prompt_tokens,
          SUM(completion_tokens) as completion_tokens
         FROM usage_logs
         GROUP BY model
         ORDER BY total_tokens DESC`
      )
      .all()
    return c.json({ models: rows })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Usage by Agent ──
usageRouter.get('/by-agent', (c) => {
  try {
    const rows = db
      .prepare(
        `SELECT 
          agent_id,
          COUNT(*) as requests,
          SUM(total_tokens) as total_tokens,
          MAX(created_at) as last_active
         FROM usage_logs
         GROUP BY agent_id
         ORDER BY total_tokens DESC`
      )
      .all()
    return c.json({ agents: rows })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Daily History ──
usageRouter.get('/history', (c) => {
  const days = Number(c.req.query('days') ?? 30)
  try {
    const rows = db
      .prepare(
        `SELECT 
          date(created_at) as day,
          COUNT(*) as requests,
          SUM(total_tokens) as tokens
         FROM usage_logs
         WHERE created_at >= datetime('now', ? || ' days')
         GROUP BY date(created_at)
         ORDER BY day ASC`
      )
      .all(`-${days}`)
    return c.json({ history: rows })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Log Usage (called by MCP gateway or proxy) ──
usageRouter.post('/log', async (c) => {
  try {
    const body = await c.req.json()
    const { agentId, model, promptTokens, completionTokens, totalTokens, projectId, requestType } =
      body as {
        agentId: string
        model: string
        promptTokens?: number
        completionTokens?: number
        totalTokens?: number
        projectId?: string
        requestType?: string
      }

    db.prepare(
      `INSERT INTO usage_logs (agent_id, model, prompt_tokens, completion_tokens, total_tokens, project_id, request_type)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      agentId,
      model,
      promptTokens ?? 0,
      completionTokens ?? 0,
      totalTokens ?? 0,
      projectId ?? null,
      requestType ?? 'chat'
    )

    return c.json({ success: true }, 201)
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})
