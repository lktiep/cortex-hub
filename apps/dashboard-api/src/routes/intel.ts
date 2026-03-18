import { Hono } from 'hono'
import { db } from '../db/client.js'

export const intelRouter = new Hono()

intelRouter.post('/search', async (c) => {
  try {
    const body = await c.req.json()
    const { query, limit } = body
    
    if (!query) return c.json({ error: 'Query is required' }, 400)

    // TODO: Spawn gitnexus CLI or make HTTP request to Native GitNexus MCP
    // For now, return stub data until the native git process is connected
    return c.json({
      success: true,
      data: {
        query,
        limit,
        results: [
          { file: 'apps/hub-mcp/src/index.ts', snippet: 'cortex.code.search', relevance: 0.95 }
        ]
      }
    })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

intelRouter.post('/impact', async (c) => {
  try {
    const body = await c.req.json()
    const { target, direction } = body
    if (!target) return c.json({ error: 'Target is required' }, 400)

    // TODO: Query GitNexus impact graph
    return c.json({
      success: true,
      data: {
        target,
        direction,
        affectedFiles: []
      }
    })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})
