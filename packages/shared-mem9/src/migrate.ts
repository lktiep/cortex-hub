/**
 * Giving an existing memory collection its lexical arm.
 *
 * Qdrant cannot add a sparse vector to a collection that already exists, so a
 * memory collection created before hybrid search is searched by vector alone
 * until its points are copied into one that has it. Nothing here re-embeds: the
 * dense vectors are copied as they are, and only the BM25 half is computed.
 *
 * The copy is safe to repeat. The switch, which puts the new collection behind
 * the old name, is the one step that deletes anything, and it takes a snapshot
 * and re-checks the copy first.
 */

import { documentSparseVector, tokenizeText, SPARSE_VECTOR_NAME } from './sparse.js'

type PointId = string | number

interface ScrolledPoint {
  id: PointId
  payload: Record<string, unknown>
  vector?: number[]
}

export interface CollectionShape {
  name: string
  /** The collection the name resolves to — itself, unless it is an alias. */
  collection: string
  isAlias: boolean
  points: number
  vectorSize?: number
  distance?: string
  sparseVectorNames: string[]
  payloadIndexes: Record<string, string>
}

export interface HybridCopyOptions {
  qdrantUrl: string
  /** The collection memories are in now. */
  source: string
  /** The collection to create with both arms. */
  target: string
  batchSize?: number
}

export interface HybridCopyReport {
  source: string
  target: string
  /** Points in the source when the copy finished. */
  points: number
  /** Points written to the target, including rewrites of ones already there. */
  copied: number
  /** Points in the target that the source no longer has, deleted to match. */
  removed: number
  /** The mean memory length, in tokens, the sparse vectors were normalised by. */
  averageLength: number
}

export interface HybridSwitchReport extends HybridCopyReport {
  snapshot: string
  alreadySwitched: boolean
}

const DEFAULT_BATCH = 256

