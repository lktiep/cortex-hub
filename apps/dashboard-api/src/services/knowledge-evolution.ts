/**
 * Knowledge Evolution Service (OpenSpace-inspired)
 *
 * Monitors knowledge document health and triggers evolution:
 * - FIX: Repairs docs with high fallback rates (in-place replacement)
 * - DERIVED: Merges similar captures into improved versions
 *
 * Anti-loop safeguards:
 * - Newly evolved docs need selection_count >= 5 before re-evaluation
 * - LLM confirmation gate before FIX evolution
 * - Tracks addressed docs to prevent re-processing in same cycle
 */

import { randomUUID } from 'crypto'
import { Embedder, VectorStore } from '@cortex/shared-mem9'
import type { EmbedderConfig, VectorStoreConfig } from '@cortex/shared-mem9'
import { db } from '../db/client.js'
import { createLogger } from '@cortex/shared-utils'

const logger = createLogger('knowledge-evolution')

const QDRANT_URL = process.env.QDRANT_URL ?? 'http://qdrant:6333'
const COLLECTION = 'knowledge'
const CHUNK_SIZE = 1500
const CHUNK_OVERLAP = 300

const CLIPROXY_URL = () =>
  process.env.LLM_PROXY_URL || process.env.CLIPROXY_URL || 'http://localhost:8317'

// Anti-loop: track docs addressed in current health check cycle
const addressedInCycle = new Set<string>()

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
  return new Embedder({
    provider: 'gemini' as const,
    apiKey: resolveGeminiApiKey(),
    model: process.env['MEM9_EMBEDDING_MODEL'] || 'gemini-embedding-001',
  } satisfies EmbedderConfig)
}

function getVectorStore(): VectorStore {
  return new VectorStore({ url: QDRANT_URL, collection: COLLECTION } satisfies VectorStoreConfig)
}

function chunkText(text: string): string[] {
  if (text.length <= CHUNK_SIZE) return [text]
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    let end = start + CHUNK_SIZE
    if (end < text.length) {
      const newlinePos = text.lastIndexOf('\n', end)
      if (newlinePos > start + CHUNK_SIZE / 2) end = newlinePos + 1
    }
    chunks.push(text.slice(start, end))
    start = end - CHUNK_OVERLAP
    if (start >= text.length) break
  }
  return chunks
}

// ── LLM: Confirm fix is needed + generate improved content ──

interface FixResult {
  should_fix: boolean
  improved_content: string
  change_summary: string
  reasoning: string
}

