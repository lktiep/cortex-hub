/**
 * Mem9 Code Embedder Service
 *
 * Reads source files from a cloned repo, chunks them,
 * embeds using shared-mem9 Embedder (with fallback chain),
 * and stores vectors in Qdrant via VectorStore.
 */

import { readdirSync, readFileSync, statSync } from 'fs'
import { join, extname, relative } from 'path'
import { randomUUID } from 'crypto'
import { Embedder, VectorStore } from '@cortex/shared-mem9'
import type { EmbedderConfig, ModelSlot, VectorStoreConfig } from '@cortex/shared-mem9'
import { db } from '../db/client.js'
import { createLogger } from '@cortex/shared-utils'

const logger = createLogger('mem9-embedder')

const QDRANT_URL = process.env.QDRANT_URL ?? 'http://qdrant:6333'
const REPOS_DIR = process.env.REPOS_DIR ?? '/app/data/repos'

// ── File config ──
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
  '.turbo', 'coverage', '.cache', 'vendor', '.pnpm-store', 'bin', 'obj',
  'packages', '.vs', '.idea', '.gradle', 'target',
])

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.kt',
  '.rb', '.php', '.cs', '.swift', '.dart', '.scala', '.ex', '.exs',
  '.vue', '.svelte', '.sql', '.sh', '.c', '.cpp', '.h', '.hpp', '.m',
  '.lua', '.r', '.pl', '.pm',
])

const MAX_FILE_SIZE = 256 * 1024 // 256KB
const CHUNK_SIZE = 1500 // ~375 tokens (4 chars/token)
const CHUNK_OVERLAP = 300

// Dynamic timeout: min 10min, +3s per chunk, max 60min
const MIN_TIMEOUT_MS = 10 * 60 * 1000
const MAX_TIMEOUT_MS = 60 * 60 * 1000
const MS_PER_CHUNK = 3000

function calculateTimeout(chunkCount: number): number {
  const dynamic = MIN_TIMEOUT_MS + chunkCount * MS_PER_CHUNK
  return Math.min(dynamic, MAX_TIMEOUT_MS)
}

interface ChunkResult {
  filePath: string
  chunkIndex: number
  content: string
}

interface RoutingRow {
  purpose: string
  chain: string
  updated_at: string
}

interface AccountRow {
  id: string
  api_base: string
  api_key: string | null
  type: string
}

// ── Text Chunking ──

function chunkText(text: string, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  if (text.length <= chunkSize) return [text]

  const chunks: string[] = []
  let start = 0

  while (start < text.length) {
    let end = start + chunkSize

    // Try to break at a newline boundary for cleaner chunks
    if (end < text.length) {
      const newlinePos = text.lastIndexOf('\n', end)
      if (newlinePos > start + chunkSize / 2) {
        end = newlinePos + 1
      }
    }

    chunks.push(text.slice(start, end))
    start = end - overlap
    if (start >= text.length) break
  }

  return chunks
}

// ── File Walking ──

function collectSourceFiles(dir: string): Array<{ path: string; relativePath: string }> {
  const files: Array<{ path: string; relativePath: string }> = []

  function walk(currentDir: string) {
    let entries: string[]
    try {
      entries = readdirSync(currentDir)
    } catch {
      return
    }

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue

      const fullPath = join(currentDir, entry)
      let stat
      try {
        stat = statSync(fullPath)
      } catch {
        continue
      }

      if (stat.isDirectory()) {
        walk(fullPath)
      } else if (stat.isFile()) {
        const ext = extname(entry).toLowerCase()
        if (!CODE_EXTENSIONS.has(ext)) continue
        if (stat.size > MAX_FILE_SIZE) continue
        if (stat.size < 10) continue // skip empty/tiny files

        files.push({
          path: fullPath,
          relativePath: relative(dir, fullPath),
        })
      }
    }
  }

  walk(dir)
  return files
}

// ── Build Embedding Chain from model_routing ──

function buildEmbeddingChain(): { config: EmbedderConfig; chain: ModelSlot[] } {
  // Get embedding routing
  const routing = db.prepare(
    "SELECT chain FROM model_routing WHERE purpose = 'embedding'"
  ).get() as { chain: string } | undefined

  const chainSlots: ModelSlot[] = []

  if (routing?.chain) {
    const chain = JSON.parse(routing.chain) as Array<{ accountId: string; model: string }>

    for (const slot of chain) {
      const account = db.prepare(
        "SELECT id, api_base, api_key, type FROM provider_accounts WHERE id = ? AND status = 'enabled'"
      ).get(slot.accountId) as AccountRow | undefined

      if (account) {
        chainSlots.push({
          accountId: account.id,
          baseUrl: account.api_base,
          apiKey: account.api_key ?? undefined,
          model: slot.model,
        })
      }
    }
  }

  // Default fallback config (Gemini)
  const geminiKey = process.env.GEMINI_API_KEY ?? ''
  const defaultConfig: EmbedderConfig = {
    provider: 'gemini',
    apiKey: geminiKey,
    model: 'gemini-embedding-001',
  }

  return { config: defaultConfig, chain: chainSlots }
}

// ── Main Embedding Pipeline ──

