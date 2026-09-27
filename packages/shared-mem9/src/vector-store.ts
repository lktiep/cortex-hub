/**
 * Qdrant REST client (zero dependencies)
 *
 * Communicates with Qdrant vector DB via its REST API.
 */

import type { VectorStoreConfig, QdrantPoint, QdrantSearchResult } from './types.js'

export class VectorStore {
  private readonly baseUrl: string
  private readonly collection: string

  constructor(config: VectorStoreConfig) {
    this.baseUrl = config.url.replace(/\/$/, '')
    this.collection = config.collection
  }

  /** Ensure collection exists with correct dimensions */
  async ensureCollection(vectorSize: number): Promise<void> {
    // Check if collection exists
    const checkRes = await fetch(`${this.baseUrl}/collections/${this.collection}`)

    if (checkRes.ok) {
      const info = (await checkRes.json()) as {
        result: { config: { params: { vectors: { size: number } } } }
      }
      const existingSize = info.result.config.params.vectors.size

      if (existingSize !== vectorSize) {
        // Delete and recreate with correct dimensions
        await fetch(`${this.baseUrl}/collections/${this.collection}`, {
          method: 'DELETE',
        })
      } else {
        return // Collection exists with correct dims
      }
    }

    // Create collection
    const res = await fetch(`${this.baseUrl}/collections/${this.collection}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vectors: {
          size: vectorSize,
          distance: 'Cosine',
        },
      }),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Failed to create Qdrant collection (${res.status}): ${err}`)
    }
  }

  /** Upsert a point (memory) into the collection */
  async upsert(
    id: string,
    vector: number[],
    payload: Record<string, unknown>,
  ): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/collections/${this.collection}/points`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          points: [{ id, vector, payload }],
        }),
      },
    )

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Qdrant upsert failed (${res.status}): ${err}`)
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

  /** List all points matching a filter */
  async list(
    filter: Record<string, unknown>,
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
  ): Promise<void> {
    // Qdrant upsert overwrites, so this is the same as upsert
    await this.upsert(id, vector, payload)
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
