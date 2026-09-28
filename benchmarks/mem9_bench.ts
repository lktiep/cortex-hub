/**
 * Mem9 benchmark: does `Mem9.search()` put the memory that answers a question
 * first, and how long does `Mem9.add()` spend finding out what it already knows?
 *
 * Two corpora, because they fail in different ways:
 *
 *   longmemeval — per question, every user turn of its LongMemEval-S haystack
 *                 (~250) stored as one user's memories; the turns marked as
 *                 evidence are the answer. English chat, long texts.
 *   dev         — gold_memory_search.ts: short facts about one codebase, a third
 *                 of them Vietnamese, many carrying an identifier. What the hub
 *                 actually stores, recalled through an English-only embedder.
 *
 * The collection is seeded exactly as production holds memories today — one
 * dense vector per point, the payload Mem9 writes — and every query goes through
 * `Mem9.search()` itself, recency blend included, so the numbers are the ones an
 * agent gets. All memories are seeded with the same timestamp, so recency is flat
 * and only relevance decides the order.
 *
 * Then the same collection is copied into one with the lexical arm — the copy
 * the production migration makes, dense vectors reused — and every query runs
 * again: `vector` and `hybrid` rows differ only in how memories are retrieved.
 *
 * `add` timing runs the real embed → search → write path against the same
 * Qdrant; the LLM is a stub that answers instantly, so what is measured is the
 * lookup work Mem9 does around the two LLM calls, not the calls themselves.
 *
 * Usage — against a throwaway Qdrant and Ollama, never a live hub:
 *   docker run -d --name mem9-bench-qdrant -p 16333:6333 qdrant/qdrant:v1.13.6
 *   docker run -d --name mem9-bench-ollama -p 11435:11434 ollama/ollama
 *   docker exec mem9-bench-ollama ollama pull all-minilm
 *   QDRANT_URL=http://localhost:16333 OLLAMA_API_BASE=http://localhost:11435/v1 \
 *     pnpm --filter @cortex/benchmarks bench:mem9 -- --questions 100 --label before
 */

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Mem9, copyToHybridCollection } from '@cortex/shared-mem9'
import { DEV_MEMORIES, DEV_MEMORY_GOLD } from './gold_memory_search.js'

const QDRANT_URL = process.env.QDRANT_URL ?? 'http://localhost:16333'
const OLLAMA_URL = process.env.OLLAMA_API_BASE ?? 'http://localhost:11435/v1'
const HERE = dirname(fileURLToPath(import.meta.url))
const DATASET_PATH = join(HERE, 'data', 'longmemeval_s_cleaned.json')
const RESULTS_DIR = resolve(HERE, 'results')

const SEARCH_LIMIT = 10
const EMBED_BATCH = 64
const ADD_CALLS = 12
const FACTS_PER_ADD = 8

interface Scope {
  userId: string
  memories: string[]
}

interface Query {
  userId: string
  query: string
  /** Memory texts that answer it — any one of them counts as a hit */
  gold: Set<string>
  type: string
}

interface Corpus {
  name: string
  scopes: Scope[]
  queries: Query[]
}

