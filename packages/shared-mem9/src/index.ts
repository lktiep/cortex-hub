/**
 * @cortex/shared-mem9 — Cortex Memory Engine
 *
 * In-process TypeScript replacement for mem0.
 * - LLM: CLIProxy (Codex OAuth)
 * - Embeddings: Gemini API (GCP key)
 * - Vector Store: Qdrant REST
 */

export { Mem9 } from './memory.js'
export { Embedder } from './embedder.js'
export { VectorStore } from './vector-store.js'
export { LlmClient } from './llm.js'
export { HistoryStore } from './history.js'
export type { SqliteDb } from './history.js'

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
