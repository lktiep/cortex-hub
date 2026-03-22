import { Hono } from 'hono'
import { createLogger } from '@cortex/shared-utils'

const logger = createLogger('intel')

export const intelRouter = new Hono()

const GITNEXUS_URL = () => process.env.GITNEXUS_URL ?? 'http://gitnexus:4848'

/**
 * Call GitNexus eval-server HTTP API.
 */
async function callGitNexus(
  tool: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const url = `${GITNEXUS_URL()}/tool/${tool}`
  logger.info(`GitNexus ${tool}: ${JSON.stringify(params)}`)

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(30000),
  })

  const text = await res.text()

  if (!res.ok) {
    throw new Error(text || `GitNexus ${tool} failed: ${res.status}`)
  }

  // GitNexus may return JSON or plain text
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text.trim() }
  }
}

// ── Search: query codebase via GitNexus knowledge graph ──
intelRouter.post('/search', async (c) => {
  try {
    const body = await c.req.json()
    const { query, limit, projectId } = body as {
      query: string
      limit?: number
      projectId?: string
    }

    if (!query) return c.json({ error: 'Query is required' }, 400)

    const params: Record<string, unknown> = {
      query,
      limit: limit ?? 5,
      content: true,
    }
    if (projectId) params.repo = projectId

    const results = await callGitNexus('query', params)

    return c.json({
      success: true,
      data: { query, limit: limit ?? 5, source: 'gitnexus', results },
    })
  } catch (error) {
    logger.error(`Code search failed: ${String(error)}`)
    return c.json(
      {
        success: false,
        error: String(error),
        hint: 'Make sure GitNexus service is running and the repository has been indexed.',
      },
      500,
    )
  }
})

// ── Impact: blast radius analysis ──
intelRouter.post('/impact', async (c) => {
  try {
    const body = await c.req.json()
    const { target, direction, projectId } = body as {
      target: string
      direction?: string
      projectId?: string
    }
    if (!target) return c.json({ error: 'Target is required' }, 400)

    const params: Record<string, unknown> = {
      target,
      direction: direction ?? 'downstream',
    }
    if (projectId) params.repo = projectId

    const results = await callGitNexus('impact', params)

    return c.json({
      success: true,
      data: { target, direction: direction ?? 'downstream', results },
    })
  } catch (error) {
    logger.error(`Impact analysis failed: ${String(error)}`)
    return c.json(
      {
        success: false,
        error: String(error),
        hint: 'Ensure the target symbol exists in an indexed repository.',
      },
      500,
    )
  }
})

// ── Context: 360° symbol view ──
intelRouter.post('/context', async (c) => {
  try {
    const body = await c.req.json()
    const { name, projectId, file } = body as {
      name: string
      projectId?: string
      file?: string
    }
    if (!name) return c.json({ error: 'Symbol name is required' }, 400)

    const params: Record<string, unknown> = { name, content: true }
    if (projectId) params.repo = projectId
    if (file) params.file = file

    const results = await callGitNexus('context', params)

    return c.json({
      success: true,
      data: { name, results },
    })
  } catch (error) {
    logger.error(`Context lookup failed: ${String(error)}`)
    return c.json(
      {
        success: false,
        error: String(error),
        hint: 'Ensure the symbol exists in an indexed repository.',
      },
      500,
    )
  }
})

// ── Health: check GitNexus service status ──
intelRouter.get('/health', async (c) => {
  try {
    const res = await fetch(`${GITNEXUS_URL()}/health`, {
      signal: AbortSignal.timeout(5000),
    })

    if (!res.ok) {
      return c.json({ status: 'unhealthy', statusCode: res.status }, 503)
    }

    const data = await res.json()
    return c.json({ status: 'healthy', ...data })
  } catch (error) {
    return c.json(
      { status: 'unreachable', error: String(error) },
      503,
    )
  }
})
