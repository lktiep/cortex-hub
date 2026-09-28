/**
 * Reciprocal rank fusion for memory search.
 *
 * The two arms score on different scales — cosine similarity is bounded, BM25
 * is not and means nothing outside its own query — so they are merged by rank.
 * Code search leaves this to Qdrant; memory search does it here because the
 * result has to come back as a relevance in [0, 1]: Mem9 blends it with recency,
 * and the search route ranks it against session summaries scored on that scale.
 */

import type { QdrantSearchResult } from './types.js'

/** The constant from Cormack et al. (2009), and the one most engines default to. */
export const RRF_K = 60

/**
 * Merge ranked lists by reciprocal rank, scaled so 1 means "first in every arm
 * that found anything".
 *
 * An empty arm is left out of the scale rather than counted as a miss: a query
 * with no lexical match should rank on its vectors alone, not have every score
 * halved for a signal that was never there.
 */
export function fuseByRank(arms: QdrantSearchResult[][], k = RRF_K): QdrantSearchResult[] {
  const live = arms.filter((arm) => arm.length > 0)
  if (live.length === 0) return []

  const fused = new Map<string, QdrantSearchResult>()
  for (const arm of live) {
    arm.forEach((hit, rank) => {
      const contribution = 1 / (k + rank + 1)
      const seen = fused.get(hit.id)
      if (seen) seen.score += contribution
      else fused.set(hit.id, { ...hit, score: contribution })
    })
  }

  const best = live.length / (k + 1)
  return [...fused.values()]
    .map((hit) => ({ ...hit, score: hit.score / best }))
    .sort((a, b) => b.score - a.score)
}
