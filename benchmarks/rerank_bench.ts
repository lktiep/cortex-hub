/**
 * Rerank benchmark for Cortex Hub semantic code search.
 *
 * Answers one question with numbers: for a given embedding model, how much of
 * the ranking is fixed by adding a Jev rerank pass on top of over-fetched
 * vector candidates?
 *
 * It runs the full matrix over a live index:
 *   embedding model x {vector only, vector + rerank}
 * and reports recall@1/3/5, MRR and wall-clock per query for each cell, so the
 * trade-off is explicit — a fast small embedder plus a rerank pass may beat a
 * slow large embedder alone, at which point the large one is not worth its
 * indexing cost.
 *
 * Ground truth is a fixed query -> file list. A query counts as a hit at K when
 * any chunk of the expected file appears in the top K. Queries whose expected
 * file is absent from the index are dropped and reported, so a coverage gap
 * cannot silently inflate the score.
 *
 * Usage (from inside the cortex-api container, where qdrant/ollama resolve):
 *   TYPESAFE_API_KEY=... tsx rerank_bench.ts --project proj-30946766
 *   tsx rerank_bench.ts --project proj-30946766 --models all-minilm,bge-m3
 *
 * Without TYPESAFE_API_KEY it measures the vector-only rows and says the rerank
 * rows were skipped, which is still a useful baseline.
 */

const QDRANT_URL = process.env.QDRANT_URL ?? 'http://qdrant:6333'
const OLLAMA_URL = process.env.OLLAMA_API_BASE ?? 'http://ollama:11434/v1'
const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone'
const TYPESAFE_KEY = process.env.TYPESAFE_API_KEY?.trim()
const TYPESAFE_MODEL = process.env.TYPESAFE_MODEL ?? 'jev-latest'

const OVERFETCH = 4
const TOP_K = 5
const CONCURRENCY = 8

/** query -> the file that actually answers it */
const GROUND_TRUTH: Array<[string, string]> = [
  ['how are duplicate points removed when re-indexing a project', 'apps/dashboard-api/src/services/mem9-embedder.ts'],
  ['delete qdrant points matching a payload filter', 'packages/shared-mem9/src/vector-store.ts'],
  ['extract facts from a conversation and decide ADD UPDATE DELETE', 'packages/shared-mem9/src/prompts.ts'],
  ['fallback chain retry on 429 and 503 with exponential backoff', 'packages/shared-mem9/src/llm.ts'],
  ['which model does the embedding gateway route to', 'apps/dashboard-api/src/routes/llm.ts'],
  ['verify an api key and check its permissions', 'apps/dashboard-api/src/routes/keys.ts'],
  ['xoá knowledge document theo id', 'apps/dashboard-api/src/routes/knowledge.ts'],
  ['decide if a finished task contains a reusable pattern worth saving', 'apps/dashboard-api/src/services/recipe-capture.ts'],
  ['rewrite a low quality knowledge doc and bump its generation', 'apps/dashboard-api/src/services/knowledge-evolution.ts'],
  ['assign a task to an agent and update its status', 'apps/dashboard-api/src/routes/conductor.ts'],
  ['clone a git repository using a stored token', 'apps/dashboard-api/src/services/indexer.ts'],
  ['start a session and return the project id', 'apps/dashboard-api/src/routes/sessions.ts'],
]

interface Chunk { file: string; chunkIndex: number; text: string }

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const j = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${(await res.text()).slice(0, 200)}`)
  return (await res.json()) as T
}

async function embed(model: string, input: string): Promise<number[]> {
  const r = await j<{ data: Array<{ embedding: number[] }> }>(`${OLLAMA_URL}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input }),
  })
  return r.data[0]!.embedding
}

/** Jev's probability that a candidate answers the query. */
async function relevance(query: string, candidate: string): Promise<number> {
  const r = await j<{ answers: { relevant: { noul: number } } }>(TYPESAFE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TYPESAFE_KEY}` },
    body: JSON.stringify({
      state: { query, candidate_passage: candidate },
      model: TYPESAFE_MODEL,
      questions: {
        relevant: {
          type: 'noul',
          instructions: 'Does the candidate source file excerpt contain the code that answers the query?',
          criteria: {
            true: 'The excerpt contains the implementation, declaration or definition the query asks about',
            false: 'The excerpt only mentions or uses the subject of the query, or is about a neighbouring concern',
          },
        },
      },
    }),
  })
  return r.answers.relevant.noul
}

async function pooled<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = cursor++
        if (i >= items.length) return
        out[i] = await fn(items[i]!)
      }
    }),
  )
  return out
}

/** Read the live index back out — it is the corpus, so no re-chunking drift. */
async function loadCorpus(collection: string): Promise<Chunk[]> {
  const chunks: Chunk[] = []
  let offset: unknown = null
  for (;;) {
    const body: Record<string, unknown> = { limit: 512, with_payload: ['file_path', 'chunk_index', 'content'], with_vector: false }
    if (offset !== null) body.offset = offset
    const r = await j<{ result: { points: Array<{ payload: Record<string, unknown> }>; next_page_offset: unknown } }>(
      `${QDRANT_URL}/collections/${collection}/points/scroll`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    )
    for (const p of r.result.points) {
      if (typeof p.payload.content === 'string') {
        chunks.push({ file: String(p.payload.file_path), chunkIndex: Number(p.payload.chunk_index), text: p.payload.content })
      }
    }
    offset = r.result.next_page_offset
    if (!offset) break
  }
  return chunks
}

async function buildBenchCollection(model: string, corpus: Chunk[]): Promise<{ collection: string; indexSec: number; dim: number }> {
  const collection = `bench-rerank-${model.replace(/[^a-z0-9]+/gi, '-')}`
  const dim = (await embed(model, 'probe')).length
  await fetch(`${QDRANT_URL}/collections/${collection}`, { method: 'DELETE' })
  await fetch(`${QDRANT_URL}/collections/${collection}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vectors: { size: dim, distance: 'Cosine' } }),
  })

  const t0 = Date.now()
  for (let i = 0; i < corpus.length; i += 8) {
    const slice = corpus.slice(i, i + 8)
    const vectors = await Promise.all(slice.map((c) => embed(model, c.text)))
    await fetch(`${QDRANT_URL}/collections/${collection}/points?wait=true`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        points: slice.map((c, k) => ({ id: i + k + 1, vector: vectors[k], payload: { file_path: c.file, chunk_index: c.chunkIndex, content: c.text } })),
      }),
    })
  }
  return { collection, indexSec: +((Date.now() - t0) / 1000).toFixed(1), dim }
}

