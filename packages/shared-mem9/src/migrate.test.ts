import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { copyToHybridCollection, switchToHybridCollection, describeCollection } from './migrate.js'
import { SPARSE_VECTOR_NAME } from './sparse.js'

// A Qdrant that keeps collections in memory and answers the handful of REST
// calls the migration makes, including the ones that behave oddly for an alias.
type Point = { id: string | number; vector: unknown; payload: Record<string, unknown> }
type Collection = { size: number; sparse: string[]; points: Map<string, Point>; indexes: Record<string, string> }

let collections: Map<string, Collection>
let aliases: Map<string, string>
let snapshots: string[]
/** Runs before a request is answered, to simulate writes landing mid-migration. */
let onRequest: ((method: string, path: string) => void) | undefined

const ok = (result: unknown) => new Response(JSON.stringify({ result, status: 'ok' }))
const fail = (status: number, error: string) => new Response(JSON.stringify({ status: { error } }), { status })
const resolve = (name: string) => aliases.get(name) ?? name

function qdrantStub(url: string, init?: { method?: string; body?: string }): Response {
  const method = init?.method ?? 'GET'
  const path = new URL(url).pathname
  const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {}
  onRequest?.(method, path)

  if (path === '/aliases') {
    return ok({ aliases: [...aliases].map(([alias_name, collection_name]) => ({ alias_name, collection_name })) })
  }
  if (path === '/collections/aliases' && method === 'POST') {
    for (const action of body.actions as Array<{ create_alias: { collection_name: string; alias_name: string } }>) {
      const { collection_name, alias_name } = action.create_alias
      if (collections.has(alias_name)) return fail(409, `Collection with name ${alias_name} already exists`)
      aliases.set(alias_name, collection_name)
    }
    return ok(true)
  }

  const [, , name, ...rest] = path.split('/')
  const sub = rest.join('/')
  const collection = collections.get(resolve(name!))

  if (sub === '') {
    if (method === 'GET') {
      if (!collection) return fail(404, 'Not found')
      return ok({
        points_count: collection.points.size,
        config: {
          params: {
            vectors: { size: collection.size, distance: 'Cosine' },
            ...(collection.sparse.length ? { sparse_vectors: Object.fromEntries(collection.sparse.map((s) => [s, {}])) } : {}),
          },
        },
        payload_schema: Object.fromEntries(Object.entries(collection.indexes).map(([f, t]) => [f, { data_type: t }])),
      })
    }
    if (method === 'PUT') {
      if (aliases.has(name!) || collections.has(name!)) return fail(409, 'already exists')
      const vectors = body.vectors as { size: number }
      collections.set(name!, {
        size: vectors.size,
        sparse: Object.keys((body.sparse_vectors as object) ?? {}),
        points: new Map(),
        indexes: {},
      })
      return ok(true)
    }
    if (method === 'DELETE') {
      // Qdrant answers `false` for an alias and deletes nothing.
      return ok(aliases.has(name!) ? false : collections.delete(name!))
    }
  }
  if (!collection) return fail(404, `Collection ${name} not found`)

  if (sub === 'index') {
    collection.indexes[body.field_name as string] = body.field_schema as string
    return ok(true)
  }
  if (sub === 'snapshots' && method === 'POST') {
    const snapshot = `${name}-snapshot-${snapshots.length}.snapshot`
    snapshots.push(snapshot)
    return ok({ name: snapshot })
  }
  if (sub === 'points/scroll') {
    const all = [...collection.points.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)))
    const start = body.offset === undefined ? 0 : all.findIndex((p) => p.id === body.offset)
    const page = all.slice(start, start + (body.limit as number))
    const next = all[start + (body.limit as number)]
    return ok({
      points: page.map((p) => ({ id: p.id, payload: structuredClone(p.payload), ...(body.with_vector ? { vector: p.vector } : {}) })),
      next_page_offset: next?.id ?? null,
    })
  }
  if (sub === 'points' && method === 'PUT') {
    for (const point of body.points as Point[]) {
      if (collection.sparse.length === 0 && !Array.isArray(point.vector)) return fail(400, 'Not existing vector name')
      collection.points.set(String(point.id), structuredClone(point))
    }
    return ok({ status: 'completed' })
  }
  if (sub === 'points/delete') {
    for (const id of body.points as Array<string | number>) collection.points.delete(String(id))
    return ok({ status: 'completed' })
  }
  return fail(404, `unhandled ${method} ${path}`)
}

function seed(name: string, memories: string[], sparse: string[] = []) {
  collections.set(name, {
    size: 3,
    sparse,
    indexes: { user_id: 'keyword' },
    points: new Map(
      memories.map((memory, i) => {
        const id = `00000000-0000-0000-0000-00000000000${i}`
        return [id, { id, vector: [i, 1, 0], payload: { memory, user_id: 'alice', created_at: `2026-0${i + 1}-01` } }]
      }),
    ),
  })
}

