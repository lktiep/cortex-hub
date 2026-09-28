/**
 * Retrieval benchmark: does fusing a BM25 arm into code search actually order
 * results better than the vector arm alone?
 *
 * The three rows are the three things production could do, measured on the same
 * corpus, the same gold set and the same embedding model, so the only variable is
 * how candidates are retrieved and merged:
 *
 *   vector  — dense search, what search did before hybrid retrieval
 *   bm25    — the lexical arm alone, Qdrant sparse with `modifier: 'idf'`
 *   hybrid  — both arms, merged by reciprocal rank fusion inside Qdrant
 *
 * It builds its own collection from the live index rather than querying
 * production, for two reasons: a collection cannot be given a sparse vector after
 * it exists, so a project indexed before hybrid search landed could not be
 * measured at all; and reading the corpus back out of Qdrant means the chunks are
 * exactly the ones production serves, with no re-chunking drift.
 *
 * Usage (from inside the cortex-api container, where qdrant and ollama resolve):
 *   tsx retrieval_bench.ts --project proj-30946766
 *   tsx retrieval_bench.ts --project proj-30946766 --model bge-m3 --keep
 *
 * `--keep` leaves the bench collection in place for poking at by hand. Without it
 * the collection is deleted even if the run throws, because a half-built bench
 * collection left in Qdrant looks exactly like a real one.
 */

import {
  documentSparseVector,
  querySparseVector,
  averageTokenLength,
  SPARSE_VECTOR_NAME,
} from '@cortex/shared-mem9'
import { CODE_SEARCH_GOLD } from './gold_code_search.js'

const QDRANT_URL = process.env.QDRANT_URL ?? 'http://qdrant:6333'
const OLLAMA_URL = process.env.OLLAMA_API_BASE ?? 'http://ollama:11434/v1'

/** Each arm fetches this deep before fusion, matching HYBRID_FETCH_FLOOR. */
const FETCH_DEPTH = 30
const EMBED_BATCH = 32

type Mode = 'vector' | 'bm25' | 'hybrid'
const MODES: Mode[] = ['vector', 'bm25', 'hybrid']

interface Chunk {
  file: string
  chunkIndex: number
  text: string
}

interface Row {
  hits: Record<number, number>
  reciprocalRanks: number[]
  latencies: number[]
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const j = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${(await res.text()).slice(0, 200)}`)
  return (await res.json()) as T
}

const post = (url: string, body: unknown): Promise<unknown> =>
  j(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

async function embedBatch(model: string, input: string[]): Promise<number[][]> {
  const r = await j<{ data: Array<{ embedding: number[]; index: number }> }>(`${OLLAMA_URL}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input }),
  })
  return [...r.data].sort((a, b) => a.index - b.index).map((d) => d.embedding)
}

/** Read the live index back out — it is the corpus, so no re-chunking drift. */
async function loadCorpus(collection: string): Promise<Chunk[]> {
  const chunks: Chunk[] = []
  let offset: unknown = null
  for (;;) {
    const body: Record<string, unknown> = {
      limit: 512,
      with_payload: ['file_path', 'chunk_index', 'content'],
      with_vector: false,
    }
    if (offset !== null) body.offset = offset
    const r = (await post(`${QDRANT_URL}/collections/${collection}/points/scroll`, body)) as {
      result: { points: Array<{ payload: Record<string, unknown> }>; next_page_offset: unknown }
    }
    for (const p of r.result.points) {
      if (typeof p.payload.content === 'string') {
        chunks.push({
          file: String(p.payload.file_path),
          chunkIndex: Number(p.payload.chunk_index),
          text: p.payload.content,
        })
      }
    }
    offset = r.result.next_page_offset
    if (!offset) break
  }
  return chunks
}

