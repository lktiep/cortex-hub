/**
 * @cortex/shared-mem9 — Cortex Memory Engine
 *
 * In-process TypeScript memory engine.
 * - LLM: CLIProxy (Codex OAuth)
 * - Embeddings: Gemini API (GCP key)
 * - Vector Store: Qdrant REST
 */

export { Mem9 } from './memory.js'
export { Embedder } from './embedder.js'
export { VectorStore } from './vector-store.js'
export { LlmClient } from './llm.js'
export { HistoryStore } from './history.js'
export { TypeSafeClient, rerankByRelevance, noul, choice, score } from './typesafe.js'
export {
  tokenizeCode,
  tokenizeText,
  hashToken,
  documentSparseVector,
  querySparseVector,
  averageTokenLength,
  BM25_K1,
  BM25_B,
  SPARSE_VECTOR_NAME,
} from './sparse.js'
export type { SparseVector, Tokenizer } from './sparse.js'
export { fuseByRank, RRF_K } from './fusion.js'
export { describeCollection, copyToHybridCollection, switchToHybridCollection } from './migrate.js'
export type { CollectionShape, HybridCopyOptions, HybridCopyReport, HybridSwitchReport } from './migrate.js'
export type { SqliteDb } from './history.js'
export type {
  TypeSafeConfig,
  Question,
  NoulQuestion,
  ChoiceQuestion,
  ScoreQuestion,
  Answer,
  NoulAnswer,
  ChoiceAnswer,
  ScoreAnswer,
  SystemOneResult,
  RerankOptions,
  Reranked,
} from './typesafe.js'

export type {
  Mem9Config,
  LlmConfig,
  EmbedderConfig,
  VectorStoreConfig,
  MemoryItem,
  AddRequest,
  AddResult,
  SearchRequest,
  SearchResult,
  GetAllRequest,
  MemoryEvent,
  MemoryEventType,
  HistoryEntry,
  QdrantPoint,
  QdrantSearchResult,
  ModelSlot,
  FallbackConfig,
} from './types.js'
