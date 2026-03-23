/**
 * Knowledge Base routes — CRUD + vector search for knowledge documents.
 *
 * Stores metadata in SQLite, vectors in Qdrant "knowledge" collection.
 * Auto-chunks and embeds content on create. Tracks hit counts on search.
 */

import { Hono } from 'hono'
import { randomUUID } from 'crypto'
import { Embedder, VectorStore } from '@cortex/shared-mem9'
import type { EmbedderConfig, VectorStoreConfig } from '@cortex/shared-mem9'
import { db } from '../db/client.js'
import { createLogger } from '@cortex/shared-utils'

const logger = createLogger('knowledge')

export const knowledgeRouter = new Hono()

const QDRANT_URL = process.env.QDRANT_URL ?? 'http://qdrant:6333'
const COLLECTION = 'knowledge'
const CHUNK_SIZE = 1500
const CHUNK_OVERLAP = 300

// ── Helpers ──

function chunkText(text: string): string[] {
  if (text.length <= CHUNK_SIZE) return [text]

  const chunks: string[] = []
  let start = 0

  while (start < text.length) {
    let end = start + CHUNK_SIZE
    if (end < text.length) {
      const newlinePos = text.lastIndexOf('\n', end)
      if (newlinePos > start + CHUNK_SIZE / 2) {
        end = newlinePos + 1
      }
    }
    chunks.push(text.slice(start, end))
    start = end - CHUNK_OVERLAP
    if (start >= text.length) break
  }

  return chunks
}

function resolveGeminiApiKey(): string {
  const envKey = process.env['GEMINI_API_KEY']
  if (envKey) return envKey
  try {
    const row = db.prepare(
      "SELECT api_key FROM provider_accounts WHERE type = 'gemini' AND status = 'enabled' AND api_key IS NOT NULL LIMIT 1"
    ).get() as { api_key: string } | undefined
    if (row?.api_key) return row.api_key
  } catch { /* DB might not be ready */ }
  return ''
}

function getEmbedder(): Embedder {
  const config: EmbedderConfig = {
    provider: 'gemini' as const,
    apiKey: resolveGeminiApiKey(),
    model: process.env['MEM9_EMBEDDING_MODEL'] || 'gemini-embedding-exp-03-07',
  }
  return new Embedder(config)
}

function getVectorStore(): VectorStore {
  const config: VectorStoreConfig = {
    url: QDRANT_URL,
    collection: COLLECTION,
  }
  return new VectorStore(config)
}

// ── GET / — List documents ──
knowledgeRouter.get('/', (c) => {
  const tag = c.req.query('tag')
  const projectId = c.req.query('projectId')
  const status = c.req.query('status') ?? 'active'
  const limit = Number(c.req.query('limit') ?? 50)
  const offset = Number(c.req.query('offset') ?? 0)

  let sql = 'SELECT * FROM knowledge_documents WHERE status = ?'
  const params: unknown[] = [status]

  if (projectId) {
    sql += ' AND project_id = ?'
    params.push(projectId)
  }
  if (tag) {
    sql += " AND tags LIKE '%' || ? || '%'"
    params.push(tag)
  }

  // Get total count
  const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as count')
  const countRow = db.prepare(countSql).get(...params) as { count: number }

  sql += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)

  const documents = db.prepare(sql).all(...params)

  // Stats
  const stats = db.prepare(
    "SELECT COUNT(*) as totalDocs, COALESCE(SUM(chunk_count), 0) as totalChunks, COALESCE(SUM(hit_count), 0) as totalHits FROM knowledge_documents WHERE status = 'active'"
  ).get() as { totalDocs: number; totalChunks: number; totalHits: number }

  return c.json({
    documents,
    total: countRow.count,
    stats,
  })
})

