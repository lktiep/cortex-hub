/**
 * LongMemEval benchmark for Cortex Hub `cortex_knowledge_search`.
 *
 * Downloads the LongMemEval-S cleaned dataset, imports every haystack session
 * as a knowledge document, then runs the benchmark question through the real
 * /api/knowledge/search endpoint and measures how often the ground-truth
 * session appears in the top-K results.
 *
 * Metrics:
 *   - R@5      : correct session in top 5
 *   - R@10     : correct session in top 10
 *   - NDCG@10  : normalised discounted cumulative gain at 10
 *
 * Usage:
 *   pnpm bench:longmemeval --limit 50 --api-url http://localhost:4000
 *   pnpm bench:longmemeval --cleanup
 */

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// ── Constants ──────────────────────────────────────────────────────────────

const DATASET_URL =
  'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json'
const BENCH_PROJECT_ID = 'longmemeval-bench'
const DEFAULT_API_URL = 'http://localhost:4000'
const DEFAULT_LIMIT = Infinity
const TOP_K = 10
const HERE = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = resolve(HERE, 'data')
const RESULTS_DIR = resolve(HERE, 'results')
const DATASET_PATH = join(DATA_DIR, 'longmemeval_s_cleaned.json')

// ── Types ──────────────────────────────────────────────────────────────────

interface RawMessage {
  role?: string
  content?: string
  text?: string
  [key: string]: unknown
}

interface RawSession {
  session_id?: string
  sessionId?: string
  id?: string
  messages?: RawMessage[]
  [key: string]: unknown
}

interface RawQuestion {
  question_id: string
  question: string
  answer?: string
  question_type?: string
  answer_session_ids?: string[]
  haystack_session_ids?: string[]
  haystack_sessions?: RawSession[] | Record<string, RawSession>
  [key: string]: unknown
}

interface NormalisedSession {
  sessionId: string
  content: string
}

interface NormalisedQuestion {
  questionId: string
  question: string
  questionType: string
  answer: string
  goldSessionIds: string[]
  sessions: NormalisedSession[]
}

interface CliOptions {
  limit: number
  offset: number
  apiUrl: string
  cleanup: boolean
  skipImport: boolean
  verbose: boolean
  stratified: boolean
}

interface KnowledgeSearchResultItem {
  score?: number
  chunkId?: string
  content?: unknown
  documentId?: string
  title?: unknown
  chunkIndex?: unknown
  document?: { id?: string; title?: string } | null
}

interface KnowledgeSearchResponse {
  query?: string
  results?: KnowledgeSearchResultItem[]
  error?: string
}

interface KnowledgeDocument {
  id: string
  title?: string
  project_id?: string | null
}

interface KnowledgeListResponse {
  documents?: KnowledgeDocument[]
  total?: number
}

interface QuestionOutcome {
  questionId: string
  questionType: string
  goldSessionIds: string[]
  topDocIds: string[]
  hitRank: number | null // 1-based rank of the first gold session; null if not found
  r_at_5: number
  r_at_10: number
  ndcg_at_10: number
  importedDocs: number
  importFailures: number
  searchLatencyMs: number
  importLatencyMs: number
  note?: string
}

interface BenchSummary {
  datasetUrl: string
  datasetBytes: number | null
  apiUrl: string
  projectId: string
  startedAt: string
  finishedAt: string
  durationMs: number
  totalQuestions: number
  scoredQuestions: number
  skippedQuestions: number
  metrics: {
    r_at_5: number
    r_at_10: number
    ndcg_at_10: number
    mrr: number
    hitRate: number
  }
  perType: Record<
    string,
    { count: number; r_at_5: number; r_at_10: number; ndcg_at_10: number }
  >
  outcomes: QuestionOutcome[]
  baselines: { memPalace_r_at_5: 0.966 }
  notes: string[]
}

