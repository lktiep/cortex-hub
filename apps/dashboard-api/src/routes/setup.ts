import { Hono } from 'hono'
import { db } from '../db/client.js'

export const setupRouter = new Hono()

setupRouter.get('/status', (c) => {
  const stmt = db.prepare('SELECT completed FROM setup_status WHERE id = 1')
  const status = stmt.get() as { completed: number } | undefined
  return c.json({ completed: status?.completed === 1 })
})

setupRouter.post('/complete', async (c) => {
  try {
    const stmt = db.prepare('UPDATE setup_status SET completed = 1, completed_at = datetime("now") WHERE id = 1')
    stmt.run()
    return c.json({ success: true })
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500)
  }
})
setupRouter.get('/models', async (c) => {
  const cliproxyUrl = process.env.LLM_PROXY_URL || process.env.CLIPROXY_URL || process.env.NEXT_PUBLIC_CLIPROXY_URL || 'http://localhost:8317'
  try {
    const res = await fetch(`${cliproxyUrl}/v1/models`, {
      signal: AbortSignal.timeout(5000)
    })
    
    if (!res.ok) {
        throw new Error(`CLIProxy returned ${res.status}`)
    }
    const data = await res.json()
    return c.json(data)
  } catch (err) {
    return c.json({ error: 'Failed to fetch models', details: String(err) }, 502)
  }
})

setupRouter.get('/test', async (c) => {
  const cliproxyUrl = process.env.LLM_PROXY_URL || process.env.CLIPROXY_URL || process.env.NEXT_PUBLIC_CLIPROXY_URL || 'http://localhost:8317'
  const qdrantUrl = process.env.QDRANT_URL || process.env.NEXT_PUBLIC_QDRANT_URL || 'http://localhost:6333'

  const results = {
    cliproxy: false,
    qdrant: false,
    dashboardApi: true, 
    allPassed: false
  }

  try {
    const res = await fetch(`${cliproxyUrl}/v1/models`, { signal: AbortSignal.timeout(3000) })
    if (res.ok || res.status === 401) results.cliproxy = true
  } catch (e) {
    console.error('CLIProxy offline:', e)
  }

  try {
    const res = await fetch(`${qdrantUrl}/`, { signal: AbortSignal.timeout(3000) })
    if (res.ok) results.qdrant = true
  } catch (e) {
    console.error('Qdrant offline:', e)
  }

  results.allPassed = results.cliproxy && results.qdrant && results.dashboardApi
  
  return c.json(results, results.allPassed ? 200 : 503)
})