/** Build a collection carrying both arms, indexed the way production indexes. */
async function buildBenchCollection(
  model: string,
  corpus: Chunk[],
): Promise<{ collection: string; dim: number; indexSec: number; avgLen: number }> {
  const collection = `bench-retrieval-${model.replace(/[^a-z0-9]+/gi, '-')}`
  const dim = (await embedBatch(model, ['probe']))[0]!.length

  await fetch(`${QDRANT_URL}/collections/${collection}`, { method: 'DELETE' })
  await j(`${QDRANT_URL}/collections/${collection}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vectors: { size: dim, distance: 'Cosine' },
      sparse_vectors: { [SPARSE_VECTOR_NAME]: { modifier: 'idf' } },
    }),
  })

  // BM25 measures each document against the corpus average, so the average has to
  // be computed over the whole corpus before the first point is written.
  const avgLen = averageTokenLength(corpus.map((c) => c.text))

  const t0 = Date.now()
  for (let i = 0; i < corpus.length; i += EMBED_BATCH) {
    const slice = corpus.slice(i, i + EMBED_BATCH)
    const vectors = await embedBatch(model, slice.map((c) => c.text))
    // Upsert is PUT; POST on the same path is a different operation and answers
    // "missing field `ids`".
    await j(`${QDRANT_URL}/collections/${collection}/points?wait=true`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        points: slice.map((c, k) => ({
          id: i + k + 1,
          vector: {
            '': vectors[k]!,
            [SPARSE_VECTOR_NAME]: documentSparseVector(c.text, avgLen),
          },
          payload: { file_path: c.file, chunk_index: c.chunkIndex },
        })),
      }),
    })
    process.stdout.write(`\r  indexing ${Math.min(i + EMBED_BATCH, corpus.length)}/${corpus.length}`)
  }
  process.stdout.write('\r' + ' '.repeat(40) + '\r')

  return { collection, dim, indexSec: Math.round((Date.now() - t0) / 1000), avgLen }
}

/** One query, one mode: the ranked file paths Qdrant returns. */
async function search(collection: string, mode: Mode, query: string, vector: number[]): Promise<string[]> {
  const sparse = querySparseVector(query)

  const body =
    mode === 'vector'
      ? { query: vector, limit: FETCH_DEPTH, with_payload: true }
      : mode === 'bm25'
        ? { query: sparse, using: SPARSE_VECTOR_NAME, limit: FETCH_DEPTH, with_payload: true }
        : {
            prefetch: [
              { query: vector, limit: FETCH_DEPTH },
              { query: sparse, using: SPARSE_VECTOR_NAME, limit: FETCH_DEPTH },
            ],
            query: { fusion: 'rrf' },
            limit: FETCH_DEPTH,
            with_payload: true,
          }

  const r = (await post(`${QDRANT_URL}/collections/${collection}/points/query`, body)) as {
    result: { points: Array<{ payload: Record<string, unknown> }> }
  }
  return r.result.points.map((p) => String(p.payload.file_path))
}

/** Rank of the first chunk belonging to the expected file, 1-based; 0 for a miss. */
function rankOfGold(ranked: string[], gold: string): number {
  const seen: string[] = []
  for (const file of ranked) {
    if (!seen.includes(file)) seen.push(file)
    if (file === gold) return seen.length
  }
  return 0
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
}

async function main() {
  const projectId = arg('project')
  if (!projectId) throw new Error('--project <projectId> is required')
  const model = arg('model', 'all-minilm')!
  const keep = process.argv.includes('--keep')

  const corpus = await loadCorpus(`cortex-project-${projectId}`)
  if (corpus.length === 0) throw new Error(`cortex-project-${projectId} holds no chunks with content`)

  const indexedFiles = new Set(corpus.map((c) => c.file))
  const dropped = CODE_SEARCH_GOLD.filter(([, f]) => !indexedFiles.has(f))
  const queries = CODE_SEARCH_GOLD.filter(([, f]) => indexedFiles.has(f))

  console.log(`corpus: ${corpus.length} chunks across ${indexedFiles.size} files`)
  if (dropped.length) {
    console.log(`dropped ${dropped.length} queries — expected file not in the index:`)
    for (const [, f] of dropped) console.log(`  ${f}`)
  }
  if (queries.length === 0) throw new Error('no gold queries survived — is this the right project?')

  let collection: string | undefined
  try {
    const built = await buildBenchCollection(model, corpus)
    collection = built.collection
    console.log(
      `${model}: ${built.dim}-dim dense + BM25 sparse, ${corpus.length} chunks in ${built.indexSec}s, avgdl ${built.avgLen.toFixed(1)} tokens\n`,
    )

    const rows: Record<Mode, Row> = {
      vector: { hits: {}, reciprocalRanks: [], latencies: [] },
      bm25: { hits: {}, reciprocalRanks: [], latencies: [] },
      hybrid: { hits: {}, reciprocalRanks: [], latencies: [] },
    }
    const perQuery: Array<{ query: string; ranks: Record<Mode, number> }> = []

    for (const [query, gold] of queries) {
      const vector = (await embedBatch(model, [query]))[0]!
      const ranks = {} as Record<Mode, number>

      for (const mode of MODES) {
        const t0 = Date.now()
        const ranked = await search(collection, mode, query, vector)
        rows[mode].latencies.push(Date.now() - t0)

        const rank = rankOfGold(ranked, gold)
        ranks[mode] = rank
        rows[mode].reciprocalRanks.push(rank > 0 ? 1 / rank : 0)
        for (const k of [1, 3, 5, 10]) {
          rows[mode].hits[k] = (rows[mode].hits[k] ?? 0) + (rank > 0 && rank <= k ? 1 : 0)
        }
      }
      perQuery.push({ query, ranks })
    }

    const n = queries.length
    const pct = (hits: number) => (hits / n).toFixed(3)

    console.log(`n = ${n} queries\n`)
    console.log('mode    | r@1   | r@3   | r@5   | r@10  | MRR   | p50 ms')
    console.log('--------|-------|-------|-------|-------|-------|-------')
    for (const mode of MODES) {
      const row = rows[mode]
      const mrr = row.reciprocalRanks.reduce((a, b) => a + b, 0) / n
      console.log(
        `${mode.padEnd(7)} | ${pct(row.hits[1] ?? 0)} | ${pct(row.hits[3] ?? 0)} | ${pct(row.hits[5] ?? 0)} | ` +
          `${pct(row.hits[10] ?? 0)} | ${mrr.toFixed(3)} | ${percentile(row.latencies, 50)}`,
      )
    }

    // Per-query ranks make a wash visible: a mode can fix as many orderings as it
    // breaks and still show an unchanged average.
    console.log('\nrank of the expected file per query (0 = not in top 30):')
    console.log('vector | bm25 | hybrid | query')
    for (const { query, ranks } of perQuery) {
      console.log(
        `${String(ranks.vector).padStart(6)} | ${String(ranks.bm25).padStart(4)} | ` +
          `${String(ranks.hybrid).padStart(6)} | ${query}`,
      )
    }

    const better = perQuery.filter((q) => q.ranks.hybrid > 0 && (q.ranks.vector === 0 || q.ranks.hybrid < q.ranks.vector))
    const worse = perQuery.filter((q) => q.ranks.vector > 0 && (q.ranks.hybrid === 0 || q.ranks.hybrid > q.ranks.vector))
    console.log(`\nhybrid vs vector: ${better.length} queries improved, ${worse.length} regressed, ${n - better.length - worse.length} unchanged`)
  } finally {
    if (collection && !keep) {
      await fetch(`${QDRANT_URL}/collections/${collection}`, { method: 'DELETE' })
      console.log(`\ncleaned up ${collection}`)
    } else if (collection) {
      console.log(`\nkept ${collection}`)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