// ── CLI parsing ────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    limit: DEFAULT_LIMIT,
    offset: 0,
    apiUrl: DEFAULT_API_URL,
    cleanup: false,
    skipImport: false,
    verbose: false,
    stratified: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) continue
    switch (arg) {
      case '--limit': {
        const raw = argv[++i]
        if (raw === undefined) throw new Error('--limit requires a value')
        const n = Number(raw)
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error(`--limit expected a positive number, got "${raw}"`)
        }
        opts.limit = Math.floor(n)
        break
      }
      case '--offset': {
        const raw = argv[++i]
        if (raw === undefined) throw new Error('--offset requires a value')
        const n = Number(raw)
        if (!Number.isFinite(n) || n < 0) {
          throw new Error(`--offset expected a non-negative number, got "${raw}"`)
        }
        opts.offset = Math.floor(n)
        break
      }
      case '--stratified':
        opts.stratified = true
        break
      case '--api-url': {
        const raw = argv[++i]
        if (raw === undefined) throw new Error('--api-url requires a value')
        opts.apiUrl = raw.replace(/\/$/, '')
        break
      }
      case '--cleanup':
        opts.cleanup = true
        break
      case '--skip-import':
        opts.skipImport = true
        break
      case '--verbose':
      case '-v':
        opts.verbose = true
        break
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return opts
}

function printHelp(): void {
  const help = [
    'LongMemEval benchmark for Cortex Hub knowledge_search',
    '',
    'Usage:',
    '  pnpm bench:longmemeval [--limit N] [--api-url URL] [--cleanup] [--skip-import] [--verbose]',
    '',
    'Flags:',
    '  --limit N       Only run the first N questions (default: all)',
    '  --api-url URL   Cortex API base URL (default: http://localhost:4000)',
    '  --cleanup       Delete all knowledge docs with projectId=longmemeval-bench and exit',
    '  --skip-import   Do not import sessions; assume they already exist in the project',
    '  --verbose       Print extra diagnostic output',
    '  -h, --help      Show this help',
  ].join('\n')
  process.stdout.write(`${help}\n`)
}

// ── Filesystem helpers ─────────────────────────────────────────────────────

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}

async function downloadDataset(): Promise<void> {
  await ensureDir(DATA_DIR)
  if (await fileExists(DATASET_PATH)) {
    const info = await stat(DATASET_PATH)
    if (info.size > 0) {
      log(`Dataset already cached at ${DATASET_PATH} (${formatBytes(info.size)})`)
      return
    }
  }

  log(`Downloading LongMemEval-S from ${DATASET_URL} ...`)
  const res = await fetch(DATASET_URL, { redirect: 'follow' })
  if (!res.ok || res.body === null) {
    throw new Error(
      `Failed to download dataset: HTTP ${res.status} ${res.statusText}`,
    )
  }

  // Node's fetch body is a WHATWG ReadableStream; convert for pipeline.
  const nodeStream = Readable.fromWeb(
    res.body as unknown as import('node:stream/web').ReadableStream,
  )
  const out = createWriteStream(DATASET_PATH)
  await pipeline(nodeStream, out)

  const info = await stat(DATASET_PATH)
  log(`Downloaded dataset: ${formatBytes(info.size)}`)
}

// ── Dataset parsing ────────────────────────────────────────────────────────

async function loadQuestions(limit: number, offset: number = 0, stratified: boolean = false): Promise<NormalisedQuestion[]> {
  const raw = await readFile(DATASET_PATH, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`Failed to parse dataset JSON: ${(err as Error).message}`)
  }

  const entries: RawQuestion[] = Array.isArray(parsed)
    ? (parsed as RawQuestion[])
    : Array.isArray((parsed as { data?: unknown }).data)
      ? ((parsed as { data: RawQuestion[] }).data)
      : []

  if (entries.length === 0) {
    throw new Error('Dataset parsed to zero questions — unexpected shape')
  }

  // Stratified sampling: pick `limit / numTypes` questions from EACH question_type
  if (stratified) {
    const byType = new Map<string, RawQuestion[]>()
    for (const entry of entries) {
      const t = entry.question_type ?? 'unknown'
      const list = byType.get(t) ?? []
      list.push(entry)
      byType.set(t, list)
    }
    const types = Array.from(byType.keys()).sort()
    const perType = Math.max(1, Math.floor(limit / types.length))
    const normalised: NormalisedQuestion[] = []
    for (const type of types) {
      const list = byType.get(type) ?? []
      let added = 0
      for (const entry of list) {
        if (added >= perType) break
        const q = normaliseQuestion(entry)
        if (q !== null) {
          normalised.push(q)
          added++
        }
      }
    }
    return normalised
  }

  const normalised: NormalisedQuestion[] = []
  let skipped = 0
  for (const entry of entries) {
    if (skipped < offset) {
      skipped++
      continue
    }
    const q = normaliseQuestion(entry)
    if (q !== null) normalised.push(q)
    if (normalised.length >= limit) break
  }
  return normalised
}

