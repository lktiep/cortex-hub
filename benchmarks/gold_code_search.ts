/**
 * Ground truth for cortex-hub's own code index: a question, and the file that
 * actually answers it.
 *
 * Hand-written rather than generated. A gold set built by taking each chunk's
 * leading comment as the query is easy to produce at any size, but it rewards
 * whichever retriever matches wording most literally — on 120 such queries the
 * BM25 arm scored recall@1 0.775 against the vector arm's 0.533, a gap that says
 * more about how the questions were made than about the retrievers. These are
 * phrased the way an agent asks, with the vocabulary an agent would guess.
 *
 * A query counts as a hit at K when any chunk of its expected file appears in the
 * top K. Queries whose expected file is not in the index are dropped and reported
 * by each benchmark, so a coverage gap cannot quietly inflate a score.
 *
 * Shared by rerank_bench.ts and retrieval_bench.ts so both measure the same thing.
 */
export const CODE_SEARCH_GOLD: Array<[query: string, file: string]> = [
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
  // There is no routes/sessions.ts; session_start writes session_handoffs from
  // routes/quality.ts. The old label pointed at a file that has never existed,
  // so this query was being dropped from every run instead of scored.
  ['start a session and return the project id', 'apps/dashboard-api/src/routes/quality.ts'],
  // The implementation, not the route that exposes it: routes/quality.ts only
  // holds POST /plan-quality. Labelling it there cost a measured 0.067 of
  // recall@1 until the mistake was found.
  ['score how good a plan is', 'packages/shared-types/src/plan-quality.ts'],
  ['which repo name does gitnexus get asked about', 'apps/dashboard-api/src/routes/intel.ts'],
  ['batch several texts into one embedding request', 'packages/shared-mem9/src/embedder.ts'],
]
