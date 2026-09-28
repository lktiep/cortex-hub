import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { QdrantSearchResult } from './types.js'
import type { SparseVector } from './sparse.js'

// Fakes for the three services Mem9 talks to. Each records what it was asked,
// and the store holds points in memory so dedup has something to find.
type Stored = { id: string; vector: number[]; payload: Record<string, unknown>; sparse?: SparseVector }

const fake = vi.hoisted(() => ({
  hybrid: true,
  points: new Map<string, Stored>(),
  embedCalls: [] as string[][],
  ensureCalls: 0,
  searchesInFlight: 0,
  maxSearchesInFlight: 0,
  dense: [] as QdrantSearchResult[],
  lexical: [] as QdrantSearchResult[] | Error,
  sparseCalls: 0,
  llmReplies: [] as unknown[],
}))

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const vectorOf = (text: string) => [text.length, 1]

function matches(payload: Record<string, unknown>, filter?: Record<string, unknown>): boolean {
  const must = (filter?.must ?? []) as Array<{ key: string; match: { value: unknown } }>
  return must.every((c) => payload[c.key] === c.match.value)
}

vi.mock('./embedder.js', () => ({
  Embedder: class {
    async embed(text: string) {
      fake.embedCalls.push([text])
      return vectorOf(text)
    }
    async embedBatch(texts: string[]) {
      if (texts.length > 0) fake.embedCalls.push(texts)
      return texts.map(vectorOf)
    }
  },
}))

vi.mock('./llm.js', () => ({
  LlmClient: class {
    async chatJson() {
      return { result: fake.llmReplies.shift(), tokensUsed: 1 }
    }
  },
}))

vi.mock('./vector-store.js', () => ({
  VectorStore: class {
    async ensureCollection() {
      fake.ensureCalls += 1
      await pause(5)
      return { sparseVectorEnabled: fake.hybrid }
    }
    async list(filter?: Record<string, unknown>, limit = 100) {
      return [...fake.points.values()].filter((p) => matches(p.payload, filter)).slice(0, limit)
    }
    async search(_vector: number[], _filter?: Record<string, unknown>, limit = 10) {
      fake.searchesInFlight += 1
      fake.maxSearchesInFlight = Math.max(fake.maxSearchesInFlight, fake.searchesInFlight)
      await pause(20)
      fake.searchesInFlight -= 1
      return fake.dense.slice(0, limit)
    }
    async searchSparse(_sparse: SparseVector, _filter?: Record<string, unknown>, limit = 10) {
      fake.sparseCalls += 1
      if (fake.lexical instanceof Error) throw fake.lexical
      return fake.lexical.slice(0, limit)
    }
    async upsert(id: string, vector: number[], payload: Record<string, unknown>, sparse?: SparseVector) {
      fake.points.set(id, { id, vector, payload, sparse })
    }
    async update(id: string, vector: number[], payload: Record<string, unknown>, sparse?: SparseVector) {
      fake.points.set(id, { id, vector, payload, sparse })
    }
    async get(id: string) {
      return fake.points.get(id) ?? null
    }
    async delete(id: string) {
      fake.points.delete(id)
    }
  },
}))

import { Mem9 } from './memory.js'

const mem9 = () =>
  new Mem9({
    llm: { baseUrl: 'http://llm/v1', model: 'stub' },
    embedder: { provider: 'gemini', apiKey: '', model: 'auto', gatewayUrl: 'http://gateway' },
    vectorStore: { url: 'http://qdrant', collection: 'memories' },
  })

const hit = (id: string, score: number): QdrantSearchResult => ({
  id,
  score,
  payload: { memory: `memory ${id}`, created_at: new Date().toISOString() },
})

/** One add(): the facts the first LLM call extracts, the actions the second decides. */
function llmSays(facts: string[], actions: Array<Record<string, unknown>>) {
  fake.llmReplies.push({ facts }, { actions })
}

const add = (m: Mem9, userId = 'alice') => m.add({ messages: [{ role: 'user', content: 'x' }], userId })