function normaliseQuestion(raw: RawQuestion): NormalisedQuestion | null {
  if (!raw.question_id || !raw.question) return null

  // LongMemEval-S format: haystack_sessions is parallel array where each entry is
  // a messages array (not a session object). Session IDs come from haystack_session_ids.
  const sessions: NormalisedSession[] = []
  const haystack = raw.haystack_sessions
  const sessionIds = Array.isArray(raw.haystack_session_ids) ? raw.haystack_session_ids : []

  if (Array.isArray(haystack)) {
    for (let i = 0; i < haystack.length; i++) {
      const item = haystack[i]
      // Case A: parallel-array format — item is messages array, session_id from sessionIds[i]
      if (Array.isArray(item)) {
        const sid = sessionIds[i]
        if (typeof sid !== 'string') continue
        const session = normaliseSession({ session_id: sid, messages: item as RawSession['messages'] })
        if (session !== null) sessions.push(session)
        continue
      }
      // Case B: object-style — {session_id, messages}
      if (item && typeof item === 'object') {
        const session = normaliseSession(item as RawSession)
        if (session !== null) sessions.push(session)
      }
    }
  } else if (haystack !== undefined && haystack !== null && typeof haystack === 'object') {
    // Case C: map keyed by session_id
    for (const [key, value] of Object.entries(haystack)) {
      if (value === null || typeof value !== 'object') continue
      const session = normaliseSession({ ...(value as RawSession), session_id: key })
      if (session !== null) sessions.push(session)
    }
  }

  if (sessions.length === 0) return null

  // Gold session identifiers — answer_session_ids is the canonical "correct" set in LongMemEval
  let gold: string[] = []
  if (Array.isArray(raw.answer_session_ids)) {
    gold = raw.answer_session_ids.filter((s): s is string => typeof s === 'string')
  }
  if (gold.length === 0) return null

  return {
    questionId: raw.question_id,
    question: raw.question,
    questionType: raw.question_type ?? 'unknown',
    answer: raw.answer ?? '',
    goldSessionIds: gold,
    sessions,
  }
}

function normaliseSession(raw: RawSession): NormalisedSession | null {
  const sessionId = raw.session_id ?? raw.sessionId ?? raw.id
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null

  const messages = Array.isArray(raw.messages) ? raw.messages : []
  if (messages.length === 0) return null

  // ── Match MemPalace methodology: only index USER messages ──
  // Their longmemeval_bench.py granularity="session" mode does:
  //   user_turns = [t["content"] for t in session if t["role"] == "user"]
  //   doc = "\n".join(user_turns)
  // Including assistant messages pollutes embeddings with boilerplate.
  const userContent: string[] = []
  for (const msg of messages) {
    const role = typeof msg.role === 'string' ? msg.role : 'user'
    if (role !== 'user') continue
    const content =
      typeof msg.content === 'string'
        ? msg.content
        : typeof msg.text === 'string'
          ? msg.text
          : ''
    if (content.length === 0) continue
    userContent.push(content)
  }
  if (userContent.length === 0) return null

  return { sessionId, content: userContent.join('\n') }
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

async function postJson<T>(
  url: string,
  body: unknown,
  timeoutMs = 30_000,
): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(
      `POST ${url} failed: HTTP ${res.status} ${res.statusText} — ${text.slice(0, 200)}`,
    )
  }
  try {
    return JSON.parse(text) as T
  } catch (err) {
    throw new Error(
      `POST ${url} returned non-JSON response: ${(err as Error).message} — ${text.slice(0, 120)}`,
    )
  }
}

