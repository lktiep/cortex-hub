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
  /** What the caller is looking for — replaces the default relevance wording. */
  instructions?: string
  /**
   * Hard cap on how many candidates are ranked. Beyond it the tail keeps its
   * retrieval order and sorts below everything that was ranked.
   */
  maxCandidates?: number
  /** Candidates per Jev call. A larger pool is ranked in rounds. */
  roundSize?: number
  /** How much of each candidate the reranker is shown. */
  excerptChars?: number
  /** Max rounds in flight at once. Only matters for pools above roundSize. */
  concurrency?: number
  /**
   * How much to trust the reranker's ordering, 0..1. 1 = ranked order only.
   * Below 1 the retrieval score acts inside a single rank gap, so it breaks
   * ties and nudges neighbours but can never reorder the list wholesale.
   */
  weight?: number
  /** A round that fails (network, rate limit) leaves its candidates in retrieval order. */
  onError?: (round: number, err: unknown) => void
}

export interface Reranked<T> {
  item: T
  /** Final ordering score. */
  score: number
  /** Original retrieval score, untouched. */
  retrievalScore: number
  /**
   * Where the reranker put this candidate, 1.0 for first down to 1/n for last,
   * or null if its round failed. This is a *position*, not a probability: it
   * says "ranked above that one", never "94% relevant", and it is only
   * comparable within the same round.
   */
  relevance: number | null
}

/** Build the one choice question that ranks a whole round of candidates. */
function buildRoundQuestion(
  round: Array<{ text: string }>,
  instructions: string,
  excerptChars: number,
): { question: ChoiceQuestion; ids: string[] } {
  const criteria: Record<string, string> = {}
  const ids: string[] = []
  round.forEach((c, i) => {
    const id = `c${i + 1}`
    ids.push(id)
    criteria[id] = c.text.slice(0, excerptChars).replace(/\s+/g, ' ').trim()
  })
  // No "none of these" option on purpose. Offered one, Jev returns it for a
  // third of real questions and the answer carries no ordering, so the cut has
  // to live in a separate graded question instead of inside the ranking.
  return { question: choice(instructions, criteria), ids }
}

/**
 * Re-rank retrieval candidates by asking Jev, in one call, to order the whole
 * pool against the query — the judgement a single embedding cannot make.
 *
 * One question about the pool, not one question per candidate. The per-candidate
 * shape reads naturally and measures worse: on a 200-question LoCoMo set
 * vectorize-io/hindsight put listwise at recall@1 0.94 against 0.87 for one call
 * per candidate, at a thirtieth of the calls — and a thirtieth of the latency,
 * because N round trips collapse into one. TypeSafe's own re-ranking cookbook
 * reports top-1 5% -> 18% and top-10 38% -> 62% over BM25 on CLERC:
 * https://docs.typesafe.ai/cookbooks/rerank_typesafe
 *
 * Intended shape: over-fetch from the vector store (4-5x the wanted limit),
 * rerank, then trim.
 */
export async function rerankByRelevance<T>(
  client: TypeSafeClient,
  query: string,
  candidates: Array<{ item: T; text: string; score: number }>,
  opts: RerankOptions = {},
): Promise<Array<Reranked<T>>> {
  const weight = opts.weight ?? 1
  const maxCandidates = opts.maxCandidates ?? 300
  const roundSize = Math.max(2, opts.roundSize ?? 250)
  const excerptChars = opts.excerptChars ?? 400
  const instructions =
    opts.instructions ?? 'Which passage contains what is needed to answer the query?'

  // A rank gap. Every score below is expressed in these units, so a failed
  // round, an unranked tail and a tie-break all stay on one comparable scale.
  const gap = 1 / Math.max(candidates.length, 1)
  const tieBreak = (retrievalScore: number) => (1 - weight) * gap * retrievalScore

  // Ranking a 10k-hit pool would cost more than it can pay back, and the tail
  // of a vector search is noise anyway: cap it and leave the rest as retrieved.
  const ranked = candidates.slice(0, maxCandidates)
  const unranked: Array<Reranked<T>> = candidates.slice(maxCandidates).map((c) => ({
    item: c.item,
    retrievalScore: c.score,
    relevance: null,
    score: tieBreak(c.score),
  }))

  const rounds: Array<Array<{ item: T; text: string; score: number }>> = []
  for (let i = 0; i < ranked.length; i += roundSize) {
    rounds.push(ranked.slice(i, i + roundSize))
  }

  const perRound = await mapWithConcurrency(rounds, opts.concurrency ?? 4, async (round, r) => {
    const fallback = (): Array<Reranked<T>> =>
      round.map((c) => ({
        item: c.item,
        retrievalScore: c.score,
        relevance: null,
        score: tieBreak(c.score),
      }))

    if (round.length < 2) {
      // Nothing to order. Asking would spend a call to learn that c1 wins.
      return fallback()
    }

    const { question, ids } = buildRoundQuestion(round, instructions, excerptChars)

    let probabilities: Record<string, number>
    try {
      const res = await client.systemOne({ query }, { best: question })
      const answer = res.answers.best
      if (!answer || answer.type !== 'choice') throw new Error('expected a choice answer')
      probabilities = answer.probabilities ?? {}
    } catch (err) {
      // A partial outage degrades to today's ordering instead of dropping results.
      opts.onError?.(r, err)
      return fallback()
    }

    const order = ids
      .map((id, i) => ({ i, p: probabilities[id] }))
      .filter((e): e is { i: number; p: number } => typeof e.p === 'number')
      .sort((a, b) => b.p - a.p)

    if (order.length === 0) return fallback()

    const out = fallback()
    order.forEach((e, rank) => {
      const c = round[e.i]!
      // Top = 1.0, each place below one gap lower. The probability itself is
      // not a calibrated confidence, so only its position is used.
      const position = (order.length - rank) / order.length
      out[e.i] = {
        item: c.item,
        retrievalScore: c.score,
        relevance: position,
        score: position + tieBreak(c.score),
      }
    })
    return out
  })

  return [...perRound.flat(), ...unranked].sort((a, b) => b.score - a.score)
}
