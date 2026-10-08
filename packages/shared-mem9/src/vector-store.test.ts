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

describe('VectorStore.scrollAll', () => {
  let bodies: Array<Record<string, unknown>>

  afterEach(() => vi.unstubAllGlobals())

  function serve(pages: Array<{ points: unknown[]; next: string | number | null }>) {
    bodies = []
    let page = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: { body?: string }) => {
        bodies.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>)
        const { points, next } = pages[page++] ?? { points: [], next: null }
        return Response.json({ result: { points, next_page_offset: next } })
      }),
    )
  }

  it('follows next_page_offset to the last page', async () => {
    serve([
      { points: [{ id: 'a' }, { id: 'b' }], next: 'c' },
      { points: [{ id: 'c' }], next: null },
    ])
    const points = await store().scrollAll({ must: [] }, { pageSize: 2 })
    expect(points.map((p) => p.id)).toEqual(['a', 'b', 'c'])
    expect(bodies[0]).not.toHaveProperty('offset')
    expect(bodies[1]).toMatchObject({ offset: 'c', limit: 2 })
  })

  it('asks for the dense vector only, and reads either response shape', async () => {
    serve([
      {
        points: [
          { id: 1, payload: { content_hash: 'h1' }, vector: [0.1, 0.2] },
          { id: 2, payload: { content_hash: 'h2' }, vector: { '': [0.3, 0.4], text: { indices: [1], values: [1] } } },
          { id: 3, payload: null },
        ],
        next: null,
      },
    ])
    const points = await store().scrollAll(undefined, { vector: true, payload: ['content_hash'] })
    expect(bodies[0]).toMatchObject({ with_vector: [''], with_payload: ['content_hash'] })
    expect(points).toEqual([
      { id: '1', payload: { content_hash: 'h1' }, vector: [0.1, 0.2] },
      { id: '2', payload: { content_hash: 'h2' }, vector: [0.3, 0.4] },
      { id: '3', payload: {} },
    ])
  })

  it('throws on a failed page instead of returning a partial list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    await expect(store().scrollAll(undefined)).rejects.toThrow(/scroll failed \(500\)/)
  })
})

describe('VectorStore.deletePoints', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('deletes in slices of a thousand ids', async () => {
    const sizes: number[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: { body?: string }) => {
        sizes.push((JSON.parse(init?.body ?? '{}') as { points: string[] }).points.length)
        return Response.json({ result: { status: 'completed' } })
      }),
    )
    await store().deletePoints(Array.from({ length: 2500 }, (_, i) => `id-${i}`))
    expect(sizes).toEqual([1000, 1000, 500])
  })

  it('sends nothing for no ids', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await store().deletePoints([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