async function deleteJson(url: string, timeoutMs = 15_000): Promise<void> {
  const res = await fetch(url, {
    method: 'DELETE',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok && res.status !== 404) {
    const text = await res.text()
    throw new Error(
      `DELETE ${url} failed: HTTP ${res.status} ${res.statusText} — ${text.slice(0, 200)}`,
    )
  }
}

async function getJson<T>(url: string, timeoutMs = 15_000): Promise<T> {
  const res = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(
      `GET ${url} failed: HTTP ${res.status} ${res.statusText} — ${text.slice(0, 200)}`,
    )
  }
  try {
    return JSON.parse(text) as T
  } catch (err) {
    throw new Error(
      `GET ${url} returned non-JSON response: ${(err as Error).message} — ${text.slice(0, 120)}`,
    )
  }
}

// ── Cortex API operations ──────────────────────────────────────────────────

async function importSession(
  apiUrl: string,
  session: NormalisedSession,
): Promise<string> {
  const body = {
    title: session.sessionId,
    content: session.content,
    tags: ['longmemeval', 'bench'],
    projectId: BENCH_PROJECT_ID,
    source: 'benchmark',
    origin: 'manual',
    category: 'benchmark',
  }
  const created = await postJson<{ id?: string; error?: string }>(
    `${apiUrl}/api/knowledge`,
    body,
    60_000,
  )
  if (!created.id) {
    throw new Error(
      `Knowledge create returned no id: ${JSON.stringify(created).slice(0, 200)}`,
    )
  }
  return created.id
}

async function searchKnowledge(
  apiUrl: string,
  query: string,
): Promise<KnowledgeSearchResultItem[]> {
  const res = await postJson<KnowledgeSearchResponse>(
    `${apiUrl}/api/knowledge/search`,
    {
      query,
      projectId: BENCH_PROJECT_ID,
      tags: ['longmemeval'],
      limit: TOP_K,
    },
    30_000,
  )
  if (res.error) throw new Error(`Search error: ${res.error}`)
  return res.results ?? []
}

async function listBenchDocuments(apiUrl: string): Promise<KnowledgeDocument[]> {
  const res = await getJson<KnowledgeListResponse>(
    `${apiUrl}/api/knowledge?projectId=${encodeURIComponent(BENCH_PROJECT_ID)}&limit=5000`,
  )
  return res.documents ?? []
}

async function cleanup(apiUrl: string): Promise<void> {
  log(`Cleaning up bench documents from ${apiUrl} (projectId=${BENCH_PROJECT_ID}) ...`)
  let totalDeleted = 0
  // Loop: API returns up to 5000 at a time. Delete until list is empty.
  // This keeps memory bounded if the dataset ever exceeds that.
  /* eslint-disable no-constant-condition */
  while (true) {
    const docs = await listBenchDocuments(apiUrl)
    if (docs.length === 0) break
    for (const doc of docs) {
      try {
        await deleteJson(`${apiUrl}/api/knowledge/${encodeURIComponent(doc.id)}`)
        totalDeleted++
      } catch (err) {
        log(`  ! Failed to delete ${doc.id}: ${(err as Error).message}`)
      }
    }
    if (docs.length < 5000) break
  }
  log(`Cleanup done. Deleted ${totalDeleted} document(s).`)
}

// ── Metrics ────────────────────────────────────────────────────────────────

