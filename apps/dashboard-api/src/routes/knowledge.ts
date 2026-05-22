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
const CLUSTER_COLLECTION = 'knowledge_clusters'
const CHUNK_SIZE = 1500
const CHUNK_OVERLAP = 300
const CLUSTER_THRESHOLD = 500   // enable clustering when docs exceed this
const CLUSTER_SIM_THRESHOLD = 0.75  // cosine similarity to join existing cluster

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
  // EMBEDDING_PROVIDER=local switches to in-process @xenova/transformers
  // (no network, ~200MB RAM, ~10-50ms/text). Default: gemini.
  const provider = (process.env['EMBEDDING_PROVIDER'] || 'local') as 'gemini' | 'local'
  const config: EmbedderConfig = provider === 'local'
    ? {
        provider: 'local' as const,
        apiKey: '',
        model: process.env['LOCAL_EMBEDDING_MODEL'] || 'Xenova/all-MiniLM-L6-v2',
      }
    : {
        provider: 'gemini' as const,
        apiKey: resolveGeminiApiKey(),
        model: process.env['MEM9_EMBEDDING_MODEL'] || 'gemini-embedding-001',
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

// ── Hierarchical clustering helpers (zero LLM, pure vector math) ──

async function ensureClusterCollection(vectorSize: number): Promise<void> {
  try {
    const check = await fetch(`${QDRANT_URL}/collections/${CLUSTER_COLLECTION}`, {
      signal: AbortSignal.timeout(3000),
    })
    if (check.ok) return
  } catch { /* doesn't exist yet */ }

  await fetch(`${QDRANT_URL}/collections/${CLUSTER_COLLECTION}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vectors: { size: vectorSize, distance: 'Cosine' },
    }),
    signal: AbortSignal.timeout(5000),
  })
}

async function assignCluster(vector: number[], docId: string, projectId: string | null): Promise<string | null> {
  // Search existing cluster centroids for this project
  const filter = projectId
    ? { must: [{ key: 'project_id', match: { value: projectId } }] }
    : undefined

  try {
    const res = await fetch(`${QDRANT_URL}/collections/${CLUSTER_COLLECTION}/points/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vector, limit: 1, with_payload: true, filter }),
      signal: AbortSignal.timeout(5000),
    })

    if (res.ok) {
      const data = (await res.json()) as { result?: Array<{ id: string; score: number; payload?: Record<string, unknown> }> }
      const best = data.result?.[0]

      if (best && best.score >= CLUSTER_SIM_THRESHOLD) {
        // Join existing cluster
        const clusterId = best.payload?.cluster_id as string ?? best.id as string
        return clusterId
      }
    }
  } catch { /* cluster collection may not exist yet */ }

  // Create new cluster with this document's embedding as centroid
  const clusterId = `cluster-${randomUUID().slice(0, 8)}`
  try {
    await ensureClusterCollection(vector.length)
    await fetch(`${QDRANT_URL}/collections/${CLUSTER_COLLECTION}/points`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        points: [{
          id: clusterId,
          vector,
          payload: {
            cluster_id: clusterId,
            project_id: projectId ?? '',
            seed_doc_id: docId,
            doc_count: 1,
          },
        }],
      }),
      signal: AbortSignal.timeout(5000),
    })
  } catch (err) {
    logger.warn(`[cluster] Failed to create cluster: ${(err as Error).message}`)
    return null
  }

  return clusterId
}