interface Row {
  corpus: string
  mode: string
  n: number
  recall: Record<number, number>
  mrr: number
  p50Ms: number
  ranks: number[]
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

const send = (method: string, url: string, body: unknown): Promise<unknown> =>
  j(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

async function embedBatch(model: string, input: string[]): Promise<number[][]> {
  const r = await j<{ data: Array<{ embedding: number[]; index: number }> }>(`${OLLAMA_URL}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input }),
  })
  return [...r.data].sort((a, b) => a.index - b.index).map((d) => d.embedding)
}

/** Mem9's own dedup hash, so seeded points look exactly like stored ones. */
const hashText = (text: string) => createHash('md5').update(text.toLowerCase().trim()).digest('hex').slice(0, 16)

/* ── Corpora ─────────────────────────────────────────────── */

interface LmeTurn {
  role: string
  content: string
  has_answer?: boolean
}

interface LmeQuestion {
  question_id: string
  question_type: string
  question: string
  haystack_sessions: LmeTurn[][]
}

/**
 * Every n-th question that has user-side evidence, so a small run still covers
 * every question type. Questions whose only evidence is an assistant turn are
 * skipped: Mem9 stores what the user said.
 */
async function loadLongMemEval(questions: number): Promise<Corpus> {
  const all = JSON.parse(await readFile(DATASET_PATH, 'utf-8')) as LmeQuestion[]
  const eligible = all.filter((q) =>
    q.haystack_sessions.some((s) => s.some((t) => t.role === 'user' && t.has_answer)),
  )
  const stride = Math.max(1, Math.floor(eligible.length / questions))
  const picked = eligible.filter((_, i) => i % stride === 0).slice(0, questions)

  const scopes: Scope[] = []
  const queries: Query[] = []
  for (const q of picked) {
    const userId = `lme-${q.question_id}`
    const memories = new Set<string>()
    const gold = new Set<string>()
    for (const turn of q.haystack_sessions.flat()) {
      const text = turn.content?.trim()
      if (turn.role !== 'user' || !text) continue
      memories.add(text)
      if (turn.has_answer) gold.add(text)
    }
    scopes.push({ userId, memories: [...memories] })
    queries.push({ userId, query: q.question, gold, type: q.question_type })
  }
  return { name: 'longmemeval', scopes, queries }
}

function devCorpus(): Corpus {
  const userId = 'dev-lumen'
  return {
    name: 'dev',
    scopes: [{ userId, memories: DEV_MEMORIES }],
    queries: DEV_MEMORY_GOLD.map(([query, i]) => ({
      userId,
      query,
      gold: new Set([DEV_MEMORIES[i]!]),
      type: /[^\x00-\x7F]/.test(query) ? 'vi' : 'en',
    })),
  }
}

/* ── Seeding ─────────────────────────────────────────────── */

/** A collection shaped like production's today: one unnamed dense vector, no sparse. */
async function seedVectorOnly(collection: string, model: string, corpora: Corpus[]): Promise<number> {
  const dim = (await embedBatch(model, ['probe']))[0]!.length
  await fetch(`${QDRANT_URL}/collections/${collection}`, { method: 'DELETE' })
  await send('PUT', `${QDRANT_URL}/collections/${collection}`, { vectors: { size: dim, distance: 'Cosine' } })

  const now = new Date().toISOString()
  const total = corpora.reduce((n, c) => n + c.scopes.reduce((m, s) => m + s.memories.length, 0), 0)
  let done = 0
  for (const corpus of corpora) {
    for (const scope of corpus.scopes) {
      for (let i = 0; i < scope.memories.length; i += EMBED_BATCH) {
        const slice = scope.memories.slice(i, i + EMBED_BATCH)
        const vectors = await embedBatch(model, slice)
        await send('PUT', `${QDRANT_URL}/collections/${collection}/points?wait=true`, {
          points: slice.map((memory, k) => ({
            id: randomUUID(),
            vector: vectors[k]!,
            payload: {
              memory,
              hash: hashText(memory),
              user_id: scope.userId,
              agent_id: '',
              metadata: {},
              created_at: now,
              updated_at: now,
            },
          })),
        })
        done += slice.length
        process.stdout.write(`\r  seeding ${done}/${total}`)
      }
    }
  }
  process.stdout.write('\r' + ' '.repeat(40) + '\r')
  return dim
}

/* ── Stub gateway ────────────────────────────────────────── */

/**
 * Mem9 talks to the hub's LLM gateway: `model: 'auto'` embeddings and an
 * OpenAI-style chat endpoint. This stands in for both — embeddings go to the
 * local Ollama under the benchmark's model, and chat answers at once with the
 * facts the add benchmark wants stored.
 */
async function startGateway(model: string) {
  const state = { facts: [] as string[] }

  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', async () => {
      try {
        const body = JSON.parse(raw || '{}') as {
          input?: string | string[]
          messages?: Array<{ role: string }>
        }
        let out: unknown
        if (req.url?.endsWith('/embeddings')) {
          const input = Array.isArray(body.input) ? body.input : [body.input ?? '']
          const vectors = await embedBatch(model, input)
          out = { data: vectors.map((embedding, index) => ({ embedding, index })) }
        } else {
          // The extraction call carries a system prompt; the update decision does not.
          const extracting = body.messages?.[0]?.role === 'system'
          const content = extracting
            ? { facts: state.facts }
            : { actions: state.facts.map((memory) => ({ type: 'ADD', memory })) }
          out = { choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }] }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(out))
      } catch (err) {
        res.writeHead(500)
        res.end(String(err))
      }
    })
  })

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { url, state, close: () => new Promise<void>((r) => server.close(() => r())) }
}

function mem9For(gatewayUrl: string, collection: string): Mem9 {
  return new Mem9({
    llm: { baseUrl: `${gatewayUrl}/v1`, model: 'stub' },
    embedder: { provider: 'gemini', apiKey: '', model: 'auto', gatewayUrl },
    vectorStore: { url: QDRANT_URL, collection },
  })
}

/* ── Measurement ─────────────────────────────────────────── */

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
}

async function measureSearch(mem9: Mem9, corpus: Corpus, mode: string): Promise<Row> {
  const ranks: number[] = []
  const latencies: number[] = []
  for (const q of corpus.queries) {
    const t0 = performance.now()
    const { memories } = await mem9.search({ query: q.query, userId: q.userId, limit: SEARCH_LIMIT })
    latencies.push(performance.now() - t0)
    ranks.push(memories.findIndex((m) => q.gold.has(m.memory)) + 1)
  }

  const n = ranks.length
  const recall: Record<number, number> = {}
  for (const k of [1, 3, 5, 10]) recall[k] = ranks.filter((r) => r > 0 && r <= k).length / n
  const mrr = ranks.reduce((sum, r) => sum + (r > 0 ? 1 / r : 0), 0) / n
  return { corpus: corpus.name, mode, n, recall, mrr, p50Ms: Math.round(percentile(latencies, 50)), ranks }
}

/** The facts of one `add()` call — distinct per call and per tag, so no run finds another's. */
const addFacts = (tag: string, call: number) =>
  Array.from({ length: FACTS_PER_ADD }, (_, i) =>
    `${DEV_MEMORIES[(call * FACTS_PER_ADD + i) % DEV_MEMORIES.length]} (${tag} ${call}.${i})`,
  )

/** Wall time of `add()` with FACTS_PER_ADD facts, each lookup and write real. */
async function measureAdd(mem9: Mem9, gateway: Awaited<ReturnType<typeof startGateway>>, tag = 'run') {
  const times: number[] = []
  for (let call = 0; call < ADD_CALLS; call++) {
    gateway.state.facts = addFacts(tag, call)
    const t0 = performance.now()
    await mem9.add({ messages: [{ role: 'user', content: 'stub' }], userId: 'bench-add' })
    times.push(performance.now() - t0)
  }
  // The first call pays for connection setup; report the steady state.
  const steady = times.slice(1)
  return { p50Ms: Math.round(percentile(steady, 50)), meanMs: Math.round(steady.reduce((a, b) => a + b, 0) / steady.length) }
}

/** State the first call's facts again: how many does `add()` store a second time? */
async function measureRepeat(mem9: Mem9, gateway: Awaited<ReturnType<typeof startGateway>>, tag: string) {
  gateway.state.facts = addFacts(tag, 0)
  const { events } = await mem9.add({ messages: [{ role: 'user', content: 'stub' }], userId: 'bench-add' })
  return {
    facts: FACTS_PER_ADD,
    storedAgain: events.filter((e) => e.type === 'ADD').length,
    recognised: events.filter((e) => e.type === 'NONE').length,
  }
}

/** Per query, did the second run put the answer higher or lower than the first? */
function compareRanks(before: Row, after: Row) {
  const place = (r: number) => (r === 0 ? Infinity : r)
  let improved = 0
  let regressed = 0
  before.ranks.forEach((r, i) => {
    const a = place(after.ranks[i]!)
    if (a < place(r)) improved++
    else if (a > place(r)) regressed++
  })
  return { improved, regressed, same: before.ranks.length - improved - regressed }
}

function printRows(rows: Row[]) {
  console.log('corpus      | mode    | n   | r@1   | r@3   | r@5   | r@10  | MRR   | p50 ms')
  console.log('------------|---------|-----|-------|-------|-------|-------|-------|-------')
  for (const r of rows) {
    console.log(
      `${r.corpus.padEnd(11)} | ${r.mode.padEnd(7)} | ${String(r.n).padEnd(3)} | ${r.recall[1]!.toFixed(3)} | ` +
        `${r.recall[3]!.toFixed(3)} | ${r.recall[5]!.toFixed(3)} | ${r.recall[10]!.toFixed(3)} | ${r.mrr.toFixed(3)} | ${r.p50Ms}`,
    )
  }
}

async function main() {
  const model = arg('model', 'all-minilm')!
  const questions = Number(arg('questions', '100'))
  const label = arg('label', 'run')!
  const keep = process.argv.includes('--keep')

  const corpora = [devCorpus()]
  if (questions > 0) corpora.push(await loadLongMemEval(questions))
  for (const c of corpora) {
    const memories = c.scopes.reduce((n, s) => n + s.memories.length, 0)
    console.log(`${c.name}: ${c.queries.length} queries over ${memories} memories in ${c.scopes.length} scope(s)`)
  }

  const collection = 'bench_mem9'
  const hybridCollection = 'bench_mem9_hybrid'
  const gateway = await startGateway(model)
  try {
    const t0 = Date.now()
    const dim = await seedVectorOnly(collection, model, corpora)
    console.log(`seeded ${collection}: ${dim}-dim ${model} in ${Math.round((Date.now() - t0) / 1000)}s\n`)

    const rows: Row[] = []
    const vector = mem9For(gateway.url, collection)
    await vector.search({ query: 'warm up', userId: 'nobody' })
    for (const c of corpora) rows.push(await measureSearch(vector, c, 'vector'))

    const t1 = Date.now()
    const copy = await copyToHybridCollection({ qdrantUrl: QDRANT_URL, source: collection, target: hybridCollection })
    console.log(`copied ${copy.points} memories into ${hybridCollection} in ${Math.round((Date.now() - t1) / 1000)}s\n`)

    const hybrid = mem9For(gateway.url, hybridCollection)
    await hybrid.search({ query: 'warm up', userId: 'nobody' })
    for (const c of corpora) rows.push(await measureSearch(hybrid, c, 'hybrid'))

    printRows(rows)

    const changes = corpora.map((c) => {
      const pick = (mode: string) => rows.find((r) => r.corpus === c.name && r.mode === mode)!
      return { corpus: c.name, ...compareRanks(pick('vector'), pick('hybrid')) }
    })
    console.log('\nper query, hybrid against vector:')
    for (const ch of changes) {
      console.log(`  ${ch.corpus.padEnd(11)} ${ch.improved} higher, ${ch.regressed} lower, ${ch.same} unchanged`)
    }

    const devRanks = (mode: string) => rows.find((r) => r.corpus === 'dev' && r.mode === mode)!.ranks
    console.log('\ndev: rank of the answering memory per query, vector → hybrid (0 = not in top 10)')
    DEV_MEMORY_GOLD.forEach(([query], i) =>
      console.log(`${String(devRanks('vector')[i]).padStart(3)} → ${String(devRanks('hybrid')[i]).padEnd(3)}| ${query}`),
    )

    const add = await measureAdd(vector, gateway)
    const addHybrid = await measureAdd(hybrid, gateway, 'hybrid')
    const repeat = await measureRepeat(hybrid, gateway, 'hybrid')
    console.log(`\nadd(): ${FACTS_PER_ADD} facts per call, LLM stubbed`)
    console.log(`  vector collection  p50 ${add.p50Ms} ms, mean ${add.meanMs} ms`)
    console.log(`  hybrid collection  p50 ${addHybrid.p50Ms} ms, mean ${addHybrid.meanMs} ms`)
    console.log(`  the same ${repeat.facts} facts again: ${repeat.storedAgain} stored a second time, ${repeat.recognised} recognised`)

    await mkdir(RESULTS_DIR, { recursive: true })
    const out = join(RESULTS_DIR, `mem9_${label}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    await writeFile(
      out,
      JSON.stringify({ label, model, questions, rows, changes, add, addHybrid, repeat }, null, 2),
    )
    console.log(`\nwrote ${out}`)
  } finally {
    await gateway.close()
    if (!keep) {
      for (const name of [collection, hybridCollection]) {
        await fetch(`${QDRANT_URL}/collections/${name}`, { method: 'DELETE' })
      }
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