function computeOutcomeMetrics(
  goldSessionIds: string[],
  rankedDocIds: string[],
): { hitRank: number | null; r_at_5: number; r_at_10: number; ndcg_at_10: number } {
  const goldSet = new Set(goldSessionIds)

  let hitRank: number | null = null
  for (let i = 0; i < rankedDocIds.length; i++) {
    if (goldSet.has(rankedDocIds[i] as string)) {
      hitRank = i + 1
      break
    }
  }

  const r_at_5 = hitRank !== null && hitRank <= 5 ? 1 : 0
  const r_at_10 = hitRank !== null && hitRank <= 10 ? 1 : 0

  // NDCG@10 with binary relevance and IDCG normalised to a single relevant item
  // (LongMemEval retrieval is evaluated against a single gold session per q).
  let dcg = 0
  const k = Math.min(rankedDocIds.length, 10)
  for (let i = 0; i < k; i++) {
    if (goldSet.has(rankedDocIds[i] as string)) {
      dcg += 1 / Math.log2(i + 2)
    }
  }
  const idcg = 1 // perfect ranking puts the first gold at position 1
  const ndcg_at_10 = dcg / idcg

  return { hitRank, r_at_5, r_at_10, ndcg_at_10 }
}

function average(values: number[]): number {
  if (values.length === 0) return 0
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}

// ── Output formatting ──────────────────────────────────────────────────────

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function renderMarkdown(summary: BenchSummary): string {
  const m = summary.metrics
  const lines: string[] = []
  lines.push('## Cortex Hub — LongMemEval Benchmark Results')
  lines.push('')
  lines.push(`- **Dataset**: LongMemEval-S cleaned (${summary.datasetUrl})`)
  lines.push(`- **API**: ${summary.apiUrl}`)
  lines.push(`- **Project**: ${summary.projectId}`)
  lines.push(`- **Questions scored**: ${summary.scoredQuestions} / ${summary.totalQuestions}`)
  lines.push(`- **Duration**: ${(summary.durationMs / 1000).toFixed(1)}s`)
  lines.push('')
  lines.push('| Metric | Cortex Hub | MemPalace baseline |')
  lines.push('| --- | --- | --- |')
  lines.push(`| R@5 | ${pct(m.r_at_5)} | 96.6% |`)
  lines.push(`| R@10 | ${pct(m.r_at_10)} | n/a |`)
  lines.push(`| NDCG@10 | ${m.ndcg_at_10.toFixed(4)} | n/a |`)
  lines.push(`| MRR | ${m.mrr.toFixed(4)} | n/a |`)
  lines.push(`| Hit rate (any K) | ${pct(m.hitRate)} | n/a |`)
  lines.push('')
  if (Object.keys(summary.perType).length > 0) {
    lines.push('### By question type')
    lines.push('')
    lines.push('| Type | N | R@5 | R@10 | NDCG@10 |')
    lines.push('| --- | ---: | ---: | ---: | ---: |')
    for (const [type, stats] of Object.entries(summary.perType)) {
      lines.push(
        `| ${type} | ${stats.count} | ${pct(stats.r_at_5)} | ${pct(stats.r_at_10)} | ${stats.ndcg_at_10.toFixed(4)} |`,
      )
    }
    lines.push('')
  }
  return lines.join('\n')
}

function log(message: string): void {
  process.stdout.write(`${message}\n`)
}

// ── Main ───────────────────────────────────────────────────────────────────