async function hierarchicalSearch(
  vector: number[],
  fetchLimit: number,
  filter?: { must: Array<Record<string, unknown>> },
): Promise<Array<{ id: string; score: number; payload?: Record<string, unknown> }> | null> {
  // Stage 1: Find top clusters
  try {
    const clusterFilter = filter ? {
      must: filter.must.filter(f => 'key' in f && (f as { key: string }).key === 'project_id'),
    } : undefined

    const clusterRes = await fetch(`${QDRANT_URL}/collections/${CLUSTER_COLLECTION}/points/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vector,
        limit: 5,
        with_payload: true,
        filter: clusterFilter?.must?.length ? clusterFilter : undefined,
      }),
      signal: AbortSignal.timeout(5000),
    })

    if (!clusterRes.ok) return null

    const clusterData = (await clusterRes.json()) as {
      result?: Array<{ id: string; score: number; payload?: Record<string, unknown> }>
    }
    const clusters = clusterData.result ?? []
    if (clusters.length === 0) return null

    const clusterIds = clusters.map(c => c.payload?.cluster_id as string ?? c.id)

    // Stage 2: Search documents within those clusters
    const docFilter: Array<Record<string, unknown>> = [
      { key: 'cluster_id', match: { any: clusterIds } },
    ]
    if (filter?.must) {
      for (const f of filter.must) {
        docFilter.push(f)
      }
    }

    const docRes = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vector,
        limit: fetchLimit,
        with_payload: true,
        filter: { must: docFilter },
      }),
      signal: AbortSignal.timeout(10000),
    })

    if (!docRes.ok) return null

    const docData = (await docRes.json()) as {
      result?: Array<{ id: string; score: number; payload?: Record<string, unknown> }>
    }
    return docData.result ?? null
  } catch (err) {
    logger.warn(`[search] Hierarchical search failed, falling back to flat: ${(err as Error).message}`)
    return null
  }
}

// ── GET / — List documents ──
knowledgeRouter.get('/', (c) => {
  const tag = c.req.query('tag')
  const projectId = c.req.query('projectId')
  const status = c.req.query('status') ?? 'active'
  const limit = Number(c.req.query('limit') ?? 500)
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
    const { title, content, tags, projectId, sourceAgentId, source, origin, category, sourceTaskId, parentDocId, hallType, validFrom } = body as {
      title: string
      content: string
      tags?: string[]
      projectId?: string
      sourceAgentId?: string
      source?: string
      origin?: string
      category?: string
      sourceTaskId?: string
      parentDocId?: string
      hallType?: 'fact' | 'event' | 'discovery' | 'preference' | 'advice' | 'general'
      validFrom?: string
    }

    if (!title || !content) {
      return c.json({ error: 'title and content are required' }, 400)
    }

    const docId = `kdoc-${randomUUID().slice(0, 8)}`
    const tagList = tags ?? []
    const contentPreview = content.slice(0, 500)

    // Normalize project_id: resolve proj-* to slug, and lowercase
    let normalizedProjectId = projectId ?? null
    if (normalizedProjectId) {
      if (normalizedProjectId.startsWith('proj-')) {
        // Resolve project ID to slug for consistent grouping
        const proj = db.prepare('SELECT slug FROM projects WHERE id = ?').get(normalizedProjectId) as { slug: string } | undefined
        if (proj?.slug) normalizedProjectId = proj.slug
      }
      normalizedProjectId = normalizedProjectId.toLowerCase()
    }

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
      const stack = (err as Error)?.stack ?? ''
      logger.error(`[knowledge] Embedding test failed: ${String(err)}\n${stack}`)
      return c.json({
        error: `Embedding failed: ${String(err).slice(0, 200)}`,
        stack: stack.slice(0, 1500),
      }, 500)
    }

    await vectorStore.ensureCollection(vectorSize)

    // Resolve generation for derived docs
    let generation = 0
    if (parentDocId) {
      const parent = db.prepare('SELECT generation FROM knowledge_documents WHERE id = ?').get(parentDocId) as { generation: number } | undefined
      generation = (parent?.generation ?? 0) + 1
    }

    // Insert document with evolution metadata + MemPalace-inspired hierarchy/temporal fields
    db.prepare(
      `INSERT INTO knowledge_documents (id, title, source, source_agent_id, project_id, tags, content_preview, chunk_count, origin, category, generation, source_task_id, created_by_agent, hall_type, valid_from)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(docId, title, source ?? 'manual', sourceAgentId ?? null, normalizedProjectId, JSON.stringify(tagList), contentPreview, chunks.length, origin ?? 'manual', category ?? 'general', generation, sourceTaskId ?? null, sourceAgentId ?? null, hallType ?? 'general', validFrom ?? null)

    // Create lineage edge if this is derived/fixed from a parent
    if (parentDocId) {
      const relationship = origin === 'fixed' ? 'fixed' : 'derived'
      db.prepare(
        `INSERT OR IGNORE INTO knowledge_lineage (parent_id, child_id, relationship, change_summary)
         VALUES (?, ?, ?, ?)`
      ).run(parentDocId, docId, relationship, `${relationship} from ${parentDocId}`)

      // If fixed, archive the parent
      if (origin === 'fixed') {
        db.prepare("UPDATE knowledge_documents SET status = 'archived', updated_at = datetime('now', 'localtime') WHERE id = ?").run(parentDocId)
      }
    }

    // Embed and store each chunk (with cluster assignment)
    let clusterId: string | null = null
    for (let i = 0; i < chunks.length; i++) {
      const chunkId = randomUUID()
      const chunkContent = chunks[i]!

      try {
        const vector = await embedder.embed(chunkContent)

        // Assign cluster on first chunk (representative of the document)
        if (i === 0) {
          clusterId = await assignCluster(vector, docId, normalizedProjectId).catch(() => null)
        }

        await vectorStore.upsert(chunkId, vector, {
          document_id: docId,
          chunk_index: i,
          tags: tagList,
          project_id: normalizedProjectId ?? '',
          content: chunkContent.slice(0, 2000),
          title,
          cluster_id: clusterId ?? '',
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

// ── GET /recipe-stats — Recipe system health dashboard ──
// MUST be before /:id to avoid being caught by the parameterized route
knowledgeRouter.get('/recipe-stats', (c) => {
  // Ensure recipe_capture_log table exists (may not on first deploy)
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS recipe_capture_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL CHECK(source IN ('task', 'session')),
      source_id TEXT,
      agent_id TEXT,
      project_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('attempt', 'captured', 'derived', 'skipped', 'error')),
      title TEXT,
      doc_id TEXT,
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )`)
  } catch { /* already exists */ }

  try {
    const captureStats = db.prepare(`
      SELECT status, COUNT(*) as count FROM recipe_capture_log
      GROUP BY status
    `).all() as Array<{ status: string; count: number }>

    const recentCaptures = db.prepare(`
      SELECT * FROM recipe_capture_log
      WHERE created_at > datetime('now', '-7 days')
      ORDER BY created_at DESC
      LIMIT 20
    `).all()

    const qualityDist = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN selection_count > 0 THEN 1 ELSE 0 END) as selected,
        SUM(CASE WHEN completion_count > 0 THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN fallback_count > 0 THEN 1 ELSE 0 END) as fallbacked,
        SUM(selection_count) as totalSelections,
        SUM(completion_count) as totalCompletions,
        SUM(fallback_count) as totalFallbacks,
        AVG(CASE WHEN selection_count >= 3 THEN CAST(completion_count AS REAL) / NULLIF(selection_count, 0) END) as avgEffectiveRate
      FROM knowledge_documents
      WHERE status = 'active'
    `).get() as Record<string, number | null>

    const originDist = db.prepare(`
      SELECT origin, COUNT(*) as count FROM knowledge_documents
      WHERE status = 'active'
      GROUP BY origin
    `).all() as Array<{ origin: string; count: number }>

    const lineageCount = db.prepare('SELECT COUNT(*) as count FROM knowledge_lineage').get() as { count: number }

    const usageActivity = db.prepare(`
      SELECT action, COUNT(*) as count FROM knowledge_usage_log
      WHERE created_at > datetime('now', '-7 days')
      GROUP BY action
    `).all() as Array<{ action: string; count: number }>

    return c.json({
      capture: {
        stats: Object.fromEntries(captureStats.map(s => [s.status, s.count])),
        recent: recentCaptures,
      },
      quality: qualityDist,
      origins: Object.fromEntries(originDist.map(o => [o.origin, o.count])),
      lineage: lineageCount.count,
      usage: Object.fromEntries(usageActivity.map(u => [u.action, u.count])),
    })
  } catch (error) {
    logger.error(`Recipe stats failed: ${String(error)}`)
    return c.json({
      capture: { stats: {}, recent: [] },
      quality: { total: 0, selected: 0, completed: 0, fallbacked: 0, totalSelections: 0, totalCompletions: 0, totalFallbacks: 0, avgEffectiveRate: null },
      origins: {},
      lineage: 0,
      usage: {},
    })
  }
})

// ── GET /timeline — Knowledge timeline (temporal exploration) ──
// MemPalace-inspired: browse facts ordered by valid_from
// MUST be before /:id to avoid being caught by the parameterized route
knowledgeRouter.get('/timeline', (c) => {
  const projectId = c.req.query('projectId')
  const hallType = c.req.query('hallType')

  let sql = `SELECT id, title, hall_type, valid_from, invalidated_at, superseded_by, content_preview
             FROM knowledge_documents WHERE status = 'active'`
  const params: unknown[] = []
  if (projectId) { sql += ' AND project_id = ?'; params.push(projectId) }
  if (hallType) { sql += ' AND hall_type = ?'; params.push(hallType) }
  sql += ' ORDER BY COALESCE(valid_from, created_at) DESC LIMIT 100'

  try {
    const rows = db.prepare(sql).all(...params)
    return c.json({ timeline: rows, count: rows.length })
  } catch (error) {
    logger.error(`Timeline query failed: ${String(error)}`)
    return c.json({ timeline: [], count: 0 })
  }
})

// ── POST /:id/invalidate — Mark a document as superseded ──
// MemPalace-inspired temporal validity
// MUST be before /:id to avoid being caught by the parameterized route
knowledgeRouter.post('/:id/invalidate', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const { supersededBy } = body as { supersededBy?: string }

  try {
    const result = db.prepare(
      `UPDATE knowledge_documents
       SET invalidated_at = datetime('now', 'localtime'), superseded_by = COALESCE(?, superseded_by)
       WHERE id = ? AND status = 'active'`
    ).run(supersededBy ?? null, id)

    if (result.changes === 0) {
      return c.json({ error: 'Document not found or already inactive' }, 404)
    }
    return c.json({ success: true, id, invalidated_at: new Date().toISOString() })
  } catch (error) {
    logger.error(`Invalidate failed: ${String(error)}`)
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
    db.prepare("UPDATE knowledge_documents SET title = ?, updated_at = datetime('now', 'localtime') WHERE id = ?").run(title, id)
  }
  if (tags) {
    db.prepare("UPDATE knowledge_documents SET tags = ?, updated_at = datetime('now', 'localtime') WHERE id = ?").run(JSON.stringify(tags), id)
  }
  if (status) {
    db.prepare("UPDATE knowledge_documents SET status = ?, updated_at = datetime('now', 'localtime') WHERE id = ?").run(status, id)
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
// ── Hybrid re-ranking helpers ────────────────────────────────────────
// Tiny English stopword list — empirically chosen, kept short to avoid
// stripping meaningful terms in code/conversation queries.
const STOPWORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with','by',
  'is','was','are','were','be','been','being','have','has','had','do','does','did',
  'i','you','he','she','it','we','they','them','this','that','these','those',
  'what','when','where','who','why','how','can','could','would','should','will',
  'my','your','his','her','its','our','their','me','him','us',
])

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t))
}

