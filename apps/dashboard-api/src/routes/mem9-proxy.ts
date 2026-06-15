/**
 * mem9 proxy routes — REST API for hub-mcp memory tools
 *
 * Translates REST calls → in-process Mem9 operations.
 * Endpoints:
 *   POST /store   → Mem9.add()
 *   POST /search  → Mem9.search()
 *   POST /embed   → Embedder.embed() (for knowledge search)
 *   GET  /health  → Mem9.isReady()
 */

import { Hono } from 'hono'
import { Mem9, Embedder } from '@cortex/shared-mem9'
import type { Mem9Config } from '@cortex/shared-mem9'
import { db } from '../db/client.js'
import { normalizeProjectId, normalizeMemoryUserId } from '../db/project-utils.js'
import { createEmbedder } from '../lib/embedder-factory.js'

export const mem9ProxyRouter = new Hono()

/** Lazily initialize Mem9 instance (singleton) */
let mem9Instance: Mem9 | null = null
let embedderInstance: Embedder | null = null

/**
 * Resolve the LLM model for mem9 (fact extraction, dedup).
 * Priority: MEM9_LLM_MODEL env → chat routing chain from DB → fallback
 */
function resolveLlmModel(): string {
  // 1. Dashboard chat routing chain (what user selected in Providers UI)
  try {
    const row = db.prepare(
      "SELECT chain FROM model_routing WHERE purpose = 'chat'"
    ).get() as { chain: string } | undefined
    if (row?.chain) {
      const chain = JSON.parse(row.chain) as { model?: string }[]
      if (chain[0]?.model) return chain[0].model
    }
  } catch {
    // DB might not be ready yet
  }

  // 2. Explicit env var
  const envModel = process.env['MEM9_LLM_MODEL']
  if (envModel) return envModel

  // 3. Fallback
  return ''
}

/**
 * Build a config fingerprint to detect when settings change
 * and singleton needs to be recreated.
 */
function configFingerprint(): string {
  return resolveLlmModel()
}

let lastFingerprint = ''

function getMem9Config(): Mem9Config {
  const gatewayUrl = process.env['LLM_GATEWAY_URL'] ?? `http://localhost:${process.env['PORT'] || 4000}/api/llm`

  return {
    llm: {
      baseUrl: `http://localhost:${process.env['PORT'] || 4000}/api/llm/v1`,
      model: resolveLlmModel(),
    },
    embedder: {
      provider: 'gemini' as const, // Dummy to bypass local check
      apiKey: '',
      model: 'gemini-embedding-001',
      gatewayUrl,
    },
    vectorStore: {
      url: process.env['QDRANT_URL'] || 'http://qdrant:6333',
      collection: 'cortex_memories',
    },
  }
}

export function getMem9(): Mem9 {
  const fp = configFingerprint()
  if (!mem9Instance || fp !== lastFingerprint) {
    lastFingerprint = fp
    mem9Instance = new Mem9(getMem9Config())
    embedderInstance = null // also invalidate embedder
  }
  return mem9Instance
}

function getEmbedder(): Embedder {
  const fp = configFingerprint()
  if (!embedderInstance || fp !== lastFingerprint) {
    lastFingerprint = fp
    embedderInstance = createEmbedder()
  }
  return embedderInstance
}

/**
 * POST /store — Store a memory
 * Body: { messages, userId, agentId?, metadata? }
 */
mem9ProxyRouter.post('/store', async (c) => {
  try {
    const body = await c.req.json()
    const { messages, userId, agentId, metadata } = body

    if (!messages || !userId) {
      return c.json({ error: 'messages and userId are required' }, 400)
    }

    const normalizedUserId = normalizeMemoryUserId(userId)
    const normalizedMetadata = { ...(metadata ?? {}) }
    if (normalizedMetadata.project_id) {
      normalizedMetadata.project_id = normalizeProjectId(normalizedMetadata.project_id)
    }

    const mem9 = getMem9()
    const result = await mem9.add({
      messages,
      userId: normalizedUserId,
      agentId: agentId ?? 'default',
      metadata: normalizedMetadata,
    })

    c.header('X-Cortex-Compute-Tokens', String(result.tokensUsed || 0))
    c.header('X-Cortex-Compute-Model', resolveLlmModel())

    return c.json({
      success: true,
      events: result.events,
      tokensUsed: result.tokensUsed,
    })
  } catch (error) {
    console.error('[mem9-proxy] store error:', error)
    return c.json({ error: String(error) }, 500)
  }
})

/**
 * POST /search — Search memories by semantic similarity
 * Body: { query, userId, agentId?, limit? }
 */