const QDRANT = 'http://qdrant:6333'
const opts = { qdrantUrl: QDRANT, source: 'memories', target: 'memories_hybrid', batchSize: 2 }

function reset() {
  collections = new Map()
  aliases = new Map()
  snapshots = []
  seed('memories', ['Đơn hàng bị treo ở pending', 'Postgres on 5433', 'cart_v2_enabled gates checkout'])
}

beforeEach(() => {
  reset()
  onRequest = undefined
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => qdrantStub(url, init)))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('copyToHybridCollection', () => {
  it('copies every point with its vector, payload and a lexical half', async () => {
    const report = await copyToHybridCollection(opts)

    const target = collections.get('memories_hybrid')!
    expect(target.sparse).toEqual([SPARSE_VECTOR_NAME])
    expect(target.indexes).toEqual({ user_id: 'keyword' })
    expect(report).toMatchObject({ points: 3, removed: 0 })
    for (const [id, original] of collections.get('memories')!.points) {
      const copy = target.points.get(id)!
      const vector = copy.vector as Record<string, unknown>
      expect(copy.payload).toEqual(original.payload)
      expect(vector['']).toEqual(original.vector)
      expect((vector[SPARSE_VECTOR_NAME] as { indices: number[] }).indices.length).toBeGreaterThan(0)
    }
  })

  it('can run again, catching up on what changed since', async () => {
    await copyToHybridCollection(opts)
    const source = collections.get('memories')!.points
    const [first, second] = [...source.keys()]
    source.get(first!)!.payload.memory = 'Postgres moved to 5434'
    source.delete(second!)

    const report = await copyToHybridCollection(opts)

    const target = collections.get('memories_hybrid')!.points
    expect(target.get(first!)!.payload.memory).toBe('Postgres moved to 5434')
    expect(target.has(second!)).toBe(false)
    expect(report).toMatchObject({ points: 2, removed: 1 })
  })

  it('refuses a source that already has the lexical arm', async () => {
    seed('memories', ['x'], [SPARSE_VECTOR_NAME])
    await expect(copyToHybridCollection(opts)).rejects.toThrow(/already has the lexical arm/)
  })

  it('refuses to write into a target that is something else', async () => {
    seed('memories_hybrid', ['unrelated'])
    await expect(copyToHybridCollection(opts)).rejects.toThrow(/not a hybrid copy/)
  })
})

describe('switchToHybridCollection', () => {
  it('snapshots the source and leaves its name as an alias of the copy', async () => {
    const report = await switchToHybridCollection(opts)

    expect(report).toMatchObject({ alreadySwitched: false, points: 3, snapshot: 'memories-snapshot-0.snapshot' })
    expect(collections.has('memories')).toBe(false)
    expect(aliases.get('memories')).toBe('memories_hybrid')
    const described = await describeCollection(QDRANT, 'memories')
    expect(described).toMatchObject({ isAlias: true, collection: 'memories_hybrid', points: 3 })
    expect(described!.sparseVectorNames).toEqual([SPARSE_VECTOR_NAME])
  })

  it('carries over a memory written after the copy but before the delete', async () => {
    onRequest = (method, path) => {
      if (method === 'POST' && path.endsWith('/snapshots')) {
        collections.get('memories')!.points.set('late', { id: 'late', vector: [9, 9, 9], payload: { memory: 'written late' } })
      }
    }

    await switchToHybridCollection(opts)

    expect(collections.get('memories_hybrid')!.points.get('late')?.payload.memory).toBe('written late')
  })

  it('replaces an empty collection recreated in the gap, but not one holding memories', async () => {
    let recreate: string[] | null = []
    onRequest = (method, path) => {
      if (recreate && method === 'POST' && path === '/collections/aliases') {
        seed('memories', recreate)
        recreate = null
      }
    }
    await switchToHybridCollection(opts)
    expect(aliases.get('memories')).toBe('memories_hybrid')

    // Start over, and this time a process writes into the recreated collection.
    reset()
    recreate = ['a memory nobody copied']
    await expect(switchToHybridCollection(opts)).rejects.toThrow(/snapshot memories-snapshot-0.snapshot holds the original/)
    expect(collections.get('memories')!.points.size).toBe(1)
  })

  it('does nothing the second time', async () => {
    await switchToHybridCollection(opts)
    const report = await switchToHybridCollection(opts)

    expect(report.alreadySwitched).toBe(true)
    expect(snapshots).toHaveLength(1)
  })

  it('refuses when the name is an alias of some other collection', async () => {
    seed('elsewhere', ['x'])
    collections.delete('memories')
    aliases.set('memories', 'elsewhere')

    await expect(switchToHybridCollection(opts)).rejects.toThrow(/alias, of elsewhere/)
  })
})
