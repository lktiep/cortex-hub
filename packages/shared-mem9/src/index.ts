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
