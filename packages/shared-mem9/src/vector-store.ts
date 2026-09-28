/**
 * Qdrant REST client (zero dependencies)
 *
 * Communicates with Qdrant vector DB via its REST API.
 */

import type { VectorStoreConfig, QdrantPoint, QdrantSearchResult } from './types.js'
import { SPARSE_VECTOR_NAME } from './sparse.js'
import type { SparseVector } from './sparse.js'

export class VectorStore {
  private readonly baseUrl: string
  private readonly collection: string

  constructor(config: VectorStoreConfig) {
    this.baseUrl = config.url.replace(/\/$/, '')
    this.collection = config.collection
  }

  /**
   * What a collection is, before deciding whether it can be used as it stands.
   *
   * The sparse vector matters because Qdrant will not add one to a collection
   * that already exists — `PATCH` answers "Not existing vector name" — so a
   * lexical arm can only be turned on for a collection created with it. Knowing
   * that up front is what lets the caller degrade to vector-only search instead
   * of writing points Qdrant would reject.
   */
  async getCollectionInfo(): Promise<{
    exists: boolean
    vectorSize?: number
    sparseVectorNames: string[]
  }> {
    const res = await fetch(`${this.baseUrl}/collections/${this.collection}`)
    if (!res.ok) return { exists: false, sparseVectorNames: [] }

    const info = (await res.json()) as {
      result: {
        config: {
          params: {
            vectors?: { size?: number }
            sparse_vectors?: Record<string, unknown>
          }
        }
      }
    }
    const params = info.result.config.params

    return {
      exists: true,
      vectorSize: params.vectors?.size,
      sparseVectorNames: Object.keys(params.sparse_vectors ?? {}),
    }
  }

  /**
   * Ensure collection exists with correct dimensions.
   *
   * `sparseVectorName` is honoured only when the collection has to be created
   * anyway: adding one to a live collection is not something Qdrant supports, and
   * silently dropping a populated collection to gain it would throw away every
   * branch indexed in it. Pass `recreate` to accept that cost deliberately.
   */
  async ensureCollection(
    vectorSize: number,
    opts: { sparseVectorName?: string; recreate?: boolean } = {},
  ): Promise<{ sparseVectorEnabled: boolean }> {
    const { sparseVectorName, recreate = false } = opts
    const info = await this.getCollectionInfo()

    if (info.exists) {
      const dimsMatch = info.vectorSize === vectorSize
      const hasSparse = sparseVectorName ? info.sparseVectorNames.includes(sparseVectorName) : true

      if (dimsMatch && (hasSparse || !recreate)) {
        return { sparseVectorEnabled: sparseVectorName ? hasSparse : false }
      }

      // Wrong dimensions, or a deliberate rebuild to gain the sparse vector.
      await fetch(`${this.baseUrl}/collections/${this.collection}`, { method: 'DELETE' })
    }

    const body: Record<string, unknown> = {
      vectors: {
        size: vectorSize,
        distance: 'Cosine',
      },
    }
    if (sparseVectorName) {
      // `idf` makes Qdrant supply the inverse-document-frequency weight, so a
      // stored vector only has to carry term frequency. Without it the score is
      // a plain dot product and a term that appears everywhere counts as much as
      // the one that identifies the file.
      body.sparse_vectors = { [sparseVectorName]: { modifier: 'idf' } }
    }

    const res = await fetch(`${this.baseUrl}/collections/${this.collection}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Failed to create Qdrant collection (${res.status}): ${err}`)
    }