async function run(): Promise<number> {
  let opts: CliOptions
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`)
    printHelp()
    return 2
  }

  if (opts.cleanup) {
    try {
      await cleanup(opts.apiUrl)
      return 0
    } catch (err) {
      process.stderr.write(`Cleanup failed: ${(err as Error).message}\n`)
      return 1
    }
  }

  await ensureDir(DATA_DIR)
  await ensureDir(RESULTS_DIR)

  try {
    await downloadDataset()
  } catch (err) {
    process.stderr.write(`Dataset download failed: ${(err as Error).message}\n`)
    return 1
  }

  const datasetSize = (await stat(DATASET_PATH)).size
  const questions = await loadQuestions(opts.limit, opts.offset, opts.stratified)
  log(`Loaded ${questions.length} question(s) from dataset (${formatBytes(datasetSize)})`)

  const outcomes: QuestionOutcome[] = []
  const notes: string[] = []
  const startedAt = Date.now()

  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi] as NormalisedQuestion
    const progress = `[${qi + 1}/${questions.length}] ${q.questionId}`

    const docIdBySessionId = new Map<string, string>()
    let importFailures = 0
    let importLatencyMs = 0
    const importStart = Date.now()

    if (!opts.skipImport) {
      // Parallel import with concurrency limit (Gemini embedding API allows ~10 concurrent)
      const CONCURRENCY = 10
      for (let i = 0; i < q.sessions.length; i += CONCURRENCY) {
        const batch = q.sessions.slice(i, i + CONCURRENCY)
        const results = await Promise.allSettled(
          batch.map(session => importSession(opts.apiUrl, session).then(docId => ({ session, docId }))),
        )
        for (const r of results) {
          if (r.status === 'fulfilled') {
            docIdBySessionId.set(r.value.session.sessionId, r.value.docId)
          } else {
            importFailures++
            if (opts.verbose) {
              log(`  ! import failed: ${(r.reason as Error).message}`)
            }
          }
        }
      }
    }
    importLatencyMs = Date.now() - importStart

    if (docIdBySessionId.size === 0 && !opts.skipImport) {
      log(`${progress} — SKIPPED (no sessions imported)`)
      outcomes.push({
        questionId: q.questionId,
        questionType: q.questionType,
        goldSessionIds: q.goldSessionIds,
        topDocIds: [],
        hitRank: null,
        r_at_5: 0,
        r_at_10: 0,
        ndcg_at_10: 0,
        importedDocs: 0,
        importFailures,
        searchLatencyMs: 0,
        importLatencyMs,
        note: 'import_failed',
      })
      continue
    }

    let searchResults: KnowledgeSearchResultItem[] = []
    const searchStart = Date.now()
    try {
      searchResults = await searchKnowledge(opts.apiUrl, q.question)
    } catch (err) {
      log(`${progress} — SEARCH FAILED: ${(err as Error).message}`)
      outcomes.push({
        questionId: q.questionId,
        questionType: q.questionType,
        goldSessionIds: q.goldSessionIds,
        topDocIds: [],
        hitRank: null,
        r_at_5: 0,
        r_at_10: 0,
        ndcg_at_10: 0,
        importedDocs: docIdBySessionId.size,
        importFailures,
        searchLatencyMs: Date.now() - searchStart,
        importLatencyMs,
        note: 'search_failed',
      })
      // Best-effort cleanup so the next question starts from a clean slate.
      await cleanupDocs(opts.apiUrl, [...docIdBySessionId.values()])
      continue
    }
    const searchLatencyMs = Date.now() - searchStart

    // Rank by the order returned (already sorted by hybridScore descending).
    // Collapse duplicate documentIds while preserving first occurrence.
    const seen = new Set<string>()
    const rankedDocIds: string[] = []
    for (const hit of searchResults) {
      const docId = hit.documentId ?? hit.document?.id ?? undefined
      if (typeof docId !== 'string' || docId.length === 0) continue
      if (seen.has(docId)) continue
      seen.add(docId)
      rankedDocIds.push(docId)
    }

    // Translate ranked document IDs back to session IDs by looking up our import map.
    // Also fall back to the hit title if the mapping isn't found (robust to skipImport).
    const docIdToSessionId = new Map<string, string>()
    for (const [sid, did] of docIdBySessionId.entries()) {
      docIdToSessionId.set(did, sid)
    }
    const rankedSessionIds: string[] = []
    for (let i = 0; i < rankedDocIds.length; i++) {
      const did = rankedDocIds[i] as string
      const mapped = docIdToSessionId.get(did)
      if (mapped !== undefined) {
        rankedSessionIds.push(mapped)
        continue
      }
      // Fall back to the title returned by search; imports use title=session_id.
      const hit = searchResults[i]
      const title = typeof hit?.title === 'string' ? hit.title : undefined
      if (title !== undefined) rankedSessionIds.push(title)
      else rankedSessionIds.push(did)
    }

    const metrics = computeOutcomeMetrics(q.goldSessionIds, rankedSessionIds)

    const outcome: QuestionOutcome = {
      questionId: q.questionId,
      questionType: q.questionType,
      goldSessionIds: q.goldSessionIds,
      topDocIds: rankedSessionIds.slice(0, TOP_K),
      hitRank: metrics.hitRank,
      r_at_5: metrics.r_at_5,
      r_at_10: metrics.r_at_10,
      ndcg_at_10: metrics.ndcg_at_10,
      importedDocs: docIdBySessionId.size,
      importFailures,
      searchLatencyMs,
      importLatencyMs,
    }
    outcomes.push(outcome)

    const status = outcome.r_at_5 === 1 ? 'SUCCESS R@5' : outcome.r_at_10 === 1 ? 'SUCCESS R@10' : 'MISS'
    log(
      `${progress} — ${status} (rank=${outcome.hitRank ?? '-'} ndcg=${outcome.ndcg_at_10.toFixed(3)} imports=${outcome.importedDocs} search=${searchLatencyMs}ms)`,
    )

    // Remove this question's sessions so that the next question sees a fresh haystack.
    // LongMemEval is normally scored per-question with its own haystack.
    await cleanupDocs(opts.apiUrl, [...docIdBySessionId.values()])
  }

  const finishedAt = Date.now()
  const scored = outcomes.filter((o) => o.note === undefined)
  const r5 = average(scored.map((o) => o.r_at_5))
  const r10 = average(scored.map((o) => o.r_at_10))
  const ndcg = average(scored.map((o) => o.ndcg_at_10))
  const mrr = average(scored.map((o) => (o.hitRank !== null ? 1 / o.hitRank : 0)))
  const hitRate = average(scored.map((o) => (o.hitRank !== null ? 1 : 0)))

  const perType: Record<string, { count: number; r_at_5: number; r_at_10: number; ndcg_at_10: number }> = {}
  for (const o of scored) {
    const bucket = perType[o.questionType] ?? { count: 0, r_at_5: 0, r_at_10: 0, ndcg_at_10: 0 }
    bucket.count += 1
    bucket.r_at_5 += o.r_at_5
    bucket.r_at_10 += o.r_at_10
    bucket.ndcg_at_10 += o.ndcg_at_10
    perType[o.questionType] = bucket
  }
  for (const stats of Object.values(perType)) {
    stats.r_at_5 /= stats.count
    stats.r_at_10 /= stats.count
    stats.ndcg_at_10 /= stats.count
  }

  if (scored.length < outcomes.length) {
    notes.push(`${outcomes.length - scored.length} question(s) skipped due to errors`)
  }

  const summary: BenchSummary = {
    datasetUrl: DATASET_URL,
    datasetBytes: datasetSize,
    apiUrl: opts.apiUrl,
    projectId: BENCH_PROJECT_ID,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: finishedAt - startedAt,
    totalQuestions: outcomes.length,
    scoredQuestions: scored.length,
    skippedQuestions: outcomes.length - scored.length,
    metrics: {
      r_at_5: r5,
      r_at_10: r10,
      ndcg_at_10: ndcg,
      mrr,
      hitRate,
    },
    perType,
    outcomes,
    baselines: { memPalace_r_at_5: 0.966 },
    notes,
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const resultsPath = join(RESULTS_DIR, `longmemeval_${timestamp}.json`)
  await writeFile(resultsPath, JSON.stringify(summary, null, 2), 'utf8')

  log('')
  log(renderMarkdown(summary))
  log('')
  log(`Results written to ${resultsPath}`)
  return 0
}

async function cleanupDocs(apiUrl: string, docIds: string[]): Promise<void> {
  for (const id of docIds) {
    try {
      await deleteJson(`${apiUrl}/api/knowledge/${encodeURIComponent(id)}`)
    } catch {
      // best-effort
    }
  }
}

run()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`Fatal: ${(err as Error).stack ?? String(err)}\n`)
    process.exit(1)
  })
