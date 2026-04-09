/**
 * Centralized embedder factory.
 *
 * Reads EMBEDDING_PROVIDER env var to switch between:
 * - 'gemini' (default) — Google Gemini embedding API, network-bound, $$, 768-dim
 * - 'local'             — @xenova/transformers in-process, free, ~10-50ms, 384-dim
 *
 * Optional env vars:
 *   MEM9_EMBEDDING_MODEL   — Gemini model (default: gemini-embedding-exp-03-07)
 *   LOCAL_EMBEDDING_MODEL  — HuggingFace model id (default: Xenova/all-MiniLM-L6-v2)
 *
 * NOTE: switching providers AFTER documents are embedded breaks similarity search
 * because vector dimensions and embedding spaces differ. To migrate, you must
 * re-embed all existing documents.
 */

import { Embedder } from '@cortex/shared-mem9'
import type { EmbedderConfig } from '@cortex/shared-mem9'
import { db } from '../db/client.js'

/** Resolve a Gemini API key from env var or DB-stored provider account */
function resolveGeminiApiKey(): string {
  const envKey = process.env['GEMINI_API_KEY']
  if (envKey) return envKey
  try {
    const row = db.prepare(
      "SELECT api_key FROM provider_accounts WHERE type = 'gemini' AND status = 'enabled' AND api_key IS NOT NULL LIMIT 1",
    ).get() as { api_key: string } | undefined
    if (row?.api_key) return row.api_key
  } catch { /* DB might not be ready */ }
  return ''
}

/**
 * Build an Embedder honoring EMBEDDING_PROVIDER env var.
 */
export function createEmbedder(): Embedder {
  const provider = (process.env['EMBEDDING_PROVIDER'] || 'gemini') as 'gemini' | 'local'
  const config: EmbedderConfig = provider === 'local'
    ? {
        provider: 'local' as const,
        apiKey: '',
        model: process.env['LOCAL_EMBEDDING_MODEL'] || 'Xenova/all-MiniLM-L6-v2',
      }
    : {
        provider: 'gemini' as const,
        apiKey: resolveGeminiApiKey(),
        model: process.env['MEM9_EMBEDDING_MODEL'] || 'gemini-embedding-exp-03-07',
      }
  return new Embedder(config)
}

/**
 * Returns the embedding vector dimension for the active provider.
 * Used to ensure Qdrant collections are created with the right size.
 */
export function getActiveEmbeddingDim(): number {
  const provider = (process.env['EMBEDDING_PROVIDER'] || 'gemini') as 'gemini' | 'local'
  if (provider === 'local') {
    const model = process.env['LOCAL_EMBEDDING_MODEL'] || 'Xenova/all-MiniLM-L6-v2'
    const dimMap: Record<string, number> = {
      'Xenova/all-MiniLM-L6-v2': 384,
      'Xenova/all-MiniLM-L12-v2': 384,
      'Xenova/bge-small-en-v1.5': 384,
      'Xenova/bge-base-en-v1.5': 768,
      'Xenova/multilingual-e5-small': 384,
    }
    return dimMap[model] ?? 384
  }
  return 768 // gemini default
}

/**
 * Returns the active provider name (for logging/diagnostics).
 */
export function getActiveProvider(): 'gemini' | 'local' {
  return (process.env['EMBEDDING_PROVIDER'] || 'gemini') as 'gemini' | 'local'
}