// IDF-weighted lexical and preference query detection were tested in
// benchmarks but performed worse than simple keyword overlap:
//   - IDF + pref-detect: 95.8% R@5 (vs 96.0% additive)
//   - Kept as comments for future reference if re-tuning is needed

knowledgeRouter.post('/search', async (c) => {
  try {
    const body = await c.req.json()
    const { query, tags, projectId, limit, hallType, asOf } = body as {
      query: string
      tags?: string[]
      projectId?: string
      limit?: number
      hallType?: 'fact' | 'event' | 'discovery' | 'preference' | 'advice' | 'general'
      asOf?: string
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
    // Overfetch for hybrid re-ranking — score more candidates, then trim
    const fetchLimit = Math.max(searchLimit * 5, 50)

    // Try hierarchical search first (two-stage: clusters → documents)
    // Falls back to flat search if clustering not available or corpus is small
    const filter = must.length > 0 ? { must } : undefined
    let searchResults = await hierarchicalSearch(vector, fetchLimit, filter)

    if (!searchResults) {
      // Flat search fallback
      const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vector,
          limit: fetchLimit,
          with_payload: true,
          filter: filter,
        }),
        signal: AbortSignal.timeout(10000),
      })

      if (!res.ok) {
        const errText = await res.text()
        return c.json({ error: `Search failed: ${errText}` }, 500)
      }

      const flatData = (await res.json()) as {
        result?: Array<{ id: string; score: number; payload?: Record<string, unknown> }>
      }
      searchResults = flatData.result ?? []
    }

    const data = { result: searchResults }

    // Enrich with document metadata, quality metrics, and re-rank
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

    // Increment hit counts + selection counts
    if (docIds.size > 0) {
      const placeholders = [...docIds].map(() => '?').join(',')
      db.prepare(
        `UPDATE knowledge_documents SET hit_count = hit_count + 1, selection_count = selection_count + 1, updated_at = datetime('now', 'localtime') WHERE id IN (${placeholders})`
      ).run(...docIds)
    }

    // Pre-tokenize query for lexical scoring
    const queryTokens = tokenize(query)

    // Join document metadata + quality metrics + lexical, then re-rank
    const now = Date.now()
    const enriched = results.map((r) => {
      if (!r.documentId) return r
      const doc = db.prepare(
        `SELECT id, title, tags, project_id, source, hit_count, status, content_preview,
                selection_count, applied_count, completion_count, fallback_count,
                origin, category, generation, created_by_agent, updated_at,
                hall_type, valid_from, invalidated_at, superseded_by
         FROM knowledge_documents WHERE id = ?`
      ).get(r.documentId) as Record<string, unknown> | undefined
      if (!doc) return r

      // MemPalace-inspired filters (post-vector filter)
      if (hallType && doc.hall_type !== hallType) return null
      if (asOf) {
        const vf = doc.valid_from as string | null | undefined
        const ia = doc.invalidated_at as string | null | undefined
        if (vf && vf > asOf) return null
        if (ia && ia <= asOf) return null
      }

      // Compute quality metrics (OpenSpace-inspired)
      const sel = (doc.selection_count as number) || 0
      const app = (doc.applied_count as number) || 0
      const comp = (doc.completion_count as number) || 0
      const fall = (doc.fallback_count as number) || 0
      const quality = {
        selectionCount: sel,
        appliedCount: app,
        completionCount: comp,
        fallbackCount: fall,
        appliedRate: sel > 0 ? app / sel : 0,
        completionRate: app > 0 ? comp / app : 0,
        effectiveRate: sel > 0 ? comp / sel : 0,
        fallbackRate: sel > 0 ? fall / sel : 0,
      }

      // Compute lexical score (simple keyword overlap — beats IDF in benchmarks)
      const lexicalCorpus = [
        String(doc.title ?? ''),
        String(r.content ?? ''),
        String(doc.content_preview ?? ''),
      ].join(' ')
      const contentLower = lexicalCorpus.toLowerCase()
      let lexMatches = 0
      for (const token of queryTokens) {
        if (contentLower.includes(token)) lexMatches++
      }
      const lex = queryTokens.length > 0 ? lexMatches / queryTokens.length : 0

      // Recency decay over 90 days
      const updatedAt = doc.updated_at ? new Date(doc.updated_at as string).getTime() : 0
      const daysSinceUpdate = Math.max(0, (now - updatedAt) / (1000 * 60 * 60 * 24))
      const recencyScore = Math.max(0, 1 - daysSinceUpdate / 90)
      const vectorScore = r.score

      // Hybrid weighting (additive — best in LongMemEval-S 500 at 96.0% R@5):
      //   vector  × 0.55  (semantic match — primary signal)
      //   lexical × 0.35  (keyword overlap — +2.2 pts vs pure vector)
      //   quality × 0.05  (only when sel >= 3)
      //   recency × 0.05
      //
      // Tested alternatives (all on full 500 questions):
      //   multiplicative (vec*(1+lex*0.4)):  95.2% — better pref, worse temporal
      //   IDF-weighted + pref-detect:        95.8% — marginally worse overall
      //   pure vector:                       93.8% — baseline without lexical
      const qualityBonus = sel >= 3 ? quality.effectiveRate : 0
      const hybridScore =
        vectorScore * 0.55 +
        lex * 0.35 +
        qualityBonus * 0.05 +
        recencyScore * 0.05

      // Flag high-fallback docs
      const deprecated = sel >= 5 && quality.fallbackRate > 0.5

      return {
        ...r,
        score: hybridScore,
        vectorScore,
        lexicalScore: lex,
        quality,
        origin: doc.origin,
        category: doc.category,
        deprecated,
        document: doc,
      }
    })

    // Drop entries filtered out by hallType/asOf, re-sort, take top searchLimit
    const filtered = enriched.filter((r): r is NonNullable<typeof r> => r !== null)
    filtered.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    const trimmed = filtered.slice(0, searchLimit)

    return c.json({ query, results: trimmed })
  } catch (error) {
    logger.error(`Knowledge search failed: ${String(error)}`)
    return c.json({ error: String(error) }, 500)
  }
})

