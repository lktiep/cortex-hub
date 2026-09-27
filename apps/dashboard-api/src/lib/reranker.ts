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
 * vector candidates, then ask a decision model about each one. This wraps
 * TypeSafe's Jev, which answers a typed yes/no with a calibrated probability
 * instead of generating text, so there is nothing to parse and each candidate
 * costs a fraction of a chat completion.
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

/** Requests in flight per search. Jev answers in ~50-500ms, so this is throughput. */
const RERANK_CONCURRENCY = 8

/**
 * How much the rerank probability counts against the vector score.
 *
 * Not 1.0 on purpose: Jev returns a calibrated probability, and a flat answer
 * near 0.5 carries no information. Blending keeps a candidate the embedder was
 * certain about from being buried by one indecisive judgement.
 */
const RERANK_WEIGHT = 0.8

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
  })

  cached = {
    rerank: (query, candidates) =>
      rerankByRelevance(client, query, candidates, {
        concurrency: RERANK_CONCURRENCY,
        weight: RERANK_WEIGHT,
        instructions:
          'Does the candidate source file excerpt contain the code that answers the query?',
        criteria: {
          true: 'The excerpt contains the implementation, declaration or definition the query asks about',
          false: 'The excerpt only mentions or uses the subject of the query, or is about a neighbouring concern',
        },
        onError: (index, err) => {
          logger.warn(`candidate ${index} kept its vector score: ${String(err).slice(0, 160)}`)
        },
      }),
  }
  cachedKey = apiKey
  return cached
}