async function qdrant<T>(baseUrl: string, path: string, init?: { method: string; body?: unknown }): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: init?.method ?? 'GET',
    headers: init?.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  })
  if (!res.ok) {
    throw new Error(`Qdrant ${init?.method ?? 'GET'} ${path} failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
  }
  return ((await res.json()) as { result: T }).result
}

/** What a name refers to in Qdrant, or null when it is neither a collection nor an alias. */
export async function describeCollection(qdrantUrl: string, name: string): Promise<CollectionShape | null> {
  const baseUrl = qdrantUrl.replace(/\/$/, '')
  const res = await fetch(`${baseUrl}/collections/${name}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Qdrant GET /collections/${name} failed (${res.status}): ${(await res.text()).slice(0, 300)}`)

  const info = ((await res.json()) as {
    result: {
      points_count?: number
      config: {
        params: {
          vectors?: { size?: number; distance?: string }
          sparse_vectors?: Record<string, unknown>
        }
      }
      payload_schema?: Record<string, { data_type?: string }>
    }
  }).result

  const { aliases } = await qdrant<{ aliases: Array<{ alias_name: string; collection_name: string }> }>(baseUrl, '/aliases')
  const alias = aliases.find((a) => a.alias_name === name)

  return {
    name,
    collection: alias?.collection_name ?? name,
    isAlias: Boolean(alias),
    points: info.points_count ?? 0,
    vectorSize: info.config.params.vectors?.size,
    distance: info.config.params.vectors?.distance,
    sparseVectorNames: Object.keys(info.config.params.sparse_vectors ?? {}),
    payloadIndexes: Object.fromEntries(
      Object.entries(info.payload_schema ?? {})
        .filter(([, schema]) => schema.data_type)
        .map(([field, schema]) => [field, schema.data_type!]),
    ),
  }
}

async function* scroll(
  baseUrl: string,
  collection: string,
  withVector: boolean,
  batchSize: number,
): AsyncGenerator<ScrolledPoint[]> {
  let offset: PointId | null = null
  do {
    const page: { points: ScrolledPoint[]; next_page_offset: PointId | null } = await qdrant(
      baseUrl,
      `/collections/${collection}/points/scroll`,
      { method: 'POST', body: { limit: batchSize, offset: offset ?? undefined, with_payload: true, with_vector: withVector } },
    )
    if (page.points.length > 0) yield page.points
    offset = page.next_page_offset
  } while (offset !== null && offset !== undefined)
}

async function readAll(baseUrl: string, collection: string, batchSize: number): Promise<Map<string, ScrolledPoint>> {
  const points = new Map<string, ScrolledPoint>()
  for await (const page of scroll(baseUrl, collection, false, batchSize)) {
    for (const point of page) points.set(String(point.id), point)
  }
  return points
}

/** JSON with object keys in a fixed order, so two copies of a payload compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** Points the target lacks or holds an older version of, and points only the target has. */
async function compare(
  baseUrl: string,
  source: string,
  target: string,
  batchSize: number,
): Promise<{ stale: PointId[]; extra: PointId[]; points: number }> {
  const [inSource, inTarget] = await Promise.all([
    readAll(baseUrl, source, batchSize),
    readAll(baseUrl, target, batchSize),
  ])
  const stale = [...inSource.entries()]
    .filter(([key, point]) => {
      const copy = inTarget.get(key)
      return !copy || canonical(copy.payload) !== canonical(point.payload)
    })
    .map(([, point]) => point.id)
  const extra = [...inTarget.entries()].filter(([key]) => !inSource.has(key)).map(([, point]) => point.id)
  return { stale, extra, points: inSource.size }
}

async function ensureTarget(baseUrl: string, source: CollectionShape, target: string): Promise<void> {
  const existing = await describeCollection(baseUrl, target)
  if (existing) {
    // A re-run finds the collection the last one made. Anything else by that name
    // is not ours to write into.
    if (existing.isAlias || existing.vectorSize !== source.vectorSize || !existing.sparseVectorNames.includes(SPARSE_VECTOR_NAME)) {
      throw new Error(
        `${target} already exists and is not a hybrid copy of ${source.name} ` +
          `(size ${existing.vectorSize}, sparse [${existing.sparseVectorNames.join(', ')}]${existing.isAlias ? ', alias' : ''}).`,
      )
    }
    return
  }

  await qdrant(baseUrl, `/collections/${target}`, {
    method: 'PUT',
    body: {
      vectors: { size: source.vectorSize, distance: source.distance ?? 'Cosine' },
      // Same declaration a new collection gets from VectorStore.ensureCollection.
      sparse_vectors: { [SPARSE_VECTOR_NAME]: { modifier: 'idf' } },
    },
  })
  for (const [field, schema] of Object.entries(source.payloadIndexes)) {
    await qdrant(baseUrl, `/collections/${target}/index?wait=true`, {
      method: 'PUT',
      body: { field_name: field, field_schema: schema },
    })
  }
}

async function copyPoints(
  baseUrl: string,
  source: string,
  target: string,
  batchSize: number,
  averageLength: number,
  only?: Set<string>,
): Promise<number> {
  let copied = 0
  for await (const page of scroll(baseUrl, source, true, batchSize)) {
    const points = page
      .filter((point) => !only || only.has(String(point.id)))
      .map((point) => ({
        id: point.id,
        vector: {
          '': point.vector,
          [SPARSE_VECTOR_NAME]: documentSparseVector(String(point.payload.memory ?? ''), averageLength, tokenizeText),
        },
        payload: point.payload,
      }))
    if (points.length === 0) continue
    await qdrant(baseUrl, `/collections/${target}/points?wait=true`, { method: 'PUT', body: { points } })
    copied += points.length
  }
  return copied
}

/**
 * Bring the target level with the source: rewrite what changed, drop what was
 * deleted, then check. Memories keep being written while this runs, so it goes
 * round until a comparison comes back clean.
 */
async function sync(
  baseUrl: string,
  source: string,
  target: string,
  batchSize: number,
  averageLength: number,
): Promise<{ copied: number; removed: number; points: number }> {
  let copied = 0
  let removed = 0
  for (let round = 0; round < 3; round++) {
    const { stale, extra, points } = await compare(baseUrl, source, target, batchSize)
    if (stale.length === 0 && extra.length === 0) return { copied, removed, points }

    if (stale.length > 0) {
      copied += await copyPoints(baseUrl, source, target, batchSize, averageLength, new Set(stale.map(String)))
    }
    if (extra.length > 0) {
      await qdrant(baseUrl, `/collections/${target}/points/delete?wait=true`, { method: 'POST', body: { points: extra } })
      removed += extra.length
    }
  }
  throw new Error(`${target} still differs from ${source} after three rounds; memories are being written faster than they copy.`)
}

async function hybridSource(baseUrl: string, name: string): Promise<CollectionShape> {
  const source = await describeCollection(baseUrl, name)
  if (!source) throw new Error(`${name} does not exist.`)
  if (source.sparseVectorNames.includes(SPARSE_VECTOR_NAME)) {
    throw new Error(`${name} already has the lexical arm; there is nothing to copy.`)
  }
  if (!source.vectorSize) throw new Error(`${name} has no single unnamed dense vector to copy.`)
  return source
}

/**
 * Copy every memory into a collection with both arms. Repeatable: a second run
 * rewrites the points and deletes the ones the source no longer has.
 */
export async function copyToHybridCollection(opts: HybridCopyOptions): Promise<HybridCopyReport> {
  const baseUrl = opts.qdrantUrl.replace(/\/$/, '')
  const batchSize = opts.batchSize ?? DEFAULT_BATCH
  const source = await hybridSource(baseUrl, opts.source)
  await ensureTarget(baseUrl, source, opts.target)

  // BM25 normalises each memory by the mean length of all of them, so the mean
  // is read in full before the first sparse vector is written.
  let total = 0
  let count = 0
  for await (const page of scroll(baseUrl, source.collection, false, batchSize)) {
    for (const point of page) {
      total += tokenizeText(String(point.payload.memory ?? '')).length
      count += 1
    }
  }
  const averageLength = count > 0 ? total / count : 0

  const copied = await copyPoints(baseUrl, source.collection, opts.target, batchSize, averageLength)
  const synced = await sync(baseUrl, source.collection, opts.target, batchSize, averageLength)

  return {
    source: opts.source,
    target: opts.target,
    points: synced.points,
    copied: copied + synced.copied,
    removed: synced.removed,
    averageLength,
  }
}

/**
 * Put the hybrid copy behind the name callers use.
 *
 * Copies again (so nothing written since the last copy is lost), snapshots the
 * source, checks once more, then deletes the source and makes its name an alias
 * of the target. Qdrant has no "replace collection with alias" in one step; a
 * process that creates the collection in the gap gets an empty one, which is
 * dropped for the alias. A non-empty one is left alone and reported.
 *
 * Running processes keep the "no lexical arm" they detected at start-up until
 * they are restarted.
 */
export async function switchToHybridCollection(opts: HybridCopyOptions): Promise<HybridSwitchReport> {
  const baseUrl = opts.qdrantUrl.replace(/\/$/, '')
  const batchSize = opts.batchSize ?? DEFAULT_BATCH

  const current = await describeCollection(baseUrl, opts.source)
  if (current?.isAlias) {
    if (current.collection !== opts.target) {
      throw new Error(`${opts.source} is already an alias, of ${current.collection} rather than ${opts.target}.`)
    }
    return {
      source: opts.source,
      target: opts.target,
      points: current.points,
      copied: 0,
      removed: 0,
      averageLength: 0,
      snapshot: '',
      alreadySwitched: true,
    }
  }

  const copy = await copyToHybridCollection(opts)
  const { name: snapshot } = await qdrant<{ name: string }>(baseUrl, `/collections/${opts.source}/snapshots?wait=true`, {
    method: 'POST',
  })
  const last = await sync(baseUrl, opts.source, opts.target, batchSize, copy.averageLength)

  await qdrant(baseUrl, `/collections/${opts.source}`, { method: 'DELETE' })
  const alias = { actions: [{ create_alias: { collection_name: opts.target, alias_name: opts.source } }] }
  try {
    await qdrant(baseUrl, '/collections/aliases', { method: 'POST', body: alias })
  } catch (err) {
    const reappeared = await describeCollection(baseUrl, opts.source)
    if (!reappeared || reappeared.isAlias || reappeared.points > 0) {
      throw new Error(
        `${opts.source} was deleted but the alias could not be created: ${String(err)}. ` +
          `The memories are in ${opts.target}; snapshot ${snapshot} holds the original.`,
      )
    }
    await qdrant(baseUrl, `/collections/${opts.source}`, { method: 'DELETE' })
    await qdrant(baseUrl, '/collections/aliases', { method: 'POST', body: alias })
  }

  return {
    ...copy,
    points: last.points,
    copied: copy.copied + last.copied,
    removed: copy.removed + last.removed,
    snapshot,
    alreadySwitched: false,
  }
}
