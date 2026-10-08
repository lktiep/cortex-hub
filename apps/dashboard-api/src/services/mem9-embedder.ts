/**
 * Mem9 Code Embedder Service
 *
 * Reads source files from a cloned repo, chunks them,
 * embeds using shared-mem9 Embedder (with fallback chain),
 * and stores vectors in Qdrant via VectorStore.
 *
 * Incremental: a chunk's point id is derived from where it sits and what it
 * says, so a re-index embeds only the chunks whose id is not stored yet, takes
 * the vector of identical text from any branch of the project before asking
 * the model, and deletes the ids the tree no longer produces.
 */

import { readdirSync, readFileSync, statSync } from 'fs'
import { join, extname, relative } from 'path'
import { createHash } from 'crypto'
import {
  Embedder,
  VectorStore,
  averageTokenLength,
  documentSparseVector,
  SPARSE_VECTOR_NAME,
} from '@cortex/shared-mem9'
import type { EmbedderConfig, ModelSlot, VectorStoreConfig } from '@cortex/shared-mem9'

import { db } from '../db/client.js'
import { createLogger } from '@cortex/shared-utils'

const logger = createLogger('mem9-embedder')

/** Synchronous work between two turns of the event loop: files read, chunks hashed. */
const YIELD_EVERY_FILES = 50
const YIELD_EVERY_CHUNKS = 500
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

const QDRANT_URL = process.env.QDRANT_URL ?? 'http://qdrant:6333'
const REPOS_DIR = process.env.REPOS_DIR ?? '/app/data/repos'

// ── File config ──
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
  '.turbo', 'coverage', '.cache', 'vendor', '.pnpm-store', 'bin', 'obj',
  '.vs', '.idea', '.gradle', 'target',
])

// `packages/` is NuGet's restore directory in a .NET solution — downloaded
// third-party code, worth skipping. It is also where a pnpm/yarn/lerna monorepo
// keeps its own source, which is emphatically not. Skipping it unconditionally
// cost this repo every file under packages/ (120 files indexed, none of them
// from there), so decide per repository instead of by name.
function skipsPackagesDir(root: string): boolean {
  try {
    return readdirSync(root).some((e) => e.toLowerCase().endsWith('.sln'))
  } catch {
    return false
  }
}

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

interface AccountRow {
  id: string
  api_base: string
  api_key: string | null
  type: string
}

export interface EmbedResult {
  status: string
  /** Points this branch holds after the run: unchanged ones plus those written. */
  chunks: number
  errors: string[]
  /** Distinct texts sent to the embedding model. */
  embedded?: number
  /** Chunks whose vector was copied from a point with the same text. */
  reused?: number
  /** Chunks already stored under the same id, left alone. */
  unchanged?: number
  /** Points of this branch the tree no longer produces, deleted. */
  removed?: number
}

// ── Point identity ──

/** What a chunk says, hashed: the key a vector can be reused under. */
export function chunkContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 32)
}

/**
 * Which model wrote a vector. Copying a vector between points is only sound
 * when both were embedded the same way, and the id carries this too, so a
 * switch of embedding model re-embeds every chunk instead of mixing spaces.
 * The model names come from the routing chain the gateway also follows; a
 * fallback slot answering for the first is not visible here.
 */
export function embeddingFingerprint(models: string[], vectorSize: number): string {
  return `${models.length > 0 ? models.join('>') : 'auto'}@${vectorSize}`
}

/**
 * A chunk's point id: the same chunk of the same file on the same branch,
 * embedded the same way, always lands on the same id, and any change to it
 * lands on another. Formatted as an RFC 4122 UUID (version 5 layout) because
 * that is what Qdrant takes as a string id.
 */