interface Cell { 'recall@1': string; 'recall@3': string; 'recall@5': string; MRR: number; msPerQuery: number; misses: string[] }

function summarise(ranks: Array<number | null>, totalMs: number): Cell {
  const n = ranks.length
  const at = (k: number) => ranks.filter((r) => r !== null && r < k).length
  const mrr = ranks.reduce<number>((acc, r) => acc + (r === null ? 0 : 1 / (r + 1)), 0) / n
  return {
    'recall@1': `${at(1)}/${n}`,
    'recall@3': `${at(3)}/${n}`,
    'recall@5': `${at(5)}/${n}`,
    MRR: +mrr.toFixed(3),
    msPerQuery: Math.round(totalMs / n),
    misses: [],
  }
}

async function main() {
  const projectId = arg('project')
  if (!projectId) throw new Error('--project <projectId> is required')
  const models = (arg('models', 'all-minilm,bge-m3') as string).split(',').map((m) => m.trim())

  const corpus = await loadCorpus(`cortex-project-${projectId}`)
  const indexedFiles = new Set(corpus.map((c) => c.file))
  const dropped = GROUND_TRUTH.filter(([, f]) => !indexedFiles.has(f))
  const queries = GROUND_TRUTH.filter(([, f]) => indexedFiles.has(f))

  console.log(`corpus: ${corpus.length} chunks across ${indexedFiles.size} files`)
  if (dropped.length) {
    console.log(`dropped ${dropped.length} queries — expected file not in the index:`)
    for (const [, f] of dropped) console.log(`  ${f}`)
  }
  if (!TYPESAFE_KEY) console.log('TYPESAFE_API_KEY not set — rerank rows will be skipped')

  const report: Record<string, Cell> = {}

  for (const model of models) {
    const { collection, indexSec, dim } = await buildBenchCollection(model, corpus)
    console.log(`\n${model}: ${dim}-dim, indexed ${corpus.length} chunks in ${indexSec}s`)

    // Search once per query at the over-fetch depth; both rows read the same
    // candidate list, so the only difference measured is the ordering.
    const searched: Array<{ query: string; want: string; hits: Array<{ file: string; text: string; score: number }>; ms: number }> = []
    for (const [query, want] of queries) {
      const t = Date.now()
      const vector = await embed(model, query)
      const r = await j<{ result: Array<{ score: number; payload: Record<string, unknown> }> }>(
        `${QDRANT_URL}/collections/${collection}/points/search`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vector, limit: TOP_K * OVERFETCH, with_payload: ['file_path', 'content'] }),
        },
      )
      searched.push({
        query,
        want,
        hits: r.result.map((h) => ({ file: String(h.payload.file_path), text: String(h.payload.content ?? ''), score: h.score })),
        ms: Date.now() - t,
      })
    }

    // Row 1: vector only, top K of the vector order.
    const vecRanks = searched.map((s) => {
      const rank = s.hits.slice(0, TOP_K).findIndex((h) => h.file === s.want)
      return rank < 0 ? null : rank
    })
    const vecCell = summarise(vecRanks, searched.reduce((a, s) => a + s.ms, 0))
    vecCell.misses = searched.filter((s, i) => vecRanks[i] === null).map((s) => s.query)
    report[`${model} / vector only`] = vecCell
    console.log(`  vector only      `, JSON.stringify({ ...vecCell, misses: vecCell.misses.length }))

    // Row 2: same candidates, reordered by Jev.
    if (TYPESAFE_KEY) {
      const rrRanks: Array<number | null> = []
      let rrMs = 0
      for (const s of searched) {
        const t = Date.now()
        const scores = await pooled(s.hits, CONCURRENCY, async (h) => {
          try {
            return await relevance(s.query, `${h.file}\n${h.text}`)
          } catch {
            return null
          }
        })
        const ordered = s.hits
          .map((h, i) => ({ h, score: scores[i] === null ? h.score : scores[i]! * 0.8 + h.score * 0.2 }))
          .sort((a, b) => b.score - a.score)
          .slice(0, TOP_K)
        rrMs += s.ms + (Date.now() - t)
        const rank = ordered.findIndex((o) => o.h.file === s.want)
        rrRanks.push(rank < 0 ? null : rank)
      }
      const rrCell = summarise(rrRanks, rrMs)
      rrCell.misses = searched.filter((s, i) => rrRanks[i] === null).map((s) => s.query)
      report[`${model} / + jev rerank`] = rrCell
      console.log(`  + jev rerank     `, JSON.stringify({ ...rrCell, misses: rrCell.misses.length }))
    }

    await fetch(`${QDRANT_URL}/collections/${collection}`, { method: 'DELETE' })
  }

  console.log('\n=== SUMMARY ===')
  console.log(JSON.stringify(report, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