async function generateFix(doc: {
  id: string
  title: string
  content_preview: string
  fallback_rate: number
  completion_rate: number
}): Promise<FixResult | null> {
  // Get full content from chunks
  const chunks = db.prepare(
    'SELECT content FROM knowledge_chunks WHERE document_id = ? ORDER BY chunk_index'
  ).all(doc.id) as Array<{ content: string }>
  const fullContent = chunks.map(c => c.content).join('')

  // Get recent fallback contexts from usage log
  const recentFallbacks = db.prepare(`
    SELECT task_id, session_id, created_at FROM knowledge_usage_log
    WHERE document_id = ? AND action = 'fallback'
    ORDER BY created_at DESC LIMIT 5
  `).all(doc.id) as Array<{ task_id: string | null; session_id: string | null; created_at: string }>

  try {
    const res = await fetch(`${CLIPROXY_URL()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.RECIPE_LLM_MODEL || 'gemini-2.5-flash',
        messages: [
          {
            role: 'system',
            content: `You are a knowledge quality analyst. A knowledge document has poor metrics and may need fixing.

Analyze the document and decide:
1. Is the content fundamentally flawed, outdated, or misleading? (should_fix=true)
2. Or is it just niche/specialized and doesn't apply broadly? (should_fix=false)

If fixing, rewrite the content to be more accurate, actionable, and reliable.
Keep the same structure and intent but improve clarity, add missing steps, fix errors.

Output valid JSON only:
{
  "should_fix": boolean,
  "improved_content": "## Problem\\n...\\n## Steps\\n...",
  "change_summary": "what was changed and why",
  "reasoning": "analysis of why metrics are poor"
}`,
          },
          {
            role: 'user',
            content: `## Document: "${doc.title}"
Fallback rate: ${(doc.fallback_rate * 100).toFixed(0)}%
Completion rate: ${(doc.completion_rate * 100).toFixed(0)}%
Recent fallbacks: ${recentFallbacks.length}

## Content:
${fullContent}`,
          },
        ],
        temperature: 0.2,
        max_tokens: 3000,
      }),
      signal: AbortSignal.timeout(30000),
    })

    if (!res.ok) return null

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const raw = data.choices?.[0]?.message?.content?.trim()
    if (!raw) return null

    const jsonStr = raw.replace(/^```json?\s*/m, '').replace(/```\s*$/m, '').trim()
    return JSON.parse(jsonStr) as FixResult
  } catch (err) {
    logger.warn(`Fix generation failed: ${String(err).slice(0, 200)}`)
    return null
  }
}

// ── Apply FIX evolution: new doc replaces old ──

async function applyFix(oldDoc: { id: string; title: string; project_id: string | null; tags: string; category: string; generation: number; created_by_agent: string | null }, fix: FixResult): Promise<string> {
  const newDocId = `kdoc-${randomUUID().slice(0, 8)}`
  const tagList = JSON.parse(oldDoc.tags || '[]') as string[]
  if (!tagList.includes('auto-evolved')) tagList.push('auto-evolved')
  const contentPreview = fix.improved_content.slice(0, 500)
  const chunks = chunkText(fix.improved_content)
  const newGeneration = oldDoc.generation + 1

  // Insert new fixed doc
  db.prepare(
    `INSERT INTO knowledge_documents (id, title, source, source_agent_id, project_id, tags, content_preview, chunk_count, origin, category, generation, created_by_agent)
     VALUES (?, ?, 'agent', 'evolution-service', ?, ?, ?, ?, 'fixed', ?, ?, ?)`
  ).run(newDocId, oldDoc.title, oldDoc.project_id, JSON.stringify(tagList), contentPreview, chunks.length, oldDoc.category, newGeneration, oldDoc.created_by_agent)

  // Create lineage edge
  db.prepare(
    `INSERT OR IGNORE INTO knowledge_lineage (parent_id, child_id, relationship, change_summary)
     VALUES (?, ?, 'fixed', ?)`
  ).run(oldDoc.id, newDocId, fix.change_summary)

  // Archive old doc
  db.prepare("UPDATE knowledge_documents SET status = 'archived', updated_at = datetime('now') WHERE id = ?").run(oldDoc.id)

  // Embed and store chunks for new doc
  const embedder = getEmbedder()
  const vectorStore = getVectorStore()

  try {
    const testVec = await embedder.embed('test')
    await vectorStore.ensureCollection(testVec.length)
  } catch (err) {
    logger.warn(`Embedding init failed: ${String(err).slice(0, 100)}`)
    return newDocId
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunkId = randomUUID()
    const chunkContent = chunks[i]!
    try {
      const vector = await embedder.embed(chunkContent)
      await vectorStore.upsert(chunkId, vector, {
        document_id: newDocId,
        chunk_index: i,
        tags: tagList,
        project_id: oldDoc.project_id ?? '',
        content: chunkContent.slice(0, 2000),
        title: oldDoc.title,
      })
      db.prepare(
        'INSERT INTO knowledge_chunks (id, document_id, chunk_index, content, char_count) VALUES (?, ?, ?, ?, ?)'
      ).run(chunkId, newDocId, i, chunkContent, chunkContent.length)
    } catch (err) {
      logger.warn(`Chunk ${i} embed failed for ${newDocId}: ${String(err).slice(0, 100)}`)
    }
  }

  logger.info(`Evolution FIX: ${oldDoc.id} → ${newDocId} "${oldDoc.title}" (gen ${newGeneration})`)
  return newDocId
}

// ── Public API: Health check — find and fix unhealthy knowledge ──

export interface HealthCheckResult {
  checked: number
  fixed: number
  skipped: number
  details: Array<{
    docId: string
    title: string
    action: 'fixed' | 'skipped' | 'confirmed_ok'
    newDocId?: string
    reason: string
  }>
}

export async function runHealthCheck(): Promise<HealthCheckResult> {
  addressedInCycle.clear()

  const result: HealthCheckResult = { checked: 0, fixed: 0, skipped: 0, details: [] }

  // Find unhealthy docs: high fallback or low completion, with enough data
  const unhealthy = db.prepare(`
    SELECT id, title, content_preview, project_id, tags, category, generation, created_by_agent,
           selection_count, applied_count, completion_count, fallback_count,
           CAST(fallback_count AS REAL) / NULLIF(selection_count, 0) as fallback_rate,
           CAST(completion_count AS REAL) / NULLIF(applied_count, 0) as completion_rate
    FROM knowledge_documents
    WHERE status = 'active'
      AND selection_count >= 5
      AND (
        CAST(fallback_count AS REAL) / NULLIF(selection_count, 0) > 0.4
        OR CAST(completion_count AS REAL) / NULLIF(applied_count, 0) < 0.35
      )
    ORDER BY fallback_count DESC
    LIMIT 5
  `).all() as Array<Record<string, unknown>>

  for (const doc of unhealthy) {
    result.checked++
    const docId = doc.id as string

    if (addressedInCycle.has(docId)) {
      result.skipped++
      result.details.push({ docId, title: doc.title as string, action: 'skipped', reason: 'Already addressed in this cycle' })
      continue
    }
    addressedInCycle.add(docId)

    const fix = await generateFix({
      id: docId,
      title: doc.title as string,
      content_preview: doc.content_preview as string,
      fallback_rate: (doc.fallback_rate as number) ?? 0,
      completion_rate: (doc.completion_rate as number) ?? 0,
    })

    if (!fix || !fix.should_fix) {
      result.skipped++
      result.details.push({
        docId,
        title: doc.title as string,
        action: 'confirmed_ok',
        reason: fix?.reasoning ?? 'LLM analysis unavailable',
      })
      continue
    }

    const newDocId = await applyFix(
      {
        id: docId,
        title: doc.title as string,
        project_id: doc.project_id as string | null,
        tags: doc.tags as string,
        category: doc.category as string,
        generation: doc.generation as number,
        created_by_agent: doc.created_by_agent as string | null,
      },
      fix,
    )

    result.fixed++
    result.details.push({
      docId,
      title: doc.title as string,
      action: 'fixed',
      newDocId,
      reason: fix.change_summary,
    })
  }

  logger.info(`Health check: ${result.checked} checked, ${result.fixed} fixed, ${result.skipped} skipped`)
  return result
}
