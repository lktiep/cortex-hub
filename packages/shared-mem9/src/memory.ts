/**
 * mem9 — Core Memory class
 *
 * Implements the mem9 pipeline:
 * add()    → 2 LLM calls (extract facts + decide actions) + embed + Qdrant
 * search() → 1 embed call + Qdrant search (vector and BM25, fused by rank)
 * getAll() → Qdrant scroll
 */

import { randomUUID, createHash } from 'crypto'
import type {
  Mem9Config,
  AddRequest,
  AddResult,
  SearchRequest,
  SearchResult,
  GetAllRequest,
  MemoryItem,
  MemoryEvent,
  QdrantSearchResult,
} from './types.js'
import { Embedder } from './embedder.js'
import { VectorStore } from './vector-store.js'
import { LlmClient } from './llm.js'
import { getFactExtractionPrompt, getMemoryUpdatePrompt } from './prompts.js'
import { documentSparseVector, querySparseVector, tokenizeText, SPARSE_VECTOR_NAME } from './sparse.js'
import type { SparseVector } from './sparse.js'
import { fuseByRank } from './fusion.js'

/**
 * How deep each arm reads before fusion. At the default limit the two arms would
 * overlap so much that reciprocal rank had nothing to work with.
 */
const HYBRID_FETCH_FLOOR = 30

/** How many stored memories are read to learn the average length BM25 normalises by. */
const LENGTH_SAMPLE = 1000

/** Internal type for LLM action responses */
interface MemoryAction {
  type: 'ADD' | 'UPDATE' | 'DELETE' | 'NONE'
  memory?: string
  memoryId?: string
  oldMemory?: string
  newMemory?: string
}

/** Build a Qdrant filter for user/agent scoping */
function buildFilter(
  userId: string,
  agentId?: string,
  extra: Array<Record<string, unknown>> = [],
): Record<string, unknown> {
  const conditions: Array<Record<string, unknown>> = [
    { key: 'user_id', match: { value: userId } },
  ]
  if (agentId) {
    conditions.push({ key: 'agent_id', match: { value: agentId } })
  }
  return { must: [...conditions, ...extra] }
}

/** Create a short hash from text for dedup detection */
function hashText(text: string): string {
  return createHash('md5').update(text.toLowerCase().trim()).digest('hex').slice(0, 16)
}

export class Mem9 {
  private readonly embedder: Embedder
  private readonly vectorStore: VectorStore
  private readonly llm: LlmClient
  private init: Promise<void> | null = null
  /** Whether the collection carries the lexical arm; set once init has run. */
  private hybrid = false
  /** Token counts seen so far — their mean is the `avgdl` a new memory is normalised by. */
  private lengths = { total: 0, count: 0 }

  constructor(private readonly config: Mem9Config) {
    this.embedder = new Embedder(config.embedder)
    this.vectorStore = new VectorStore(config.vectorStore)
    this.llm = new LlmClient(config.llm)
  }

  /**
   * Initialize collection with correct vector dimensions.
   *
   * Shared by every caller that arrives before it finishes — concurrent requests
   * used to run it once each — and forgotten on failure so the next one retries.
   */
  private ensureInit(): Promise<void> {
    this.init ??= this.initialize().catch((err: unknown) => {
      this.init = null
      throw err
    })
    return this.init
  }

  private async initialize(): Promise<void> {
    // Embed a test string to detect dimensions
    const testVec = await this.embedder.embed('dimension detection')

    // A new collection is created with the lexical arm. One that already exists
    // keeps what it has — Qdrant cannot add a sparse vector to it — and is
    // searched by vector alone until it is copied into one that does.
    const { sparseVectorEnabled } = await this.vectorStore.ensureCollection(testVec.length, {
      sparseVectorName: SPARSE_VECTOR_NAME,
    })
    this.hybrid = sparseVectorEnabled

    if (!this.hybrid) {
      console.warn(
        `[mem9] ${this.config.vectorStore.collection} has no lexical index, so memory search ` +
          'uses vectors alone. Run the memory migration to add it.',
      )
      return
    }

    for (const point of await this.vectorStore.list(undefined, LENGTH_SAMPLE)) {
      this.recordLength((point.payload.memory as string) ?? '')
    }
  }

  private recordLength(text: string): void {
    this.lengths.total += tokenizeText(text).length
    this.lengths.count += 1
  }

  /** The stored half of BM25 for a memory, or nothing when the collection cannot hold it. */
  private sparseFor(text: string): SparseVector | undefined {
    if (!this.hybrid) return undefined
    const averageLength = this.lengths.count > 0 ? this.lengths.total / this.lengths.count : 0
    const vector = documentSparseVector(text, averageLength, tokenizeText)
    this.recordLength(text)
    return vector
  }

