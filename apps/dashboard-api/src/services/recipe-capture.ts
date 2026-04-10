/**
 * Recipe Capture Service (OpenSpace-inspired)
 *
 * Automatically extracts reusable patterns ("recipes") from completed tasks
 * and sessions. Stores them as knowledge documents with origin='captured'
 * or origin='derived' (when similar to existing knowledge).
 *
 * Two entry points:
 * - captureFromTask(): called after conductor task completion
 * - captureFromSession(): called after session_end with a summary
 */

import { randomUUID } from 'crypto'
import { Embedder, VectorStore } from '@cortex/shared-mem9'
import type { EmbedderConfig, VectorStoreConfig } from '@cortex/shared-mem9'
import { db } from '../db/client.js'
import { createLogger } from '@cortex/shared-utils'

const logger = createLogger('recipe-capture')

function logCaptureAttempt(data: {
  source: 'task' | 'session'
  sourceId: string | null
  agentId: string | null
  projectId: string | null
  status: 'attempt' | 'captured' | 'derived' | 'skipped' | 'error'
  title?: string
  docId?: string
  errorMessage?: string
}) {
  try {
    db.prepare(
      `INSERT INTO recipe_capture_log (source, source_id, agent_id, project_id, status, title, doc_id, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(data.source, data.sourceId, data.agentId, data.projectId, data.status, data.title ?? null, data.docId ?? null, data.errorMessage ?? null)
  } catch { /* DB not ready */ }
}

const QDRANT_URL = process.env.QDRANT_URL ?? 'http://qdrant:6333'
const COLLECTION = 'knowledge'
const CHUNK_SIZE = 1500
const CHUNK_OVERLAP = 300

const CLIPROXY_URL = () =>
  process.env.LLM_PROXY_URL || process.env.CLIPROXY_URL || 'http://localhost:8317'

// Rate limit: max captures per hour
const RATE_LIMIT = 5
const captureTimestamps: number[] = []

function isRateLimited(): boolean {
  const oneHourAgo = Date.now() - 60 * 60 * 1000
  // Prune old entries
  while (captureTimestamps.length > 0 && captureTimestamps[0]! < oneHourAgo) {
    captureTimestamps.shift()
  }
  return captureTimestamps.length >= RATE_LIMIT
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
    model: process.env['MEM9_EMBEDDING_MODEL'] || 'gemini-embedding-exp-03-07',
  } satisfies EmbedderConfig)
}

function getVectorStore(): VectorStore {
  return new VectorStore({ url: QDRANT_URL, collection: COLLECTION } satisfies VectorStoreConfig)
}

// ── LLM call to analyze if execution is worth capturing ──

interface CaptureAnalysis {
  should_capture: boolean
  title: string
  content: string
  category: 'workflow' | 'tool_guide' | 'reference' | 'error_fix'
  tags: string[]
  reasoning: string
}

async function analyzeForCapture(context: string): Promise<CaptureAnalysis | null> {
  try {
    const res = await fetch(`${CLIPROXY_URL()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.RECIPE_LLM_MODEL || 'gemini-3.1-flash-lite-preview',
        messages: [
          {
            role: 'system',
            content: `You are an execution analyst. Analyze completed task data and decide if it contains a reusable pattern worth capturing as a knowledge recipe.

A recipe is worth capturing when:
- It solves a non-trivial problem with specific steps
- It contains a workflow that could help future similar tasks
- It documents a workaround or error fix that others might encounter
- It describes a multi-step process with clear dependencies

Do NOT capture:
- Trivial single-step operations
- Highly specific one-off tasks unlikely to recur
- Pure configuration with no transferable knowledge

Output valid JSON only:
{
  "should_capture": boolean,
  "title": "concise recipe title",
  "content": "## Problem\\n...\\n## Steps\\n1. ...\\n2. ...\\n## Notes\\n...",
  "category": "workflow|tool_guide|reference|error_fix",
  "tags": ["tag1", "tag2"],
  "reasoning": "why this is/isn't worth capturing"
}`,
          },
          { role: 'user', content: context },
        ],
        temperature: 0.1,
        max_tokens: 2000,
      }),
      signal: AbortSignal.timeout(30000),
    })

    if (!res.ok) {
      const errBody = await res.text().catch(() => 'unknown')
      logger.warn(`LLM call failed: HTTP ${res.status} ${res.statusText} — ${errBody.slice(0, 200)}`)
      return null
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const raw = data.choices?.[0]?.message?.content?.trim()
    if (!raw) return null

    // Extract JSON from possible markdown code block
    const jsonStr = raw.replace(/^```json?\s*/m, '').replace(/```\s*$/m, '').trim()
    return JSON.parse(jsonStr) as CaptureAnalysis
  } catch (err) {
    logger.warn(`Recipe analysis failed: ${String(err).slice(0, 200)}`)
    return null
  }
}

