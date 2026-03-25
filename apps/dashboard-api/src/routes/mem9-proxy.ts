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
import type { Mem9Config, EmbedderConfig } from '@cortex/shared-mem9'
import { db } from '../db/client.js'

export const mem9ProxyRouter = new Hono()

/** Lazily initialize Mem9 instance (singleton) */
let mem9Instance: Mem9 | null = null
let embedderInstance: Embedder | null = null

/**
 * Resolve the Gemini API key from multiple sources (priority order):
 * 1. GEMINI_API_KEY env var (direct config)
 * 2. provider_accounts table in SQLite (Providers UI)
 */
function resolveGeminiApiKey(): string {
  // 1. Environment variable (highest priority)
  const envKey = process.env['GEMINI_API_KEY']
  if (envKey) return envKey

  // 2. Providers DB — look for a Gemini provider with an API key
  try {
    const row = db.prepare(
      "SELECT api_key FROM provider_accounts WHERE type = 'gemini' AND status = 'enabled' AND api_key IS NOT NULL LIMIT 1"
    ).get() as { api_key: string } | undefined
    if (row?.api_key) return row.api_key
  } catch {
    // DB might not be ready yet
  }

  return ''
}

function getMem9Config(): Mem9Config {
  return {
    llm: {
      baseUrl: `${process.env['LLM_PROXY_URL'] || 'http://llm-proxy:8317'}/v1`,
      model: process.env['MEM9_LLM_MODEL'] || 'gpt-4.1-mini',
    },
    embedder: {
      provider: 'gemini' as const,
      apiKey: resolveGeminiApiKey(),
      model: process.env['MEM9_EMBEDDING_MODEL'] || 'gemini-embedding-exp-03-07',
    },
    vectorStore: {
      url: process.env['QDRANT_URL'] || 'http://qdrant:6333',
      collection: 'cortex_memories',
    },
  }
}

/** Track the API key used to create singletons — invalidate if it changes */
let lastApiKey = ''

function getMem9(): Mem9 {
  const currentKey = resolveGeminiApiKey()
  if (!mem9Instance || currentKey !== lastApiKey) {
    lastApiKey = currentKey
    mem9Instance = new Mem9(getMem9Config())
    embedderInstance = null // also invalidate embedder
  }
  return mem9Instance
}

function getEmbedder(): Embedder {
  const currentKey = resolveGeminiApiKey()
  if (!embedderInstance || currentKey !== lastApiKey) {
    lastApiKey = currentKey
    const config = getMem9Config()
    embedderInstance = new Embedder(config.embedder)
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

    const mem9 = getMem9()
    const result = await mem9.add({ messages, userId, agentId, metadata })

    c.header('X-Cortex-Compute-Tokens', String(result.tokensUsed || 0))
    c.header('X-Cortex-Compute-Model', process.env['MEM9_LLM_MODEL'] || 'gpt-4.1-mini')

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

    const mem9 = getMem9()
    const result = await mem9.search({ query, userId, agentId, limit })

    c.header('X-Cortex-Compute-Tokens', String(result.tokensUsed || 0))
    c.header('X-Cortex-Compute-Model', process.env['MEM9_LLM_MODEL'] || 'gpt-4.1-mini')

    return c.json({
      memories: result.memories,
      tokensUsed: result.tokensUsed,
    })
  } catch (error) {
    console.error('[mem9-proxy] search error:', error)
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
