/**
 * mem9 — Core Memory class
 *
 * Implements the mem9 pipeline:
 * add()    → 2 LLM calls (extract facts + decide actions) + embed + Qdrant
 * search() → 1 embed call + Qdrant search
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
} from './types.js'
import { Embedder } from './embedder.js'
import { VectorStore } from './vector-store.js'
import { LlmClient } from './llm.js'
import { getFactExtractionPrompt, getMemoryUpdatePrompt } from './prompts.js'

/** Internal type for LLM action responses */
interface MemoryAction {
  type: 'ADD' | 'UPDATE' | 'DELETE' | 'NONE'
  memory?: string
  memoryId?: string
  oldMemory?: string
  newMemory?: string
}

/** Build a Qdrant filter for user/agent scoping */
function buildFilter(userId: string, agentId?: string): Record<string, unknown> {
  const conditions: Array<Record<string, unknown>> = [
    { key: 'user_id', match: { value: userId } },
  ]
  if (agentId) {
    conditions.push({ key: 'agent_id', match: { value: agentId } })
  }
  return { must: conditions }
}

/** Create a short hash from text for dedup detection */
function hashText(text: string): string {
  return createHash('md5').update(text.toLowerCase().trim()).digest('hex').slice(0, 16)
}

export class Mem9 {
  private readonly embedder: Embedder
  private readonly vectorStore: VectorStore
  private readonly llm: LlmClient
  private initialized = false

  constructor(private readonly config: Mem9Config) {
    this.embedder = new Embedder(config.embedder)
    this.vectorStore = new VectorStore(config.vectorStore)
    this.llm = new LlmClient(config.llm)
  }

  /** Initialize collection with correct vector dimensions */
  private async ensureInit(): Promise<void> {
    if (this.initialized) return

    // Embed a test string to detect dimensions
    const testVec = await this.embedder.embed('dimension detection')
    await this.vectorStore.ensureCollection(testVec.length)
    this.initialized = true
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
    const filter = buildFilter(req.userId, req.agentId)
    const existingMemories: Array<{ id: string; memory: string }> = []

    for (const fact of facts) {
      const vec = await this.embedder.embed(fact)
      const similar = await this.vectorStore.search(vec, filter, 5)

      for (const hit of similar) {
        if (hit.score > 0.7) {
          const mem = {
            id: hit.id,
            memory: (hit.payload.memory as string) ?? '',
          }
          // Avoid duplicates in the comparison list
          if (!existingMemories.find((m) => m.id === mem.id)) {
            existingMemories.push(mem)
          }
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

    // ── Step 4: Execute actions ──
    for (const action of actions) {
      switch (action.type) {
        case 'ADD': {
          if (!action.memory) break
          const id = randomUUID()
          const vec = await this.embedder.embed(action.memory)
          await this.vectorStore.upsert(id, vec, {
            memory: action.memory,
            hash: hashText(action.memory),
            user_id: req.userId,
            agent_id: req.agentId ?? '',
            metadata: req.metadata ?? {},
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          events.push({
            type: 'ADD',
            memoryId: id,
            newMemory: action.memory,
          })
          break
        }

        case 'UPDATE': {
          if (!action.memoryId || !action.newMemory) break
          const vec = await this.embedder.embed(action.newMemory)
          // Preserve existing payload, update memory and timestamp
          const existing = await this.vectorStore.get(action.memoryId)
          const payload = existing?.payload ?? {}
          await this.vectorStore.update(action.memoryId, vec, {
            ...payload,
            memory: action.newMemory,
            hash: hashText(action.newMemory),
            updated_at: new Date().toISOString(),
          })
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
    const results = await this.vectorStore.search(vec, filter, req.limit ?? 10)

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