  /** A memory in this scope that already says exactly this, if there is one. */
  private async findByHash(userId: string, agentId: string | undefined, hash: string): Promise<string | null> {
    const [hit] = await this.vectorStore.list(
      buildFilter(userId, agentId, [{ key: 'hash', match: { value: hash } }]),
      1,
    )
    return hit?.id ?? null
  }

  /**
   * The vector arm alone, or both arms fused by rank.
   *
   * The lexical arm answers what an English-only embedding cannot: a Vietnamese
   * sentence, an identifier, an error string typed exactly. When it has nothing
   * to say — no searchable term, no match, or Qdrant refused it — the answer is
   * the vector arm's, with its similarities intact.
   */
  private async retrieve(
    query: string,
    vector: number[],
    filter: Record<string, unknown>,
    limit: number,
  ): Promise<QdrantSearchResult[]> {
    const sparse = this.hybrid ? querySparseVector(query, tokenizeText) : undefined
    if (!sparse || sparse.indices.length === 0) {
      return this.vectorStore.search(vector, filter, limit)
    }

    const depth = Math.max(limit, HYBRID_FETCH_FLOOR)
    const [dense, lexical] = await Promise.all([
      this.vectorStore.search(vector, filter, depth),
      this.vectorStore.searchSparse(sparse, filter, depth).catch((err: unknown) => {
        console.warn(`[mem9] lexical arm failed, answering from vectors alone: ${String(err).slice(0, 150)}`)
        return []
      }),
    ])

    if (lexical.length === 0) return dense.slice(0, limit)
    return fuseByRank([dense, lexical]).slice(0, limit)
  }

  /**
   * Add memories from a conversation.
   *
   * Pipeline:
   * 1. Format messages → LLM extracts facts
   * 2. Embed each fact → search Qdrant for similar existing memories
   * 3. LLM decides ADD/UPDATE/DELETE for each fact
   * 4. Execute actions on Qdrant
   */
  async add(req: AddRequest): Promise<AddResult> {
    await this.ensureInit()

    let totalTokens = 0
    const events: MemoryEvent[] = []

    // ── Step 1: Extract facts from conversation ──
    const conversationText = req.messages
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n')

    const { result: factResult, tokensUsed: extractTokens } = await this.llm.chatJson<{
      facts: string[]
    }>([
      { role: 'system', content: getFactExtractionPrompt() },
      { role: 'user', content: conversationText },
    ])
    totalTokens += extractTokens

    const facts = factResult.facts ?? []
    if (facts.length === 0) {
      return { events: [], tokensUsed: totalTokens }
    }

    // ── Step 2: Embed facts and find similar existing memories ──
    // One embedding request for every fact, then every lookup at once. They are
    // independent of each other; made one after another, each fact cost two round
    // trips before the next could start.
    const filter = buildFilter(req.userId, req.agentId)
    const factVectors = await this.embedder.embedBatch(facts)
    const lookups = await Promise.all(
      factVectors.map((vec) => this.vectorStore.search(vec, filter, 5)),
    )

    const existingMemories: Array<{ id: string; memory: string }> = []
    for (const similar of lookups) {
      for (const hit of similar) {
        // Avoid duplicates in the comparison list
        if (hit.score > 0.7 && !existingMemories.some((m) => m.id === hit.id)) {
          existingMemories.push({ id: hit.id, memory: (hit.payload.memory as string) ?? '' })
        }
      }
    }

    // ── Step 3: LLM decides actions ──
    const { result: actionResult, tokensUsed: actionTokens } = await this.llm.chatJson<{
      actions: MemoryAction[]
    }>([
      {
        role: 'user',
        content: getMemoryUpdatePrompt(existingMemories, facts),
      },
    ])
    totalTokens += actionTokens

    const actions = actionResult.actions ?? []

    // Most ADDs store a fact word for word, and every fact was embedded above.
    // Whatever the LLM reworded is embedded here, in one request.
    const vectors = new Map(facts.map((fact, i) => [fact, factVectors[i]!]))
    const reworded = [
      ...new Set(
        actions.flatMap((a) => {
          const text = a.type === 'ADD' ? a.memory : a.type === 'UPDATE' ? a.newMemory : undefined
          return text && !vectors.has(text) ? [text] : []
        }),
      ),
    ]
    const rewordedVectors = await this.embedder.embedBatch(reworded)
    reworded.forEach((text, i) => vectors.set(text, rewordedVectors[i]!))

    // Hashes added by this call: a write is not visible to the next lookup at once.
    const addedHashes = new Map<string, string>()

    // ── Step 4: Execute actions ──
    for (const action of actions) {
      switch (action.type) {
        case 'ADD': {
          if (!action.memory) break

          // The same fact stated again. The hash was always stored and never
          // checked, so a repeated session summary became a second copy each time.
          const hash = hashText(action.memory)
          const existingId = addedHashes.get(hash) ?? (await this.findByHash(req.userId, req.agentId, hash))
          if (existingId) {
            events.push({ type: 'NONE', memoryId: existingId, newMemory: action.memory })
            break
          }

          const id = randomUUID()
          const vec = vectors.get(action.memory)!
          await this.vectorStore.upsert(id, vec, {
            memory: action.memory,
            hash,
            user_id: req.userId,
            agent_id: req.agentId ?? '',
            metadata: req.metadata ?? {},
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }, this.sparseFor(action.memory))
          addedHashes.set(hash, id)
          events.push({
            type: 'ADD',
            memoryId: id,
            newMemory: action.memory,
          })
          break
        }

        case 'UPDATE': {
          if (!action.memoryId || !action.newMemory) break
          const vec = vectors.get(action.newMemory)!
          // Preserve existing payload, update memory and timestamp
          const existing = await this.vectorStore.get(action.memoryId)
          const payload = existing?.payload ?? {}
          await this.vectorStore.update(action.memoryId, vec, {
            ...payload,
            memory: action.newMemory,
            hash: hashText(action.newMemory),
            updated_at: new Date().toISOString(),
          }, this.sparseFor(action.newMemory))
          events.push({
            type: 'UPDATE',
            memoryId: action.memoryId,
            oldMemory: action.oldMemory,
            newMemory: action.newMemory,
          })
          break
        }

        case 'DELETE': {
          if (!action.memoryId) break
          await this.vectorStore.delete(action.memoryId)
          events.push({
            type: 'DELETE',
            memoryId: action.memoryId,
            oldMemory: action.memory,
          })
          break
        }

        case 'NONE':
        default:
          break
      }
    }

    return { events, tokensUsed: totalTokens }
  }