export async function embedProject(
  projectId: string,
  branch: string,
  jobId: string,
  onProgress?: (progress: number, successChunks: number, totalChunks: number) => void,
): Promise<{ status: string; chunks: number; errors: string[] }> {
  // First pass: count chunks to calculate dynamic timeout
  // The actual embedding happens in embedProjectInternal
  // We use a clearable timer so it doesn't fire after success
  let timer: ReturnType<typeof setTimeout> | null = null

  const timeoutPromise = new Promise<{ status: string; chunks: number; errors: string[] }>((resolve) => {
    // Start with max timeout; embedProjectInternal will adjust it after counting chunks
    timer = setTimeout(() => {
      logger.warn(`[${jobId}] mem9 embedding timed out after ${MAX_TIMEOUT_MS / 1000}s (max)`)
      resolve({ status: 'error', chunks: 0, errors: [`Embedding timed out (${MAX_TIMEOUT_MS / 1000}s max limit)`] })
    }, MAX_TIMEOUT_MS)
  })

  const embedPromise = embedProjectInternal(projectId, branch, jobId, onProgress, (chunkCount) => {
    // Callback: adjust timeout based on actual chunk count
    if (timer) {
      clearTimeout(timer)
      const dynamicMs = calculateTimeout(chunkCount)
      logger.info(`[${jobId}] Dynamic timeout set: ${Math.round(dynamicMs / 1000)}s for ${chunkCount} chunks`)
      timer = setTimeout(() => {
        logger.warn(`[${jobId}] mem9 embedding timed out after ${Math.round(dynamicMs / 1000)}s`)
      }, dynamicMs)
    }
  })

  const result = await Promise.race([embedPromise, timeoutPromise])

  // Clear the timer on completion to prevent orphaned timeout warnings
  if (timer) clearTimeout(timer)

  return result
}

async function embedProjectInternal(
  projectId: string,
  branch: string,
  jobId: string,
  onProgress?: (progress: number, successChunks: number, totalChunks: number) => void,
  onChunkCount?: (count: number) => void,
): Promise<{ status: string; chunks: number; errors: string[] }> {
  const repoDir = join(REPOS_DIR, projectId)
  const collectionName = `cortex-project-${projectId}`
  const errors: string[] = []

  logger.info(`[${jobId}] Starting mem9 embedding for ${projectId}:${branch}`)

  // 1. Collect source files
  const sourceFiles = collectSourceFiles(repoDir)
  logger.info(`[${jobId}] Found ${sourceFiles.length} source files`)

  if (sourceFiles.length === 0) {
    return { status: 'done', chunks: 0, errors: ['No source files found'] }
  }

  // 2. Chunk all files
  const allChunks: ChunkResult[] = []
  for (const file of sourceFiles) {
    try {
      const content = readFileSync(file.path, 'utf-8')
      // Prepend file path as context
      const enriched = `// File: ${file.relativePath}\n${content}`
      const chunks = chunkText(enriched)
      chunks.forEach((chunk, i) => {
        allChunks.push({
          filePath: file.relativePath,
          chunkIndex: i,
          content: chunk,
        })
      })
    } catch {
      // Skip unreadable files
    }
  }

  logger.info(`[${jobId}] Created ${allChunks.length} chunks from ${sourceFiles.length} files`)

  // Notify parent to adjust dynamic timeout
  onChunkCount?.(allChunks.length)

  // 3. Build embedder with fallback chain, routed through LLM gateway
  const { config: embedConfig, chain } = buildEmbeddingChain()
  const GATEWAY_URL = process.env.LLM_GATEWAY_URL ?? 'http://localhost:4000/api/llm'
  const embedder = new Embedder(embedConfig, chain, {
    maxRetries: 2,
    retryDelayMs: 2000,
    gatewayUrl: GATEWAY_URL,
  })

  // 4. Setup Qdrant collection
  const vectorStore = new VectorStore({
    url: QDRANT_URL,
    collection: collectionName,
  } satisfies VectorStoreConfig)

  // Determine vector dimensions by embedding a test string
  let vectorSize: number
  try {
    const testVec = await embedder.embed('test')
    vectorSize = testVec.length
    logger.info(`[${jobId}] Vector dimensions: ${vectorSize}`)
  } catch (err) {
    const msg = `Embedding test failed: ${String(err).slice(0, 200)}`
    logger.error(`[${jobId}] ${msg}`)
    return { status: 'error', chunks: 0, errors: [msg] }
  }

  await vectorStore.ensureCollection(vectorSize)

  // 5. Embed and store in batches
  let successCount = 0
  const BATCH_SIZE = 5
  const totalBatches = Math.ceil(allChunks.length / BATCH_SIZE)

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const batch = allChunks.slice(batchIdx * BATCH_SIZE, (batchIdx + 1) * BATCH_SIZE)

    const embedPromises = batch.map(async (chunk) => {
      try {
        const vector = await embedder.embed(chunk.content)
        const pointId = randomUUID()

        await vectorStore.upsert(pointId, vector, {
          project_id: projectId,
          branch,
          file_path: chunk.filePath,
          chunk_index: chunk.chunkIndex,
          content: chunk.content.slice(0, 2000), // Store first 2KB for retrieval
          indexed_at: new Date().toISOString(),
        })

        successCount++
      } catch (err) {
        errors.push(`${chunk.filePath}#${chunk.chunkIndex}: ${String(err).slice(0, 100)}`)
      }
    })

    await Promise.all(embedPromises)

    // Report progress
    const progress = Math.round(((batchIdx + 1) / totalBatches) * 100)
    onProgress?.(progress, successCount, allChunks.length)

    // Small delay between batches to avoid rate limiting
    if (batchIdx < totalBatches - 1) {
      await new Promise<void>((r) => setTimeout(r, 200))
    }
  }

  logger.info(`[${jobId}] Embedding complete: ${successCount}/${allChunks.length} chunks stored`)
  // Usage is logged automatically by the LLM gateway

  if (errors.length > 10) {
    // Only keep first 10 errors + summary
    const total = errors.length
    errors.length = 10
    errors.push(`... and ${total - 10} more errors`)
  }

  return {
    status: errors.length > 0 && successCount === 0 ? 'error' : 'done',
    chunks: successCount,
    errors,
  }
}
