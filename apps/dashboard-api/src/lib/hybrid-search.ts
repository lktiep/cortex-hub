/**
 * Hybrid retrieval for code search: a vector arm and a BM25 arm, fused by Qdrant.
 *
 * Measured on this repo's own index (1382 chunks, 15 hand-written questions with
 * a known answer file), the vector arm put the right file in the top 10 every
 * single time but first only 53% of the time. Retrieval was never the weak part;
 * ordering was. A lexical arm fixes some of the orderings a single embedding
 * cannot, because it answers "does this contain the identifier that was typed"
 * rather than "does this look similar":
 *
 *   vector          recall@1 0.533  recall@3 0.667  recall@10 1.000  MRR 0.656
 *   bm25            recall@1 0.267  recall@3 0.667  recall@10 1.000  MRR 0.530
 *   hybrid (rrf)    recall@1 0.600  recall@3 0.733  recall@10 1.000  MRR 0.703
 *
 * Neither arm is good enough alone — BM25 by itself is the worst of the three —
 * but fusing them improved three queries and regressed none. It costs no tokens
 * and about a millisecond, which is why it runs by default where the LLM reranker
 * stays off: on the same gold set the reranker did not move recall@1 at all, for
 * +2.1s and 1,359 tokens per query.
 *
 * Run `pnpm --filter @cortex/benchmarks bench:retrieval -- --project <id>` to
 * reproduce; the numbers above are that harness's output, not an estimate.
 */

import { querySparseVector, SPARSE_VECTOR_NAME } from '@cortex/shared-mem9'
import { createLogger } from '@cortex/shared-utils'

const logger = createLogger('hybrid-search')

/**
 * Fusion needs something to fuse. At a limit of 10 the two arms overlap so much
 * that reciprocal rank has little to work with, so each arm fetches at least this
 * many candidates whatever the caller asked to be shown.
 */
export const HYBRID_FETCH_FLOOR = 30

/** Re-probe a collection's capability this often, so a re-index is picked up. */
const CAPABILITY_TTL_MS = 60_000

const capabilityCache = new Map<string, { sparse: boolean; checkedAt: number }>()

/**
 * Whether a collection carries the lexical arm.
 *
 * Qdrant cannot add a sparse vector to a collection that already exists, so any
 * collection indexed before hybrid search existed has none and has to be served
 * by the vector arm alone. The answer only changes when a project is re-indexed,
 * hence the cache: this runs on the hot path of every search.
 */
export async function hasSparseVector(qdrantUrl: string, collection: string): Promise<boolean> {
  const cached = capabilityCache.get(collection)
  if (cached && Date.now() - cached.checkedAt < CAPABILITY_TTL_MS) return cached.sparse

  let sparse = false
  try {
    const res = await fetch(`${qdrantUrl}/collections/${collection}`, {
      signal: AbortSignal.timeout(3000),
    })
    if (res.ok) {
      const info = (await res.json()) as {
        result?: { config?: { params?: { sparse_vectors?: Record<string, unknown> } } }
      }
      sparse = SPARSE_VECTOR_NAME in (info.result?.config?.params?.sparse_vectors ?? {})
    }
  } catch (err) {
    // Not knowing means falling back to vector-only, which always works.
    logger.warn(`Could not read ${collection} capabilities, assuming vector-only: ${String(err).slice(0, 120)}`)
  }

  capabilityCache.set(collection, { sparse, checkedAt: Date.now() })
  return sparse
}

/** Forget what was probed — for tests, and for a re-index that must show at once. */
export function clearCapabilityCache(): void {
  capabilityCache.clear()
}

export interface HybridQuery {
  prefetch: Array<Record<string, unknown>>
  query: { fusion: 'rrf' }
  limit: number
  with_payload: true
}

/**
 * A Qdrant Query API body that runs both arms and merges them by reciprocal rank.
 *
 * The filter goes on each arm rather than on the fusion step: filtering after the
 * merge would let one arm spend its whole budget on candidates that are about to
 * be thrown away.
 *
 * Returns null when the question has no searchable terms in it — punctuation, or
 * a bare number — because a sparse arm with nothing in it contributes no ranking
 * and the vector arm alone is the honest answer.
 */
export function buildHybridQuery(opts: {
  vector: number[]
  query: string
  limit: number
  filter?: Record<string, unknown>
}): HybridQuery | null {
  const sparse = querySparseVector(opts.query)
  if (sparse.indices.length === 0) return null

  return {
    prefetch: [
      { query: opts.vector, limit: opts.limit, filter: opts.filter },
      { query: sparse, using: SPARSE_VECTOR_NAME, limit: opts.limit, filter: opts.filter },
    ],
    query: { fusion: 'rrf' },
    limit: opts.limit,
    with_payload: true,
  }
}
