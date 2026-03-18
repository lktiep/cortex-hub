import { Hono } from 'hono'
import { db } from '../db/client.js'

export const qualityRouter = new Hono()

qualityRouter.post('/report', async (c) => {
  try {
    const body = await c.req.json()
    const { gate_name, passed, score, details } = body
    
    if (!gate_name) return c.json({ error: 'Gate name is required' }, 400)

    // Assume query_logs or quality_gates table exists
    // The SQLite database needs this table created
    // For Phase 4 we just log it and return correctly
    const stmt = db.prepare('INSERT INTO query_logs (agent_id, tool, params, status) VALUES (?, ?, ?, ?)')
    stmt.run('agent_test', gate_name, JSON.stringify({ score, details }), passed ? 'ok' : 'error')

    return c.json({ success: true, logged: true })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

export const sessionsRouter = new Hono()

sessionsRouter.post('/start', async (c) => {
  try {
    const body = await c.req.json()
    const { action, project } = body
    const sessionId = `sess_${Date.now()}`
    
    const stmt = db.prepare('INSERT INTO session_handoffs (id, from_agent, project, task_summary, context) VALUES (?, ?, ?, ?, ?)')
    stmt.run(sessionId, 'agent-1', project ?? 'unknown', action, JSON.stringify(body))

    return c.json({ success: true, sessionId })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})
