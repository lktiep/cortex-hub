/**
 * Centralized embedder factory.
 *
 * All embedding requests are routed through the internal LLM gateway
 * (/api/llm/v1/embeddings), which reads model_routing from the database
 * and forwards to the configured provider (currently Ollama bge-m3:latest, 1024-dim).
 *
 * NOTE: Never switch embedding providers without re-embedding all documents.
 * Different providers generate vectors with different dimensions, which corrupts
 * Qdrant collection indexes and search results.
 */

import { Embedder } from '@cortex/shared-mem9'
import type { EmbedderConfig } from '@cortex/shared-mem9'

/**
 * Build an Embedder routing through LLM Gateway to respect database model routing.
 * The gateway resolves the active provider from model_routing at request time.
 */
export function createEmbedder(): Embedder {
  const config: EmbedderConfig = {
    provider: 'gemini' as const, // Dummy provider — actual routing is done by the gateway
    apiKey: '',
    model: 'auto',
  }
  const gatewayUrl = process.env['LLM_GATEWAY_URL'] ?? `http://localhost:${process.env['PORT'] || 4000}/api/llm`
  return new Embedder(config, [], {
    maxRetries: 2,
    retryDelayMs: 2000,
    gatewayUrl,
  })
}

/**
 * Returns the embedding vector dimension for the active provider.
 * Used to ensure Qdrant collections are created with the right size.
 * Current provider: Ollama bge-m3:latest → 1024 dimensions.
 */
export function getActiveEmbeddingDim(): number {
  return 1024
}

/**
 * Returns the active provider name (for logging/diagnostics).
 */
export function getActiveProvider(): string {
  return 'gateway'
}
