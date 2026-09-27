/**
 * TypeSafe AI System One (Jev) REST client — zero dependencies.
 *
 * Jev answers *typed* questions about a state instead of generating text: a
 * yes/no probability (noul), a pick from options (choice), or a graded score.
 * That makes it useful in two places where this codebase currently pays for a
 * full chat completion and then has to parse JSON back out of prose:
 *
 *   1. Re-ranking retrieval candidates (see rerankByRelevance below). An
 *      embedding model decides similarity in one shot and cannot be asked
 *      "does this passage actually answer the query"; Jev can, per candidate,
 *      in parallel.
 *   2. Small decisions with a fixed answer set — is this task worth saving as
 *      a recipe, does this new fact replace an existing memory. Those are
 *      choice/noul questions, so there is no JSON to parse and no parse to fail.
 *
 * Wire format: POST https://api.typesafe.ai/v1/systemone
 *   { state, model, questions: { <key>: { type, instructions, criteria } } }
 *   -> { model, answers: { <key>: { type, noul } | { type, choice, confidence,
 *        probabilities } }, usage: { input_tokens, output_tokens } }
 *
 * Docs: https://docs.typesafe.ai/api
 */

const DEFAULT_BASE_URL = 'https://api.typesafe.ai/v1'
const DEFAULT_MODEL = 'jev-latest'

/** Retryable statuses: rate limited (429) and overloaded (529). */
const RETRYABLE = new Set([429, 500, 502, 503, 529])

export interface TypeSafeConfig {
  apiKey: string
  /** Override for a proxy or a pinned region. */
  baseUrl?: string
  /** Defaults to 'jev-latest'; pin a version (e.g. 'jev-1.13') for reproducible scores. */
  model?: string
  timeoutMs?: number
  maxRetries?: number
}

/** A yes/no question. `criteria` describes what true and false mean. */
export interface NoulQuestion {
  type: 'noul'
  instructions: string
  criteria: { true: string; false: string }
}

/** A pick-one question. `criteria` maps each option id to what it means. */
export interface ChoiceQuestion {
  type: 'choice'
  instructions: string
  criteria: Record<string, string | null>
}

/** A graded question. `criteria` maps each level, lowest to highest. */
export interface ScoreQuestion {
  type: 'score'
  instructions: string
  criteria: Record<string, string | null>
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion

export interface NoulAnswer {
  type: 'noul'
  /** Probability the statement is true, 0..1. */
  noul: number
}

export interface ChoiceAnswer {
  type: 'choice'
  /** The option with the highest probability. */
  choice: string
  /** How peaked the distribution is, 0..1 — low means the model is guessing. */
  confidence: number
  probabilities: Record<string, number>
}

export interface ScoreAnswer {
  type: 'score'
  score: number
  confidence: number
  probabilities: Record<string, number>
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer

export interface SystemOneResult {
  model: string
  answers: Record<string, Answer>
  usage: { input_tokens: number; output_tokens: number }
}

export function noul(instructions: string, criteria: { true: string; false: string }): NoulQuestion {
  return { type: 'noul', instructions, criteria }
}

export function choice(instructions: string, criteria: Record<string, string | null>): ChoiceQuestion {
  return { type: 'choice', instructions, criteria }
}

export function score(instructions: string, criteria: Record<string, string | null>): ScoreQuestion {
  return { type: 'score', instructions, criteria }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class TypeSafeClient {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly model: string
  private readonly timeoutMs: number
  private readonly maxRetries: number

  constructor(config: TypeSafeConfig) {
    if (!config.apiKey) throw new Error('TypeSafeClient requires an apiKey')
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
    this.apiKey = config.apiKey
    this.model = config.model ?? DEFAULT_MODEL
    this.timeoutMs = config.timeoutMs ?? 15_000
    this.maxRetries = config.maxRetries ?? 2
  }

  /**
   * Ask one or more questions about a single state. Every question is evaluated
   * in parallel server-side, so asking five costs barely more latency than one.
   */
  async systemOne(
    state: unknown,
    questions: Record<string, Question>,
  ): Promise<SystemOneResult> {
    let lastErr = ''

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let res: Response
      try {
        res = await fetch(`${this.baseUrl}/systemone`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({ state, model: this.model, questions }),
          signal: AbortSignal.timeout(this.timeoutMs),
        })
      } catch (err) {
        // Network error or timeout — both worth one more try.
        lastErr = String(err).slice(0, 200)
        if (attempt < this.maxRetries) {
          await sleep(500 * 2 ** attempt)
          continue
        }
        throw new Error(`TypeSafe request failed: ${lastErr}`)
      }

      if (RETRYABLE.has(res.status) && attempt < this.maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after'))
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt)
        continue
      }

      if (!res.ok) {
        throw new Error(`TypeSafe ${res.status}: ${(await res.text()).slice(0, 200)}`)
      }

      return (await res.json()) as SystemOneResult
    }

