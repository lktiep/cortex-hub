import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { VectorStore } from './vector-store.js'

type Collection = { size: number; points: number; sparse?: string[] }

let collection: Collection | null
let calls: string[]

function stub(url: string, init?: { method?: string; body?: string }): Response {
  const method = init?.method ?? 'GET'
  calls.push(method)
  if (method === 'GET') {
    if (!collection) return new Response('{}', { status: 404 })
    return Response.json({
      result: {
        points_count: collection.points,
        config: {
          params: {
            vectors: { size: collection.size },
            sparse_vectors: Object.fromEntries((collection.sparse ?? []).map((n) => [n, {}])),
          },
        },
      },
    })
  }
  if (method === 'DELETE') {
    collection = null
    return Response.json({ result: true })
  }
  if (method === 'PUT') {
    const body = JSON.parse(init?.body ?? '{}') as { vectors: { size: number } }
    collection = { size: body.vectors.size, points: 0 }
    return Response.json({ result: true })
  }
  throw new Error(`unexpected ${method} ${url}`)
}

const store = () => new VectorStore({ url: 'http://qdrant:6333', collection: 'memories' })

describe('VectorStore.ensureCollection', () => {
  beforeEach(() => {
    calls = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => stub(url, init)))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('creates a missing collection', async () => {
    collection = null
    await store().ensureCollection(384)
    expect(collection).toEqual({ size: 384, points: 0 })
  })

  it('leaves a matching collection alone', async () => {
    collection = { size: 384, points: 146 }
    await store().ensureCollection(384)
    expect(calls).toEqual(['GET'])
  })

  it('refuses to drop a populated collection written by another embedding model', async () => {
    collection = { size: 384, points: 146 }
    await expect(store().ensureCollection(1024)).rejects.toThrow(/holds 146 points of dimension 384.*produces 1024/)
    expect(calls).not.toContain('DELETE')
    expect(collection).toEqual({ size: 384, points: 146 })
  })

  it('rebuilds an empty collection with the wrong dimensions', async () => {
    collection = { size: 384, points: 0 }
    await store().ensureCollection(1024)
    expect(collection).toEqual({ size: 1024, points: 0 })
  })

  it('rebuilds a populated one only when told to', async () => {
    collection = { size: 384, points: 146 }
    await store().ensureCollection(1024, { recreate: true })
    expect(collection).toEqual({ size: 1024, points: 0 })
  })
})