mem9ProxyRouter.post('/search', async (c) => {
  try {
    const body = await c.req.json()
    const { query, userId, agentId, limit } = body

    if (!query || !userId) {
      return c.json({ error: 'query and userId are required' }, 400)
    }

    const normalizedUserId = normalizeMemoryUserId(userId)
    const mem9 = getMem9()
    const result = await mem9.search({
      query,
      userId: normalizedUserId,
      agentId,
      limit,
    })

    // 1. Resolve project UUID from normalized user ID
    let projectId: string | null = null
    if (normalizedUserId.startsWith('project-')) {
      const branchIndex = normalizedUserId.indexOf(':branch-')
      projectId = branchIndex !== -1
        ? normalizedUserId.slice('project-'.length, branchIndex)
        : normalizedUserId.slice('project-'.length)
    }

    // 2. Fetch actual session handoffs from SQLite database to guarantee latest session context
    let sqliteSessions: any[] = []
    if (projectId) {
      try {
        const rows = db.prepare(`
          SELECT id, task_summary, created_at, from_agent FROM session_handoffs
          WHERE project_id = ? AND status = 'completed' AND task_summary IS NOT NULL AND task_summary != ''
          ORDER BY created_at DESC LIMIT 3
        `).all(projectId) as Array<{ id: string; task_summary: string; created_at: string; from_agent: string }>

        sqliteSessions = rows.map(r => ({
          id: `session-${r.id}`,
          memory: `[Session Summary] ${r.task_summary}`,
          hash: '',
          userId: normalizedUserId,
          agentId: r.from_agent,
          metadata: {
            type: 'session-summary',
            session_id: r.id,
            project_id: projectId,
            auto_captured: true
          },
          score: 1.0,
          createdAt: r.created_at,
          updatedAt: r.created_at
        }))
      } catch (err) {
        console.warn('[mem9-proxy] failed to fetch sqlite sessions:', err)
      }
    }

    // 3. Merge SQLite sessions and filter duplicates from Qdrant results
    let combinedMemories = [...result.memories]
    if (sqliteSessions.length > 0) {
      for (const sess of sqliteSessions) {
        const dupIndex = combinedMemories.findIndex(m => m.metadata?.session_id === sess.metadata.session_id)
        if (dupIndex !== -1) {
          combinedMemories[dupIndex] = sess
        } else {
          combinedMemories.push(sess)
        }
      }
    }

    // 4. Re-rank combined memories by applying recency boost
    const now = Date.now()
    const scoredMemories = combinedMemories.map((m) => {
      const time = m.createdAt ? new Date(m.createdAt).getTime() : 0
      const ageInDays = Math.max(0, (now - time) / (1000 * 60 * 60 * 24))

      let recencyScore = 0
      if (m.metadata?.type === 'session-summary') {
        // Fast exponential decay for session summaries: half-life of 2 days
        recencyScore = Math.exp(-ageInDays / 2)
      } else {
        // Slower linear decay for general memories: linear decay over 90 days
        recencyScore = Math.max(0, 1 - ageInDays / 90)
      }

      const isSession = m.metadata?.type === 'session-summary'
      const weightVector = isSession ? 0.5 : 0.9
      const weightRecency = isSession ? 0.5 : 0.1

      const finalScore = ((m.score ?? 0) * weightVector) + (recencyScore * weightRecency)

      return {
        ...m,
        score: finalScore,
      }
    })

    scoredMemories.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    const finalMemories = scoredMemories.slice(0, limit ?? 10)

    c.header('X-Cortex-Compute-Tokens', String(result.tokensUsed || 0))
    c.header('X-Cortex-Compute-Model', resolveLlmModel())

    return c.json({
      memories: finalMemories,
      tokensUsed: result.tokensUsed,
    })
  } catch (error) {
    console.error('[mem9-proxy] search error:', error)
    return c.json({ error: String(error) }, 500)
  }
})


/**
 * DELETE /:id — Delete a single memory by ID
 */
mem9ProxyRouter.delete('/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const mem9 = getMem9()
    await mem9.delete(id)
    return c.json({ success: true, id })
  } catch (error) {
    console.error('[mem9-proxy] delete error:', error)
    return c.json({ error: String(error) }, 500)
  }
})

/**
 * POST /embed — Embed text to vector (for knowledge search)
 * Body: { text }
 */
mem9ProxyRouter.post('/embed', async (c) => {
  try {
    const body = await c.req.json()
    const { text } = body

    if (!text) {
      return c.json({ error: 'text is required' }, 400)
    }

    const embedder = getEmbedder()
    const vector = await embedder.embed(text)

    return c.json({ vector, dimensions: vector.length })
  } catch (error) {
    console.error('[mem9-proxy] embed error:', error)
    return c.json({ error: String(error) }, 500)
  }
})

/**
 * GET /health — Check if mem9 dependencies are reachable
 */
mem9ProxyRouter.get('/health', async (c) => {
  try {
    const mem9 = getMem9()
    const status = await mem9.isReady()

    return c.json({
      status: status.llm && status.vectorStore ? 'healthy' : 'degraded',
      llm: status.llm ? 'ok' : 'error',
      vectorStore: status.vectorStore ? 'ok' : 'error',
    })
  } catch (error) {
    return c.json({
      status: 'error',
      error: String(error),
    }, 500)
  }
})
