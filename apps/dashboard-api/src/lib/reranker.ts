/**
 * Centralized reranker factory.
 *
 * Retrieval here is a single embedding lookup: the query and every chunk are
 * compressed to one vector each, and Qdrant returns whatever sits closest. That
 * answers "is this similar", never "does this actually contain what was asked
 * for" — which is why a measured recall@1 of 2/8 sits next to a recall@5 of 6/8
 * on this repo's own index. The right hit is usually retrieved; it is just not
 * first.
 *
 * A reranker fixes the ordering rather than the retrieval: over-fetch cheap
 * vector candidates, then ask a decision model to order them. This wraps
 * TypeSafe's Jev, which answers a typed question instead of generating text, so
 * there is nothing to parse and one search costs a fraction of a chat
 * completion.
 *
 * The question is asked once about the whole pool, not once per candidate. The
 * per-candidate version shipped first because it reads naturally; it is both
 * slower and less accurate, and vectorize-io/hindsight measured the difference
 * on a 200-question set at recall@1 0.94 listwise against 0.87 per candidate —
 * with a thirtieth of the calls, so a search now waits on one round trip
 * instead of ceil(candidates / 8) of them.
 *
 * Disabled unless TYPESAFE_API_KEY is set — with no key every search path keeps
 * exactly its current behaviour.
 */

import { TypeSafeClient, rerankByRelevance } from '@cortex/shared-mem9'
import type { Reranked } from '@cortex/shared-mem9'
import { createLogger } from '@cortex/shared-utils'

const logger = createLogger('reranker')

/** How many candidates to pull per wanted result when reranking is on. */
export const RERANK_OVERFETCH = 4

/**
 * Candidates per Jev call. Above this the pool is ranked in rounds, whose
 * positions are then merged — so keep the whole pool in one round when it fits.
 */
const RERANK_ROUND_SIZE = 250

/** Hard ceiling on what gets ranked at all; the tail keeps its vector order. */
const RERANK_MAX_CANDIDATES = 300

/** Characters of each excerpt shown to the reranker. */
const RERANK_EXCERPT_CHARS = 400

/**
 * How much the reranked order counts against the vector score.
 *
 * Not 1.0 so that the vector score still breaks ties — but it is deliberately
 * only a tie-break. Jev's probabilities are rank positions, not calibrated
 * confidences, so treating them as a blendable quantity lets a 0.2 weight on a
 * cosine score silently undo the whole ranking once the pool is large enough
 * that one rank gap (1/n) is smaller than the spread in vector scores.
 */
const RERANK_WEIGHT = 0.9

/** One listwise call carries the whole pool, so it needs more than the 15s default. */
const RERANK_TIMEOUT_MS = 45_000

export interface Reranker {
  rerank<T>(
    query: string,
    candidates: Array<{ item: T; text: string; score: number }>,
  ): Promise<Array<Reranked<T>>>
}

let cached: Reranker | null = null
let cachedKey: string | undefined

/**
 * Returns a reranker, or null when none is configured.
 *
 * Callers must treat null as "skip reranking", not as an error: reranking is an
 * improvement to result ordering, never a dependency of search.
 */
export function getReranker(): Reranker | null {
  const apiKey = process.env['TYPESAFE_API_KEY']?.trim()
  if (!apiKey) return null

  // Rebuild if the key was rotated at runtime.
  if (cached && cachedKey === apiKey) return cached

  const client = new TypeSafeClient({
    apiKey,
    model: process.env['TYPESAFE_MODEL'] ?? 'jev-latest',
    timeoutMs: RERANK_TIMEOUT_MS,
  })

  cached = {
    rerank: (query, candidates) =>
      rerankByRelevance(client, query, candidates, {
        weight: RERANK_WEIGHT,
        roundSize: RERANK_ROUND_SIZE,
        maxCandidates: RERANK_MAX_CANDIDATES,
        excerptChars: RERANK_EXCERPT_CHARS,
        instructions:
          'Which source file excerpt contains the code that answers the query — the implementation, declaration or definition asked about, not a file that merely mentions or uses it?',
        onError: (round, err) => {
          logger.warn(`rerank round ${round} kept its vector order: ${String(err).slice(0, 160)}`)
        },
      }),
  }
  cachedKey = apiKey
  return cached
}