// ── Check similarity with existing knowledge docs ──

async function findSimilarDoc(
  content: string,
  projectId: string | null,
): Promise<{ docId: string; score: number } | null> {
  try {
    const embedder = getEmbedder()
    const vector = await embedder.embed(content.slice(0, 2000))

    const must: Array<Record<string, unknown>> = []
    if (projectId) {
      must.push({ key: 'project_id', match: { value: projectId } })
    }

    const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vector,
        limit: 1,
        with_payload: true,
        filter: must.length > 0 ? { must } : undefined,
      }),
      signal: AbortSignal.timeout(10000),
    })

    if (!res.ok) return null

    const data = (await res.json()) as {
      result?: Array<{ score: number; payload?: Record<string, unknown> }>
    }

    const top = data.result?.[0]
    if (!top || top.score < 0.85) return null

    const docId = top.payload?.document_id as string | undefined
    if (!docId) return null

    return { docId, score: top.score }
  } catch {
    return null
  }
}

// ── Store recipe as knowledge document ──

async function storeRecipe(recipe: CaptureAnalysis, opts: {
  projectId: string | null
  agentId: string | null
  sourceTaskId: string | null
  origin: 'captured' | 'derived'
  parentDocId: string | null
}): Promise<string> {
  const docId = `kdoc-${randomUUID().slice(0, 8)}`
  const tagList = [...(recipe.tags ?? []), 'auto-recipe']

  let generation = 0
  if (opts.parentDocId) {
    const parent = db.prepare('SELECT generation FROM knowledge_documents WHERE id = ?')
      .get(opts.parentDocId) as { generation: number } | undefined
    generation = (parent?.generation ?? 0) + 1
  }

  const contentPreview = recipe.content.slice(0, 500)
  const chunks = chunkText(recipe.content)

  // Insert document
  db.prepare(
    `INSERT INTO knowledge_documents (id, title, source, source_agent_id, project_id, tags, content_preview, chunk_count, origin, category, generation, source_task_id, created_by_agent)
     VALUES (?, ?, 'agent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    docId, recipe.title, opts.agentId, opts.projectId,
    JSON.stringify(tagList), contentPreview, chunks.length,
    opts.origin, recipe.category, generation, opts.sourceTaskId, opts.agentId,
  )

  // Create lineage edge if derived
  if (opts.parentDocId) {
    db.prepare(
      `INSERT OR IGNORE INTO knowledge_lineage (parent_id, child_id, relationship, change_summary)
       VALUES (?, ?, 'derived', ?)`
    ).run(opts.parentDocId, docId, `Derived from execution of task ${opts.sourceTaskId ?? 'unknown'}`)
  }

  // Embed and store chunks
  const embedder = getEmbedder()
  const vectorStore = getVectorStore()

  try {
    const testVec = await embedder.embed('test')
    await vectorStore.ensureCollection(testVec.length)
  } catch (err) {
    logger.warn(`Embedding init failed: ${String(err).slice(0, 100)}`)
    return docId
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunkId = randomUUID()
    const chunkContent = chunks[i]!
    try {
      const vector = await embedder.embed(chunkContent)
      await vectorStore.upsert(chunkId, vector, {
        document_id: docId,
        chunk_index: i,
        tags: tagList,
        project_id: opts.projectId ?? '',
        content: chunkContent.slice(0, 2000),
        title: recipe.title,
      })
      db.prepare(
        `INSERT INTO knowledge_chunks (id, document_id, chunk_index, content, char_count) VALUES (?, ?, ?, ?, ?)`
      ).run(chunkId, docId, i, chunkContent, chunkContent.length)
    } catch (err) {
      logger.warn(`Chunk ${i} embed failed: ${String(err).slice(0, 100)}`)
    }
  }

  logger.info(`Recipe captured: ${docId} "${recipe.title}" (${opts.origin}, ${chunks.length} chunks)`)
  captureTimestamps.push(Date.now())
  return docId
}

// ── Public API: Capture from conductor task ──

interface TaskRow {
  id: string
  title: string
  description: string
  project_id: string | null
  status: string
  result: string | null
  context: string | null
  created_by_agent: string | null
  completed_by: string | null
  parent_task_id: string | null
}

export async function captureFromTask(task: TaskRow): Promise<void> {
  const agentId = task.completed_by ?? task.created_by_agent

  // Guards
  if (!task.result) return

  logCaptureAttempt({ source: 'task', sourceId: task.id, agentId, projectId: task.project_id, status: 'attempt' })

  if (isRateLimited()) {
    logger.debug('Rate limited, skipping capture')
    logCaptureAttempt({ source: 'task', sourceId: task.id, agentId, projectId: task.project_id, status: 'skipped', errorMessage: 'Rate limited' })
    return
  }

  // Skip review/synthesis tasks
  const ctx = task.context ? JSON.parse(task.context) as Record<string, unknown> : {}
  if (ctx.type === 'review' || ctx.type === 'synthesis' || ctx.autoReview === false) {
    logCaptureAttempt({ source: 'task', sourceId: task.id, agentId, projectId: task.project_id, status: 'skipped', errorMessage: `Guard: ctx.type=${ctx.type as string ?? 'N/A'}, autoReview=${String(ctx.autoReview)}` })
    return
  }

  // Need enough actions to be meaningful
  const logCount = db.prepare(
    'SELECT COUNT(*) as cnt FROM conductor_task_logs WHERE task_id = ?'
  ).get(task.id) as { cnt: number }
  if (logCount.cnt < 2) {
    logCaptureAttempt({ source: 'task', sourceId: task.id, agentId, projectId: task.project_id, status: 'skipped', errorMessage: `Guard: only ${logCount.cnt} task log entries (need >= 2)` })
    return
  }

  // Check for duplicate title
  const existingTitle = db.prepare(
    "SELECT id FROM knowledge_documents WHERE title = ? AND status = 'active'"
  ).get(task.title)
  if (existingTitle) {
    logCaptureAttempt({ source: 'task', sourceId: task.id, agentId, projectId: task.project_id, status: 'skipped', errorMessage: `Guard: duplicate title "${task.title}"` })
    return
  }

  // Gather execution trace
  const logs = db.prepare(
    'SELECT action, message, agent_id, created_at FROM conductor_task_logs WHERE task_id = ? ORDER BY created_at'
  ).all(task.id) as Array<{ action: string; message: string | null; agent_id: string | null; created_at: string }>

  const executionContext = `## Task: ${task.title}
${task.description}

## Strategy/Context:
${task.context ?? 'N/A'}

## Execution Log (${logs.length} actions):
${logs.map(l => `- [${l.action}] ${l.message ?? ''}`).join('\n')}

## Result:
${task.result ?? 'N/A'}`

  // Analyze
  let analysis: CaptureAnalysis | null
  try {
    analysis = await analyzeForCapture(executionContext)
  } catch (err) {
    logCaptureAttempt({ source: 'task', sourceId: task.id, agentId, projectId: task.project_id, status: 'error', errorMessage: `analyzeForCapture threw: ${(err as Error).message?.slice(0, 300)}` })
    throw err
  }

  if (!analysis?.should_capture) {
    logger.debug(`Not capturing task ${task.id}: ${analysis?.reasoning ?? 'analysis failed'}`)
    logCaptureAttempt({ source: 'task', sourceId: task.id, agentId, projectId: task.project_id, status: 'skipped', errorMessage: `LLM: ${analysis?.reasoning ?? 'analysis returned null'}` })
    return
  }

  // Check similarity for derived vs captured
  const similar = await findSimilarDoc(analysis.content, task.project_id)
  const origin = similar ? 'derived' : 'captured'

  const docId = await storeRecipe(analysis, {
    projectId: task.project_id,
    agentId,
    sourceTaskId: task.id,
    origin,
    parentDocId: similar?.docId ?? null,
  })

  logCaptureAttempt({ source: 'task', sourceId: task.id, agentId, projectId: task.project_id, status: origin, title: analysis.title, docId })
}

// ── Public API: Capture from session end ──

export async function captureFromSession(opts: {
  sessionId: string
  summary: string
  agentId: string | null
  projectId: string | null
}): Promise<void> {
  if (!opts.summary || opts.summary.length < 50) {
    logCaptureAttempt({ source: 'session', sourceId: opts.sessionId, agentId: opts.agentId, projectId: opts.projectId, status: 'skipped', errorMessage: 'Summary too short or empty' })
    return
  }

  logCaptureAttempt({ source: 'session', sourceId: opts.sessionId, agentId: opts.agentId, projectId: opts.projectId, status: 'attempt' })

  if (isRateLimited()) {
    logger.debug('Rate limited, skipping capture')
    logCaptureAttempt({ source: 'session', sourceId: opts.sessionId, agentId: opts.agentId, projectId: opts.projectId, status: 'skipped', errorMessage: 'Rate limited' })
    return
  }

  // Get tool usage from query_logs for this session's agent (last hour)
  const toolUsage = db.prepare(`
    SELECT tool, COUNT(*) as cnt FROM query_logs
    WHERE agent_id = ? AND created_at > datetime('now', '-1 hour')
    GROUP BY tool ORDER BY cnt DESC LIMIT 10
  `).all(opts.agentId ?? '') as Array<{ tool: string; cnt: number }>

  const context = `## Session Summary
${opts.summary}

## Tools Used:
${toolUsage.map(t => `- ${t.tool}: ${t.cnt} calls`).join('\n') || 'N/A'}

## Project: ${opts.projectId ?? 'unknown'}`

  let analysis: CaptureAnalysis | null
  try {
    analysis = await analyzeForCapture(context)
  } catch (err) {
    logCaptureAttempt({ source: 'session', sourceId: opts.sessionId, agentId: opts.agentId, projectId: opts.projectId, status: 'error', errorMessage: `analyzeForCapture threw: ${(err as Error).message?.slice(0, 300)}` })
    throw err
  }

  if (!analysis?.should_capture) {
    logCaptureAttempt({ source: 'session', sourceId: opts.sessionId, agentId: opts.agentId, projectId: opts.projectId, status: 'skipped', errorMessage: `LLM: ${analysis?.reasoning ?? 'analysis returned null'}` })
    return
  }

  const similar = await findSimilarDoc(analysis.content, opts.projectId)
  const origin = similar ? 'derived' : 'captured'

  const docId = await storeRecipe(analysis, {
    projectId: opts.projectId,
    agentId: opts.agentId,
    sourceTaskId: null,
    origin,
    parentDocId: similar?.docId ?? null,
  })

  logCaptureAttempt({ source: 'session', sourceId: opts.sessionId, agentId: opts.agentId, projectId: opts.projectId, status: origin, title: analysis.title, docId })
}