beforeEach(() => {
  fake.hybrid = true
  fake.points.clear()
  fake.embedCalls = []
  fake.ensureCalls = 0
  fake.searchesInFlight = 0
  fake.maxSearchesInFlight = 0
  fake.dense = []
  fake.lexical = []
  fake.sparseCalls = 0
  fake.llmReplies = []
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('Mem9.add', () => {
  it('embeds every fact in one request and looks them all up at once', async () => {
    const facts = ['uses pnpm', 'deploys with compose', 'api on port 4000', 'tests with vitest']
    llmSays(facts, facts.map((memory) => ({ type: 'ADD', memory })))

    const { events } = await add(mem9())

    expect(events.map((e) => e.type)).toEqual(['ADD', 'ADD', 'ADD', 'ADD'])
    // Init embeds one probe string; after that, the facts go in a single batch and
    // every ADD reuses its fact's vector.
    expect(fake.embedCalls).toEqual([['dimension detection'], facts])
    expect(fake.maxSearchesInFlight).toBe(facts.length)
  })

  it('embeds only what the LLM reworded, in one request', async () => {
    llmSays(['uses pnpm', 'likes tabs'], [
      { type: 'ADD', memory: 'uses pnpm' },
      { type: 'ADD', memory: 'Prefers tabs over spaces' },
    ])

    await add(mem9())

    expect(fake.embedCalls.at(-1)).toEqual(['Prefers tabs over spaces'])
  })

  it('records a fact it already holds as NONE instead of storing a second copy', async () => {
    const m = mem9()
    llmSays(['uses pnpm'], [{ type: 'ADD', memory: 'uses pnpm' }])
    const [first] = (await add(m)).events

    llmSays(['Uses pnpm '], [{ type: 'ADD', memory: 'Uses pnpm ' }])
    const [again] = (await add(m)).events

    expect(again).toEqual({ type: 'NONE', memoryId: first!.memoryId, newMemory: 'Uses pnpm ' })
    expect(fake.points.size).toBe(1)
  })

  it('catches the same fact twice in one call, before the first write is searchable', async () => {
    llmSays(['uses pnpm'], [
      { type: 'ADD', memory: 'uses pnpm' },
      { type: 'ADD', memory: 'uses pnpm' },
    ])

    const { events } = await add(mem9())

    expect(events.map((e) => e.type)).toEqual(['ADD', 'NONE'])
    expect(events[1]!.memoryId).toBe(events[0]!.memoryId)
    expect(fake.points.size).toBe(1)
  })

  it('does not treat another user\'s memory as a duplicate', async () => {
    const m = mem9()
    llmSays(['uses pnpm'], [{ type: 'ADD', memory: 'uses pnpm' }])
    await add(m, 'alice')
    llmSays(['uses pnpm'], [{ type: 'ADD', memory: 'uses pnpm' }])
    const { events } = await add(m, 'bob')

    expect(events.map((e) => e.type)).toEqual(['ADD'])
    expect(fake.points.size).toBe(2)
  })

  it('writes the lexical half with every memory when the collection has it', async () => {
    llmSays(['Đơn hàng bị treo'], [{ type: 'ADD', memory: 'Đơn hàng bị treo' }])
    await add(mem9())

    const [stored] = [...fake.points.values()]
    expect(stored!.sparse?.indices.length).toBeGreaterThan(0)
  })

  it('writes plain vectors to a collection without the lexical arm', async () => {
    fake.hybrid = false
    llmSays(['uses pnpm'], [{ type: 'ADD', memory: 'uses pnpm' }])
    await add(mem9())

    expect([...fake.points.values()][0]!.sparse).toBeUndefined()
  })
})

describe('Mem9.search', () => {
  const search = (m: Mem9, query = 'pending orders') => m.search({ query, userId: 'alice' })

  it('fuses both arms by rank, ahead of what only one arm found', async () => {
    fake.dense = [hit('a', 0.62), hit('b', 0.58)]
    fake.lexical = [hit('b', 7.1), hit('c', 3.2)]

    const { memories } = await search(mem9())

    expect(memories.map((m) => m.id)).toEqual(['b', 'a', 'c'])
    expect(fake.sparseCalls).toBe(1)
  })

  it('keeps cosine scores when the lexical arm finds nothing', async () => {
    fake.dense = [hit('a', 0.62), hit('b', 0.58)]
    fake.lexical = []

    const { memories } = await mem9().search({ query: 'pending orders', userId: 'alice' })

    // 0.9 × cosine + 0.1 × recency (a memory written just now).
    expect(memories.map((m) => m.score)).toEqual([0.9 * 0.62 + 0.1, 0.9 * 0.58 + 0.1].map((s) => expect.closeTo(s, 3)))
  })

  it('answers from vectors alone when the lexical arm fails', async () => {
    fake.dense = [hit('a', 0.62)]
    fake.lexical = new Error('Not existing vector name: text')

    const { memories } = await search(mem9())

    expect(memories.map((m) => m.id)).toEqual(['a'])
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('lexical arm failed'))
  })

  it('never asks the lexical arm of a collection that has none', async () => {
    fake.hybrid = false
    fake.dense = [hit('a', 0.62)]

    await search(mem9())

    expect(fake.sparseCalls).toBe(0)
  })

  it('skips the lexical arm for a query with no searchable term', async () => {
    fake.dense = [hit('a', 0.62)]

    await search(mem9(), 'a ?')

    expect(fake.sparseCalls).toBe(0)
  })

  it('initialises once for requests that arrive together', async () => {
    const m = mem9()
    await Promise.all([search(m), search(m), search(m)])

    expect(fake.ensureCalls).toBe(1)
  })
})