    return { sparseVectorEnabled: Boolean(sparseVectorName) }
  }

  /** How many points match a filter — cheaper than scrolling to find out. */
  async count(filter?: Record<string, unknown>): Promise<number> {
    const res = await fetch(`${this.baseUrl}/collections/${this.collection}/points/count`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter, exact: true }),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Qdrant count failed (${res.status}): ${err}`)
    }

    const data = (await res.json()) as { result: { count: number } }
    return data.result.count
  }

  /**
   * Upsert a point (memory) into the collection.
   *
   * With a sparse vector the point addresses both by name; without one it is a
   * plain dense point, which is all a collection created before hybrid search
   * can hold.
   */
  async upsert(
    id: string,
    vector: number[],
    payload: Record<string, unknown>,
    sparseVector?: SparseVector,
  ): Promise<void> {
    const point = sparseVector
      ? { id, vector: { '': vector, [SPARSE_VECTOR_NAME]: sparseVector }, payload }
      : { id, vector, payload }

    const res = await fetch(
      `${this.baseUrl}/collections/${this.collection}/points`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          points: [point],
        }),
      },
    )

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Qdrant upsert failed (${res.status}): ${err}`)
    }
  }

  /**
   * Upsert many points in one request.
   *
   * Qdrant accepts an array of points per PUT, so writing them one at a time
   * cost one HTTP roundtrip per chunk — the dominant cost of indexing once the
   * embedder itself was batched. Same endpoint, same body shape, just not one
   * point at a time.
   */
  async upsertBatch(
    points: Array<{
      id: string
      vector: number[]
      payload: Record<string, unknown>
      sparseVector?: SparseVector
    }>,
    sparseVectorName?: string,
  ): Promise<void> {
    if (points.length === 0) return

    // A point in a collection that has both kinds of vector addresses them by
    // name, and the unnamed dense vector's name is the empty string.
    const body = points.map(({ id, vector, payload, sparseVector }) =>
      sparseVectorName && sparseVector
        ? { id, vector: { '': vector, [sparseVectorName]: sparseVector }, payload }
        : { id, vector, payload },
    )

    const res = await fetch(
      `${this.baseUrl}/collections/${this.collection}/points`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points: body }),
      },
    )

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Qdrant batch upsert failed (${res.status}): ${err}`)
    }
  }

  /** Search for similar vectors */
  async search(
    vector: number[],
    filter?: Record<string, unknown>,
    limit = 10,
  ): Promise<QdrantSearchResult[]> {
    const body: Record<string, unknown> = {
      vector,
      limit,
      with_payload: true,
    }

    if (filter) {
      body.filter = filter
    }

    const res = await fetch(
      `${this.baseUrl}/collections/${this.collection}/points/search`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    )

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Qdrant search failed (${res.status}): ${err}`)
    }

    const data = (await res.json()) as {
      result: Array<{ id: string; score: number; payload: Record<string, unknown> }>
    }

    return data.result.map((r) => ({
      id: String(r.id),
      score: r.score,
      payload: r.payload,
    }))
  }

  /**
   * The lexical arm: rank by BM25 over the sparse vector.
   *
   * Scores are BM25, not similarities — unbounded and only comparable within one
   * query — so a caller fuses these by rank rather than by score.
   */
  async searchSparse(
    sparseVector: SparseVector,
    filter?: Record<string, unknown>,
    limit = 10,
  ): Promise<QdrantSearchResult[]> {
    const res = await fetch(
      `${this.baseUrl}/collections/${this.collection}/points/query`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: sparseVector,
          using: SPARSE_VECTOR_NAME,
          filter,
          limit,
          with_payload: true,
        }),
      },
    )

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Qdrant sparse search failed (${res.status}): ${err}`)
    }

    const data = (await res.json()) as {
      result: { points: Array<{ id: string; score: number; payload: Record<string, unknown> }> }
    }

    return data.result.points.map((r) => ({
      id: String(r.id),
      score: r.score,
      payload: r.payload,
    }))
  }

  /** Get a specific point by ID */
  async get(id: string): Promise<QdrantPoint | null> {
    const res = await fetch(
      `${this.baseUrl}/collections/${this.collection}/points/${id}`,
    )

    if (res.status === 404) return null
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Qdrant get failed (${res.status}): ${err}`)
    }

    const data = (await res.json()) as {
      result: { id: string; payload: Record<string, unknown> }
    }

    return {
      id: String(data.result.id),
      payload: data.result.payload,
    }
  }

  /** List points matching a filter — every point when there is none */
  async list(
    filter?: Record<string, unknown>,
    limit = 100,
  ): Promise<QdrantPoint[]> {
    const res = await fetch(
      `${this.baseUrl}/collections/${this.collection}/points/scroll`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filter,
          limit,
          with_payload: true,
        }),
      },
    )

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Qdrant scroll failed (${res.status}): ${err}`)
    }

    const data = (await res.json()) as {
      result: {
        points: Array<{ id: string; payload: Record<string, unknown> }>
      }
    }

    return data.result.points.map((p) => ({
      id: String(p.id),
      payload: p.payload,
    }))
  }

  /** Delete a point by ID */
  async delete(id: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/collections/${this.collection}/points/delete`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          points: [id],
        }),
      },
    )

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Qdrant delete failed (${res.status}): ${err}`)
    }
  }

  /**
   * Delete every point matching a payload filter.
   *
   * Needed because re-indexing generates fresh random point ids: without a
   * filtered delete the previous run's points stay behind, so each re-index
   * appends a duplicate set and vectors for removed files never disappear.
   */
  async deleteByFilter(filter: Record<string, unknown>): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/collections/${this.collection}/points/delete?wait=true`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filter }),
      },
    )

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Qdrant delete-by-filter failed (${res.status}): ${err}`)
    }
  }

  /** Update a point's vector and/or payload */
  async update(
    id: string,
    vector: number[],
    payload: Record<string, unknown>,
    sparseVector?: SparseVector,
  ): Promise<void> {
    // Qdrant upsert overwrites, so this is the same as upsert
    await this.upsert(id, vector, payload, sparseVector)
  }

  /** Check if Qdrant is reachable */
  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/collections/${this.collection}`, {
        signal: AbortSignal.timeout(3000),
      })
      return res.ok
    } catch {
      return false
    }
  }
}
