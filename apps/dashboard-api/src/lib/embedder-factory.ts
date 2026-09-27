/**
 * Centralized embedder factory.
 *
 * All embedding requests are routed through the internal LLM gateway
 * (/api/llm/v1/embeddings), which reads model_routing from the database
 * and forwards to the configured provider. The bundled default is the ollama
 * container serving all-minilm (384-dim, ~15ms/text on CPU); bge-m3 (1024-dim,
 * ~87ms) is also pulled for text where multilingual recall matters more.
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
 * Probes the active route for its vector dimension.
 *
 * The dimension follows whatever model_routing points at, so it cannot be a
 * constant — this used to return a hardcoded 1024 that silently went wrong the
 * moment the routed model changed. Callers that create a Qdrant collection must
 * use this rather than assume a size.
 */
export async function getActiveEmbeddingDim(): Promise<number> {
  const vector = await createEmbedder().embed('dimension probe')
  return vector.length
}

/**
 * Returns the active provider name (for logging/diagnostics).
 */
export function getActiveProvider(): string {
  return 'gateway'
}
