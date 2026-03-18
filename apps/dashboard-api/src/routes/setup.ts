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