    throw new Error(`TypeSafe request failed after ${this.maxRetries + 1} attempts: ${lastErr}`)
  }
}

/** Run `tasks` with at most `limit` in flight, preserving input order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let cursor = 0

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      out[i] = await fn(items[i]!, i)
    }
  })

  await Promise.all(workers)
  return out
}

export interface RerankOptions {
  /** Max simultaneous requests. TypeSafe answers in ~50-500ms, so this sets throughput. */
  concurrency?: number
  /** What the caller is looking for — replaces the default relevance wording. */
  instructions?: string
  criteria?: { true: string; false: string }
  /**
   * How much to trust the reranker vs the original retrieval score, 0..1.
   * 1 = rerank score only; 0 = ignore the reranker. Blending keeps a candidate
   * the embedder was very sure about from being buried by one flat Jev answer.
   */
  weight?: number
  /** Candidates that fail (network, rate limit) keep their original score. */
  onError?: (index: number, err: unknown) => void
}

export interface Reranked<T> {
  item: T
  /** Final ordering score. */
  score: number
  /** Original retrieval score, untouched. */
  retrievalScore: number
  /** Jev's probability that this candidate answers the query, or null if the call failed. */
  relevance: number | null
}

/**
 * Re-rank retrieval candidates by asking Jev, per candidate, whether it
 * actually answers the query — the judgement a single embedding cannot make.
 *
 * Intended shape: over-fetch from the vector store (4-5x the wanted limit),
 * rerank, then trim. TypeSafe's own re-ranking cookbook reports top-1 accuracy
 * 5% -> 18% and top-10 38% -> 62% over BM25 on CLERC with this pattern:
 * https://docs.typesafe.ai/cookbooks/rerank_typesafe
 */
export async function rerankByRelevance<T>(
  client: TypeSafeClient,
  query: string,
  candidates: Array<{ item: T; text: string; score: number }>,
  opts: RerankOptions = {},
): Promise<Array<Reranked<T>>> {
  const weight = opts.weight ?? 1
  const question = noul(
    opts.instructions ??
      'Does the candidate passage contain what is needed to answer the query?',
    opts.criteria ?? {
      true: 'The passage contains the specific code, definition or fact the query asks for',
      false: 'The passage is about a related topic but does not contain what the query asks for',
    },
  )

  const scored = await mapWithConcurrency(candidates, opts.concurrency ?? 8, async (c, i) => {
    try {
      const res = await client.systemOne(
        { query, candidate_passage: c.text },
        { relevant: question },
      )
      const answer = res.answers.relevant
      const relevance = answer && answer.type === 'noul' ? answer.noul : null
      return { item: c.item, retrievalScore: c.score, relevance }
    } catch (err) {
      opts.onError?.(i, err)
      return { item: c.item, retrievalScore: c.score, relevance: null }
    }
  })

  return scored
    .map((s) => ({
      ...s,
      // A failed candidate keeps its retrieval score, so a partial outage
      // degrades to today's ordering instead of dropping results.
      score: s.relevance === null ? s.retrievalScore : s.relevance * weight + s.retrievalScore * (1 - weight),
    }))
    .sort((a, b) => b.score - a.score)
}