// ── POST /migrate-clusters — Assign cluster_id to existing docs (no re-embed) ──
knowledgeRouter.post('/migrate-clusters', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const { projectId } = body as { projectId?: string }

    // Scroll through ALL points in knowledge collection
    let offset: string | null = null
    let migrated = 0
    let clustersCreated = 0
    let totalPoints = 0

    const scrollFilter = projectId
      ? { must: [{ key: 'project_id', match: { value: projectId } }] }
      : undefined

    // Get vector size from first point
    let vectorSize = 384

    while (true) {
      const scrollBody: Record<string, unknown> = {
        limit: 100,
        with_payload: true,
        with_vectors: true,
        filter: scrollFilter,
      }
      if (offset) scrollBody.offset = offset

      const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/scroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scrollBody),
        signal: AbortSignal.timeout(30000),
      })

      if (!res.ok) break

      const data = (await res.json()) as {
        result?: {
          points?: Array<{
            id: string
            vector?: number[]
            payload?: Record<string, unknown>
          }>
          next_page_offset?: string | null
        }
      }

      const points = data.result?.points ?? []
      if (points.length === 0) break

      for (const point of points) {
        totalPoints++
        const existingCluster = point.payload?.cluster_id as string | undefined
        if (existingCluster && existingCluster.length > 0) continue // already has cluster

        const vector = point.vector
        if (!vector || !Array.isArray(vector)) continue

        vectorSize = vector.length
        const pointProjectId = (point.payload?.project_id as string) || null
        const docId = (point.payload?.document_id as string) || point.id

        const clusterId = await assignCluster(vector, docId, pointProjectId).catch(() => null)
        if (!clusterId) continue

        // Update point payload with cluster_id
        await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/payload`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            payload: { cluster_id: clusterId },
            points: [point.id],
          }),
          signal: AbortSignal.timeout(5000),
        }).catch(() => {})

        if (clusterId.startsWith('cluster-')) clustersCreated++
        migrated++
      }

      offset = data.result?.next_page_offset ?? null
      if (!offset) break

      logger.info(`[migrate-clusters] Progress: ${totalPoints} points scanned, ${migrated} migrated`)
    }

    return c.json({
      success: true,
      totalPoints,
      migrated,
      clustersCreated,
      alreadyClustered: totalPoints - migrated,
    })
  } catch (error) {
    logger.error(`Migrate clusters failed: ${String(error)}`)
    return c.json({ error: String(error) }, 500)
  }
})

// ── GET /lineage/:id — Full DAG traversal ──
knowledgeRouter.get('/lineage/:id', (c) => {
  const id = c.req.param('id')
  const doc = db.prepare('SELECT id FROM knowledge_documents WHERE id = ?').get(id)
  if (!doc) return c.json({ error: 'Document not found' }, 404)

  // BFS traversal — collect all ancestors and descendants
  const nodes = new Map<string, Record<string, unknown>>()
  const edges: Array<{ parentId: string; childId: string; relationship: string; changeSummary: string | null }> = []
  const queue = [id]
  const visited = new Set<string>()

  while (queue.length > 0) {
    const current = queue.shift()!
    if (visited.has(current)) continue
    visited.add(current)

    const node = db.prepare(
      'SELECT id, title, origin, category, generation, status, selection_count, completion_count, fallback_count, created_at FROM knowledge_documents WHERE id = ?'
    ).get(current) as Record<string, unknown> | undefined
    if (node) nodes.set(current, node)

    // Parents
    const parents = db.prepare(
      'SELECT parent_id, child_id, relationship, change_summary FROM knowledge_lineage WHERE child_id = ?'
    ).all(current) as Array<{ parent_id: string; child_id: string; relationship: string; change_summary: string | null }>
    for (const edge of parents) {
      edges.push({ parentId: edge.parent_id, childId: edge.child_id, relationship: edge.relationship, changeSummary: edge.change_summary })
      if (!visited.has(edge.parent_id)) queue.push(edge.parent_id)
    }

    // Children
    const children = db.prepare(
      'SELECT parent_id, child_id, relationship, change_summary FROM knowledge_lineage WHERE parent_id = ?'
    ).all(current) as Array<{ parent_id: string; child_id: string; relationship: string; change_summary: string | null }>
    for (const edge of children) {
      edges.push({ parentId: edge.parent_id, childId: edge.child_id, relationship: edge.relationship, changeSummary: edge.change_summary })
      if (!visited.has(edge.child_id)) queue.push(edge.child_id)
    }
  }

  // Dedup edges
  const edgeSet = new Set<string>()
  const uniqueEdges = edges.filter((e) => {
    const key = `${e.parentId}-${e.childId}`
    if (edgeSet.has(key)) return false
    edgeSet.add(key)
    return true
  })

  return c.json({
    rootId: id,
    nodes: [...nodes.values()],
    edges: uniqueEdges,
  })
})

// ── GET /token-savings — Compare tasks with vs without knowledge ──
knowledgeRouter.get('/token-savings', (c) => {
  // Tasks that used knowledge (have usage log entries with action='completed')
  const withKnowledge = db.prepare(`
    SELECT AVG(kul.token_count) as avgTokens, COUNT(*) as count
    FROM knowledge_usage_log kul
    WHERE kul.action = 'completed' AND kul.token_count > 0
  `).get() as { avgTokens: number | null; count: number }

  // Tasks that used knowledge but fell back
  const withFallback = db.prepare(`
    SELECT AVG(kul.token_count) as avgTokens, COUNT(*) as count
    FROM knowledge_usage_log kul
    WHERE kul.action = 'fallback' AND kul.token_count > 0
  `).get() as { avgTokens: number | null; count: number }

  // Knowledge docs by origin
  const byOrigin = db.prepare(`
    SELECT origin, COUNT(*) as count,
           AVG(CASE WHEN selection_count > 0 THEN CAST(completion_count AS REAL) / selection_count ELSE 0 END) as avgEffectiveRate
    FROM knowledge_documents WHERE status = 'active'
    GROUP BY origin
  `).all()

  return c.json({
    withKnowledge: { avgTokens: withKnowledge.avgTokens ?? 0, taskCount: withKnowledge.count },
    withFallback: { avgTokens: withFallback.avgTokens ?? 0, taskCount: withFallback.count },
    byOrigin,
    savingsPercent: withKnowledge.avgTokens && withFallback.avgTokens
      ? Math.round((1 - withKnowledge.avgTokens / withFallback.avgTokens) * 100)
      : null,
  })
})

// ── POST /track-feedback — Auto-track knowledge completion/fallback from quality reports ──
knowledgeRouter.post('/track-feedback', async (c) => {
  try {
    const body = await c.req.json()
    const { action, gate_name } = body as { action: 'completed' | 'fallback'; gate_name?: string }

    if (!action || !['completed', 'fallback'].includes(action)) {
      return c.json({ error: 'action must be completed or fallback' }, 400)
    }

    // Find recently searched knowledge docs (last hour) — these are the ones that were "used"
    const recentSearched = db.prepare(`
      SELECT DISTINCT kd.id FROM knowledge_documents kd
      WHERE kd.status = 'active'
        AND kd.selection_count > 0
        AND kd.updated_at > datetime('now', '-1 hour')
      ORDER BY kd.updated_at DESC
      LIMIT 10
    `).all() as Array<{ id: string }>

    if (recentSearched.length === 0) {
      return c.json({ updated: 0, message: 'No recently searched knowledge to track' })
    }

    const column = action === 'completed' ? 'completion_count' : 'fallback_count'
    let updated = 0

    for (const doc of recentSearched) {
      db.prepare(
        `UPDATE knowledge_documents SET ${column} = ${column} + 1, updated_at = datetime('now', 'localtime') WHERE id = ?`
      ).run(doc.id)

      // Log usage
      db.prepare(
        `INSERT INTO knowledge_usage_log (document_id, action) VALUES (?, ?)`
      ).run(doc.id, action)

      updated++
    }

    logger.info(`[track-feedback] ${action}: updated ${updated} docs (gate: ${gate_name ?? 'unknown'})`)
    return c.json({ updated, action })
  } catch (error) {
    logger.error(`Track feedback failed: ${String(error)}`)
    return c.json({ error: String(error) }, 500)
  }
})

// ── POST /health-check — Find and fix unhealthy knowledge docs (OpenSpace-inspired) ──
knowledgeRouter.post('/health-check', async (c) => {
  try {
    const { runHealthCheck } = await import('../services/knowledge-evolution.js')
    const result = await runHealthCheck()
    return c.json(result)
  } catch (error) {
    logger.error(`Health check failed: ${String(error)}`)
    return c.json({ error: String(error) }, 500)
  }
})

// ── GET /recipe-stats — Recipe system health dashboard ──
// ── GET /tags — List unique tags ──
knowledgeRouter.get('/tags', (c) => {
  const rows = db.prepare(
    "SELECT tags FROM knowledge_documents WHERE status = 'active'"
  ).all() as Array<{ tags: string }>

  const tagSet = new Set<string>()
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.tags) as string[]
      for (const tag of parsed) {
        // Skip internal project: tags — those are structural, not content tags
        if (!tag.startsWith('project:')) tagSet.add(tag)
      }
    } catch { /* skip malformed */ }
  }

  return c.json({ tags: [...tagSet].sort() })
})