export function chunkPointId(parts: {
  projectId: string
  branch: string
  filePath: string
  chunkIndex: number
  contentHash: string
  embedFp: string
}): string {
  const h = createHash('sha256')
    .update([parts.projectId, parts.branch, parts.filePath, String(parts.chunkIndex), parts.contentHash, parts.embedFp].join('\0'))
    .digest('hex')
  const variant = ((parseInt(h.charAt(16), 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
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
  const skipPackages = skipsPackagesDir(dir)

  function walk(currentDir: string) {
    let entries: string[]
    try {
      entries = readdirSync(currentDir)
    } catch {
      return
    }

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue
      if (entry === 'packages' && skipPackages) continue

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
  const routing = db.prepare(
    "SELECT chain FROM model_routing WHERE purpose = 'embedding'"
  ).get() as { chain: string } | undefined

  const chainSlots: ModelSlot[] = []

  if (routing?.chain) {
    const parsed = JSON.parse(routing.chain) as Array<{ accountId: string; model: string }>
    for (const slot of parsed) {
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

  // Always route through gateway — actual provider resolved by LLM gateway from model_routing DB
  const gatewayConfig: EmbedderConfig = {
    provider: 'gemini' as const, // Dummy: gateway ignores this and uses model_routing
    apiKey: '',
    model: 'auto',
  }

  return { config: gatewayConfig, chain: chainSlots }
}

// ── Main Embedding Pipeline ──

export async function embedProject(
  projectId: string,
  branch: string,
  jobId: string,
  onProgress?: (progress: number, successChunks: number, totalChunks: number) => void,
  repoDir: string = join(REPOS_DIR, projectId),
): Promise<EmbedResult> {
  // First pass: count chunks to calculate dynamic timeout
  // The actual embedding happens in embedProjectInternal
  // We use a clearable timer so it doesn't fire after success
  let timer: ReturnType<typeof setTimeout> | null = null

  const timeoutPromise = new Promise<EmbedResult>((resolve) => {
    // Start with max timeout; embedProjectInternal will adjust it after counting chunks
    timer = setTimeout(() => {
      logger.warn(`[${jobId}] mem9 embedding timed out after ${MAX_TIMEOUT_MS / 1000}s (max)`)
      resolve({ status: 'error', chunks: 0, errors: [`Embedding timed out (${MAX_TIMEOUT_MS / 1000}s max limit)`] })
    }, MAX_TIMEOUT_MS)
  })

  const embedPromise = embedProjectInternal(projectId, branch, jobId, repoDir, onProgress, (chunkCount) => {
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
  repoDir: string,
  onProgress?: (progress: number, successChunks: number, totalChunks: number) => void,
  onChunkCount?: (count: number) => void,
): Promise<EmbedResult> {
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
  //
  // Reading and chunking a large tree is synchronous work on the thread that
  // also answers every search; hand the event loop back every few files so a
  // query that arrives mid-index waits milliseconds, not the whole walk.
  const allChunks: ChunkResult[] = []
  for (const [fileIdx, file] of sourceFiles.entries()) {
    if (fileIdx % YIELD_EVERY_FILES === YIELD_EVERY_FILES - 1) await yieldToEventLoop()
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

  // 3. Build embedder with fallback chain, routed through LLM gateway
  const { config: embedConfig, chain } = buildEmbeddingChain()
  const GATEWAY_URL = process.env.LLM_GATEWAY_URL ?? 'http://localhost:4000/api/llm'
  const embedder = new Embedder(embedConfig, chain, {
    maxRetries: 2,
    retryDelayMs: 2000,
    gatewayUrl: GATEWAY_URL,
    priority: 'background',
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

  // Turn on the lexical arm of hybrid search if this collection can carry it.
  //
  // Qdrant will not add a sparse vector to a collection that already exists, so
  // the only way to gain one is to build the collection again — which throws away
  // every branch stored in it, not just the one being indexed. Rebuild when this
  // project+branch is the only tenant (it always is today), and otherwise leave
  // the collection alone and index dense-only: search falls back by itself.
  let otherBranchPoints = 0
  try {
    otherBranchPoints = await vectorStore.count({
      must: [{ key: 'project_id', match: { value: projectId } }],
      must_not: [{ key: 'branch', match: { value: branch } }],
    })
  } catch {
    // A collection that does not exist yet cannot be counted; 0 is the answer.
  }

  const { sparseVectorEnabled } = await vectorStore.ensureCollection(vectorSize, {
    sparseVectorName: SPARSE_VECTOR_NAME,
    recreate: otherBranchPoints === 0,
  })

  if (sparseVectorEnabled) {
    logger.info(`[${jobId}] Hybrid search enabled: writing BM25 sparse vectors`)
  } else {
    logger.warn(
      `[${jobId}] Dense-only index: collection has no '${SPARSE_VECTOR_NAME}' sparse vector` +
        (otherBranchPoints > 0 ? ` and holds ${otherBranchPoints} points from another branch` : ''),
    )
  }

  // The two lookups below filter on these. Without an index Qdrant scans every
  // point of every branch for each of them; a failure only costs that speed.
  for (const field of ['branch', 'content_hash']) {
    await vectorStore.ensurePayloadIndex(field).catch((err: unknown) => {
      logger.warn(`[${jobId}] Payload index on '${field}' not created: ${String(err).slice(0, 200)}`)
    })
  }

  // BM25 measures a document against the average length of the corpus it lives
  // in, so the average has to be the one for this project, computed before the
  // first point is written. Unchanged points keep the sparse vector written
  // against the average of their own run; one commit moves it by a fraction of
  // a percent, which shifts no ranking worth re-writing every point for.
  const averageLength = sparseVectorEnabled
    ? averageTokenLength(allChunks.map((chunk) => chunk.content))
    : 0

  // 5. Work out what changed
  //
  // Every chunk gets the id it would be stored under. An id this branch already
  // holds is the same text at the same place, embedded the same way: nothing to
  // do. The ids it holds that no chunk produces any more — edited, moved or
  // deleted code, and points written before ids were derived — are stale.
  const embedFp = embeddingFingerprint(chain.map((slot) => slot.model), vectorSize)
  const wanted: Array<ChunkResult & { contentHash: string; id: string }> = []
  for (const [chunkIdx, chunk] of allChunks.entries()) {
    if (chunkIdx % YIELD_EVERY_CHUNKS === YIELD_EVERY_CHUNKS - 1) await yieldToEventLoop()
    const contentHash = chunkContentHash(chunk.content)
    wanted.push({
      ...chunk,
      contentHash,
      id: chunkPointId({ projectId, branch, filePath: chunk.filePath, chunkIndex: chunk.chunkIndex, contentHash, embedFp }),
    })
  }

  const branchFilter = {
    must: [
      { key: 'project_id', match: { value: projectId } },
      { key: 'branch', match: { value: branch } },
    ],
  }
  let storedIds: Set<string>
  try {
    storedIds = new Set((await vectorStore.scrollAll(branchFilter)).map((p) => p.id))
  } catch (err) {
    const msg = `Failed to list stored points: ${String(err).slice(0, 200)}`
    logger.error(`[${jobId}] ${msg}`)
    return { status: 'error', chunks: 0, errors: [msg] }
  }

  const wantedIds = new Set(wanted.map((chunk) => chunk.id))
  const todo = wanted.filter((chunk) => !storedIds.has(chunk.id))
  const stale = [...storedIds].filter((id) => !wantedIds.has(id))
  const unchanged = wanted.length - todo.length

  logger.info(
    `[${jobId}] ${unchanged} chunks unchanged, ${todo.length} to write, ${stale.length} stale (${embedFp})`,
  )

  // Notify parent to adjust dynamic timeout: only the chunks to write cost time.
  onChunkCount?.(todo.length)

  // 6. Write the chunks that are not stored yet, in batches
  //
  // One batch is one lookup of reusable vectors, at most one embedding request
  // and one Qdrant upsert. A vector is reused when a point with the same text,
  // embedded the same way, exists on any branch of the project — a worktree
  // branch shares nearly all of its text with the branch it came from, and a
  // moved file shares all of its own. Only the rest goes to the model.
  //
  // Eight per batch because ollama embeds one request at a time: a search that
  // arrives mid-batch waits for the whole batch. Measured on the hub (4 CPUs,
  // all-minilm, 1500-char chunks), a batch of 32 took 2.2-4.6s and held a query
  // for 2.3s; a batch of 8 took 0.6s and held it for 0.36s, at no loss of
  // throughput. Override with MEM9_BATCH_SIZE / MEM9_BATCH_DELAY_MS.
  let written = 0
  let embedded = 0
  let reused = 0
  const BATCH_SIZE = Math.max(1, Number(process.env['MEM9_BATCH_SIZE']) || 8)
  const BATCH_DELAY_MS = Math.max(0, Number(process.env['MEM9_BATCH_DELAY_MS']) || 0)
  const totalBatches = Math.ceil(todo.length / BATCH_SIZE)

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const batch = todo.slice(batchIdx * BATCH_SIZE, (batchIdx + 1) * BATCH_SIZE)
    const vectorsByHash = new Map<string, number[]>()

    try {
      const found = await vectorStore.scrollAll(
        {
          must: [
            { key: 'project_id', match: { value: projectId } },
            { key: 'embed_fp', match: { value: embedFp } },
            { key: 'content_hash', match: { any: [...new Set(batch.map((chunk) => chunk.contentHash))] } },
          ],
        },
        { payload: ['content_hash'], vector: true },
      )
      for (const point of found) {
        const hash = point.payload['content_hash']
        if (typeof hash === 'string' && point.vector?.length === vectorSize) vectorsByHash.set(hash, point.vector)
      }
    } catch (err) {
      // Reuse saves work; it is never a reason to fail. Embed the batch instead.
      logger.warn(`[${jobId}] Vector reuse lookup failed: ${String(err).slice(0, 200)}`)
    }

    const reusedHashes = new Set(vectorsByHash.keys())

    // Identical text twice in one batch (license headers, generated code) is
    // embedded once.
    const toEmbed = [...new Map(
      batch.filter((chunk) => !reusedHashes.has(chunk.contentHash)).map((chunk) => [chunk.contentHash, chunk.content]),
    )]
    // A whole request failing must not cost the attribution of which chunks
    // failed, nor the chunks whose vector was found without the model.
    let embedError = 'embedder returned no vector'
    if (toEmbed.length > 0) {
      try {
        const vectors = await embedder.embedBatch(toEmbed.map(([, content]) => content))
        toEmbed.forEach(([hash], i) => {
          const vector = vectors[i]
          if (vector?.length) vectorsByHash.set(hash, vector)
        })
        embedded += toEmbed.length
      } catch (err) {
        embedError = String(err).slice(0, 100)
      }
    }

    const points = batch.flatMap((chunk) => {
      const vector = vectorsByHash.get(chunk.contentHash)
      if (!vector?.length) {
        errors.push(`${chunk.filePath}#${chunk.chunkIndex}: ${embedError}`)
        return []
      }
      return [{
        id: chunk.id,
        vector,
        sparseVector: sparseVectorEnabled
          ? documentSparseVector(chunk.content, averageLength)
          : undefined,
        payload: {
          project_id: projectId,
          branch,
          file_path: chunk.filePath,
          chunk_index: chunk.chunkIndex,
          content: chunk.content.slice(0, 2000), // Store first 2KB for retrieval
          content_hash: chunk.contentHash,
          embed_fp: embedFp,
          indexed_at: new Date().toISOString(),
        },
      }]
    })

    try {
      await vectorStore.upsertBatch(points, sparseVectorEnabled ? SPARSE_VECTOR_NAME : undefined)
      written += points.length
      reused += batch.filter((chunk) => reusedHashes.has(chunk.contentHash)).length
    } catch (err) {
      const msg = String(err).slice(0, 100)
      for (const point of points) {
        errors.push(`${point.payload.file_path}#${point.payload.chunk_index}: ${msg}`)
      }
    }

    // Report progress over the whole branch: unchanged chunks are already done.
    const progress = Math.round(((batchIdx + 1) / totalBatches) * 100)
    onProgress?.(progress, unchanged + written, wanted.length)

    if (BATCH_DELAY_MS > 0 && batchIdx < totalBatches - 1) {
      await new Promise<void>((r) => setTimeout(r, BATCH_DELAY_MS))
    }
  }

  if (totalBatches === 0) onProgress?.(100, unchanged, wanted.length)

  // 7. Drop the stale points, after the new ones are in: search never sees the
  // branch half-empty. When a chunk failed, its old point is the best this
  // branch has, so leave every stale point for the next run to clear.
  let removed = 0
  if (stale.length > 0 && errors.length === 0) {
    try {
      await vectorStore.deletePoints(stale)
      removed = stale.length
    } catch (err) {
      errors.push(`Failed to delete ${stale.length} stale points: ${String(err).slice(0, 100)}`)
    }
  } else if (stale.length > 0) {
    logger.warn(`[${jobId}] Kept ${stale.length} stale points: ${errors.length} chunks failed, the next run clears them`)
  }

  logger.info(
    `[${jobId}] Embedding complete: ${unchanged + written}/${wanted.length} chunks stored ` +
      `(${unchanged} unchanged, ${reused} reused, ${embedded} embedded, ${removed} removed)`,
  )
  // Usage is logged automatically by the LLM gateway

  if (errors.length > 10) {
    // Only keep first 10 errors + summary
    const total = errors.length
    errors.length = 10
    errors.push(`... and ${total - 10} more errors`)
  }

  return {
    status: errors.length > 0 && written === 0 && todo.length > 0 ? 'error' : 'done',
    chunks: unchanged + written,
    errors,
    embedded,
    reused,
    unchanged,
    removed,
  }
}