// ── POST / — Create document ──
knowledgeRouter.post('/', async (c) => {
  try {
    const body = await c.req.json()
    const { title, content, tags, projectId, sourceAgentId, source } = body as {
      title: string
      content: string
      tags?: string[]
      projectId?: string
      sourceAgentId?: string
      source?: string
    }

    if (!title || !content) {
      return c.json({ error: 'title and content are required' }, 400)
    }

    const docId = `kdoc-${randomUUID().slice(0, 8)}`
    const tagList = tags ?? []
    const contentPreview = content.slice(0, 500)

    // Chunk content
    const chunks = chunkText(content)
    logger.info(`[${docId}] Chunking: ${chunks.length} chunks from ${content.length} chars`)

    // Embed and store chunks
    const embedder = getEmbedder()
    const vectorStore = getVectorStore()

    // Get vector dimensions
    let vectorSize: number
    try {
      const testVec = await embedder.embed('test')
      vectorSize = testVec.length
    } catch (err) {
      return c.json({ error: `Embedding failed: ${String(err).slice(0, 200)}` }, 500)
    }

    await vectorStore.ensureCollection(vectorSize)

    // Insert document first
    db.prepare(
      `INSERT INTO knowledge_documents (id, title, source, source_agent_id, project_id, tags, content_preview, chunk_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(docId, title, source ?? 'manual', sourceAgentId ?? null, projectId ?? null, JSON.stringify(tagList), contentPreview, chunks.length)

    // Embed and store each chunk
    for (let i = 0; i < chunks.length; i++) {
      const chunkId = randomUUID()
      const chunkContent = chunks[i]!

      try {
        const vector = await embedder.embed(chunkContent)
        await vectorStore.upsert(chunkId, vector, {
          document_id: docId,
          chunk_index: i,
          tags: tagList,
          project_id: projectId ?? '',
          content: chunkContent.slice(0, 2000),
          title,
        })

        db.prepare(
          `INSERT INTO knowledge_chunks (id, document_id, chunk_index, content, char_count)
           VALUES (?, ?, ?, ?, ?)`
        ).run(chunkId, docId, i, chunkContent, chunkContent.length)
      } catch (err) {
        logger.error(`[${docId}] Chunk ${i} embed failed: ${String(err).slice(0, 100)}`)
      }
    }

    const doc = db.prepare('SELECT * FROM knowledge_documents WHERE id = ?').get(docId)
    return c.json(doc, 201)
  } catch (error) {
    logger.error(`Create knowledge failed: ${String(error)}`)
    return c.json({ error: String(error) }, 500)
  }
})

// ── GET /:id — Document detail ──
knowledgeRouter.get('/:id', (c) => {
  const id = c.req.param('id')
  const doc = db.prepare('SELECT * FROM knowledge_documents WHERE id = ?').get(id)
  if (!doc) return c.json({ error: 'Document not found' }, 404)

  const chunks = db.prepare(
    'SELECT id, chunk_index, content, char_count FROM knowledge_chunks WHERE document_id = ? ORDER BY chunk_index'
  ).all(id)

  return c.json({ ...doc, chunks })
})

// ── PUT /:id — Update metadata ──
knowledgeRouter.put('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()
  const { title, tags, status } = body as { title?: string; tags?: string[]; status?: string }

  const existing = db.prepare('SELECT id FROM knowledge_documents WHERE id = ?').get(id)
  if (!existing) return c.json({ error: 'Document not found' }, 404)

  if (title) {
    db.prepare("UPDATE knowledge_documents SET title = ?, updated_at = datetime('now') WHERE id = ?").run(title, id)
  }
  if (tags) {
    db.prepare("UPDATE knowledge_documents SET tags = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(tags), id)
  }
  if (status) {
    db.prepare("UPDATE knowledge_documents SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id)
  }

  const doc = db.prepare('SELECT * FROM knowledge_documents WHERE id = ?').get(id)
  return c.json(doc)
})

// ── DELETE /:id — Delete document + chunks + Qdrant points ──
knowledgeRouter.delete('/:id', async (c) => {
  const id = c.req.param('id')

  const existing = db.prepare('SELECT id FROM knowledge_documents WHERE id = ?').get(id)
  if (!existing) return c.json({ error: 'Document not found' }, 404)

  // Get chunk IDs for Qdrant cleanup
  const chunks = db.prepare('SELECT id FROM knowledge_chunks WHERE document_id = ?').all(id) as Array<{ id: string }>

  // Delete from Qdrant
  if (chunks.length > 0) {
    const vectorStore = getVectorStore()
    for (const chunk of chunks) {
      try {
        await vectorStore.delete(chunk.id)
      } catch {
        // Best effort — point may already be gone
      }
    }
  }

  // SQLite CASCADE handles chunks
  db.prepare('DELETE FROM knowledge_documents WHERE id = ?').run(id)

  return c.json({ success: true })
})

// ── POST /search — Vector search with metadata ──
knowledgeRouter.post('/search', async (c) => {
  try {
    const body = await c.req.json()
    const { query, tags, projectId, limit } = body as {
      query: string
      tags?: string[]
      projectId?: string
      limit?: number
    }

    if (!query) return c.json({ error: 'query is required' }, 400)

    const embedder = getEmbedder()
    const vector = await embedder.embed(query)

    // Build Qdrant filter
    const must: Array<Record<string, unknown>> = []
    if (projectId) {
      must.push({ key: 'project_id', match: { value: projectId } })
    }
    if (tags && tags.length > 0) {
      for (const tag of tags) {
        must.push({ key: 'tags', match: { any: [tag] } })
      }
    }

    const searchLimit = limit ?? 10

    const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vector,
        limit: searchLimit,
        with_payload: true,
        filter: must.length > 0 ? { must } : undefined,
      }),
      signal: AbortSignal.timeout(10000),
    })

    if (!res.ok) {
      const errText = await res.text()
      return c.json({ error: `Search failed: ${errText}` }, 500)
    }

    const data = (await res.json()) as {
      result?: Array<{ id: string; score: number; payload?: Record<string, unknown> }>
    }

    // Enrich with document metadata and track hits
    const docIds = new Set<string>()
    const results = (data.result ?? []).map((hit) => {
      const docId = hit.payload?.document_id as string | undefined
      if (docId) docIds.add(docId)
      return {
        score: hit.score,
        chunkId: hit.id,
        content: hit.payload?.content,
        documentId: docId,
        title: hit.payload?.title,
        chunkIndex: hit.payload?.chunk_index,
      }
    })

    // Increment hit counts
    if (docIds.size > 0) {
      const placeholders = [...docIds].map(() => '?').join(',')
      db.prepare(
        `UPDATE knowledge_documents SET hit_count = hit_count + 1, updated_at = datetime('now') WHERE id IN (${placeholders})`
      ).run(...docIds)
    }

    // Join document metadata
    const enriched = results.map((r) => {
      if (!r.documentId) return r
      const doc = db.prepare('SELECT id, title, tags, project_id, source, hit_count, status FROM knowledge_documents WHERE id = ?').get(r.documentId)
      return { ...r, document: doc }
    })

    return c.json({ query, results: enriched })
  } catch (error) {
    logger.error(`Knowledge search failed: ${String(error)}`)
    return c.json({ error: String(error) }, 500)
  }
})

// ── GET /tags — List unique tags ──
knowledgeRouter.get('/tags', (c) => {
  const rows = db.prepare(
    "SELECT tags FROM knowledge_documents WHERE status = 'active'"
  ).all() as Array<{ tags: string }>

  const tagSet = new Set<string>()
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.tags) as string[]
      for (const tag of parsed) tagSet.add(tag)
    } catch { /* skip malformed */ }
  }

  return c.json({ tags: [...tagSet].sort() })
})