  async search(req: SearchRequest): Promise<SearchResult> {
    await this.ensureInit()

    const vec = await this.embedder.embed(req.query)
    const filter = buildFilter(req.userId, req.agentId)
    const results = await this.retrieve(req.query, vec, filter, req.limit ?? 10)

    const memories: MemoryItem[] = results.map((r) => ({
      id: r.id,
      memory: (r.payload.memory as string) ?? '',
      hash: (r.payload.hash as string) ?? '',
      userId: (r.payload.user_id as string) ?? undefined,
      agentId: (r.payload.agent_id as string) ?? undefined,
      metadata: (r.payload.metadata as Record<string, unknown>) ?? undefined,
      score: r.score,
      createdAt: (r.payload.created_at as string) ?? '',
      updatedAt: (r.payload.updated_at as string) ?? '',
    }))

    // Apply recency boost to re-rank memories chronologically when appropriate
    const now = Date.now()
    const scoredMemories = memories.map((m) => {
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
      // For session summaries, recency is a highly significant signal (50/50 balance)
      const weightVector = isSession ? 0.5 : 0.9
      const weightRecency = isSession ? 0.5 : 0.1

      const finalScore = ((m.score ?? 0) * weightVector) + (recencyScore * weightRecency)

      return {
        ...m,
        score: finalScore,
      }
    })

    // Sort by final score descending
    scoredMemories.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))

    return { memories: scoredMemories, tokensUsed: 0 }
  }


  /**
   * Get all memories for a user/agent.
   */
  async getAll(req: GetAllRequest): Promise<MemoryItem[]> {
    const filter = buildFilter(req.userId, req.agentId)
    const points = await this.vectorStore.list(filter, req.limit ?? 100)

    return points.map((p) => ({
      id: p.id,
      memory: (p.payload.memory as string) ?? '',
      hash: (p.payload.hash as string) ?? '',
      userId: (p.payload.user_id as string) ?? undefined,
      agentId: (p.payload.agent_id as string) ?? undefined,
      metadata: (p.payload.metadata as Record<string, unknown>) ?? undefined,
      createdAt: (p.payload.created_at as string) ?? '',
      updatedAt: (p.payload.updated_at as string) ?? '',
    }))
  }

  /**
   * Get a single memory by ID.
   */
  async get(memoryId: string): Promise<MemoryItem | null> {
    const point = await this.vectorStore.get(memoryId)
    if (!point) return null

    return {
      id: point.id,
      memory: (point.payload.memory as string) ?? '',
      hash: (point.payload.hash as string) ?? '',
      userId: (point.payload.user_id as string) ?? undefined,
      agentId: (point.payload.agent_id as string) ?? undefined,
      metadata: (point.payload.metadata as Record<string, unknown>) ?? undefined,
      createdAt: (point.payload.created_at as string) ?? '',
      updatedAt: (point.payload.updated_at as string) ?? '',
    }
  }

  /**
   * Delete a single memory by ID.
   */
  async delete(memoryId: string): Promise<void> {
    await this.vectorStore.delete(memoryId)
  }

  /**
   * Check if all dependencies are reachable.
   */
  async isReady(): Promise<{ llm: boolean; vectorStore: boolean }> {
    const [llm, vectorStore] = await Promise.all([
      this.llm.isHealthy(),
      this.vectorStore.isHealthy(),
    ])
    return { llm, vectorStore }
  }
}
