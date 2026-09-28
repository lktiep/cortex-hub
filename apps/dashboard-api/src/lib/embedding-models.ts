/**
 * Tells embedding models apart from chat models by their id.
 *
 * `includes('embed')` catches text-embedding-*, gemini-embedding-*,
 * nomic-embed-text and friends, but misses the open families whose names never
 * say "embed" (bge-m3, multilingual-e5, gte, all-MiniLM, voyage). A provider
 * serving only those got no embedding routing and its models were offered as
 * chat models. Rerankers share those family names and are neither.
 */
const EMBED_WORD = /embed/i
const EMBED_FAMILY = /(^|[/:_.-])(bge|e5|gte|all-minilm|minilm|paraphrase|sentence-t5|voyage)([/:_.-]|$)/i
const RERANKER = /rerank/i

export function isEmbeddingModel(modelId: string): boolean {
  if (RERANKER.test(modelId)) return false
  return EMBED_WORD.test(modelId) || EMBED_FAMILY.test(modelId)
}
