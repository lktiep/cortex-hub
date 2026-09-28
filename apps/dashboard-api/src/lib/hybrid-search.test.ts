import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildHybridQuery, hasSparseVector, clearCapabilityCache, HYBRID_FETCH_FLOOR } from './hybrid-search.js'
import { querySparseVector, SPARSE_VECTOR_NAME } from '@cortex/shared-mem9'

const realFetch = globalThis.fetch

describe('buildHybridQuery', () => {
  const vector = [0.1, 0.2, 0.3]

  it('asks both arms for the same candidates and fuses by reciprocal rank', () => {
    const body = buildHybridQuery({ vector, query: 'resolve repo names', limit: 30 })!

    expect(body.query).toEqual({ fusion: 'rrf' })
    expect(body.prefetch).toHaveLength(2)
    expect(body.prefetch[0]!.query).toBe(vector)
    expect(body.prefetch[1]!.using).toBe(SPARSE_VECTOR_NAME)
    expect(body.prefetch[1]!.query).toEqual(querySparseVector('resolve repo names'))
    expect(body.prefetch.every((arm) => arm.limit === 30)).toBe(true)
    expect(body.limit).toBe(30)
  })

  it('filters inside each arm, so neither spends its budget on discarded chunks', () => {
    const filter = { must: [{ key: 'branch', match: { value: 'master' } }] }
    const body = buildHybridQuery({ vector, query: 'embedder', limit: 10, filter })!

    expect(body.prefetch.every((arm) => arm.filter === filter)).toBe(true)
  })

  it('declines when the question has no searchable term, leaving the vector arm alone', () => {
    expect(buildHybridQuery({ vector, query: '{ } ; 42', limit: 10 })).toBeNull()
    expect(buildHybridQuery({ vector, query: '', limit: 10 })).toBeNull()
  })

  it('has a floor high enough for fusion to have something to fuse', () => {
    expect(HYBRID_FETCH_FLOOR).toBeGreaterThanOrEqual(30)
  })
})

describe('hasSparseVector', () => {
  beforeEach(() => {
    clearCapabilityCache()
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    clearCapabilityCache()
  })

  function stubCollection(body: unknown, status = 200) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    return fetchMock
  }

  it('is true for a collection indexed with the lexical arm', async () => {
    stubCollection({ result: { config: { params: { sparse_vectors: { [SPARSE_VECTOR_NAME]: {} } } } } })
    await expect(hasSparseVector('http://qdrant', 'c1')).resolves.toBe(true)
  })

  it('is false for a collection indexed before hybrid search existed', async () => {
    stubCollection({ result: { config: { params: { vectors: { size: 384 } } } } })
    await expect(hasSparseVector('http://qdrant', 'c2')).resolves.toBe(false)
  })

  it('is false when a different sparse vector is present', async () => {
    stubCollection({ result: { config: { params: { sparse_vectors: { something_else: {} } } } } })
    await expect(hasSparseVector('http://qdrant', 'c3')).resolves.toBe(false)
  })

  it('degrades to vector-only when Qdrant cannot be reached', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    await expect(hasSparseVector('http://qdrant', 'c4')).resolves.toBe(false)
  })

  it('degrades to vector-only for a collection that does not exist', async () => {
    stubCollection({ status: { error: "Collection `c5` doesn't exist!" } }, 404)
    await expect(hasSparseVector('http://qdrant', 'c5')).resolves.toBe(false)
  })

  it('probes once and caches, because this runs on every search', async () => {
    const fetchMock = stubCollection({
      result: { config: { params: { sparse_vectors: { [SPARSE_VECTOR_NAME]: {} } } } },
    })

    await hasSparseVector('http://qdrant', 'c6')
    await hasSparseVector('http://qdrant', 'c6')
    await hasSparseVector('http://qdrant', 'c6')

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('caches per collection, not globally', async () => {
    const fetchMock = stubCollection({
      result: { config: { params: { sparse_vectors: { [SPARSE_VECTOR_NAME]: {} } } } },
    })

    await hasSparseVector('http://qdrant', 'c7')
    await hasSparseVector('http://qdrant', 'c8')

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
