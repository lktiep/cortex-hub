/**
 * Embedding client — with fallback chain support
 *
 * Routes to Gemini or OpenAI-compatible providers.
 * Supports retry + fallback across multiple provider slots.
 */

import type { EmbedderConfig, ModelSlot } from './types.js'
import { embedLocal, embedLocalBatch } from './local-embedder.js'

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta'

/** HTTP status codes that trigger retry */
const RETRYABLE_CODES = new Set([429, 502, 503, 504])

/** Sleep for ms */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class Embedder {
  private readonly config: EmbedderConfig
  private readonly chain: ModelSlot[]
  private readonly maxRetries: number
  private readonly baseDelay: number
  private readonly gatewayUrl?: string

  constructor(
    config: EmbedderConfig,
    chain?: ModelSlot[],
    opts?: { maxRetries?: number; retryDelayMs?: number; gatewayUrl?: string }
  ) {
    this.config = config
    this.chain = chain ?? []
    this.maxRetries = opts?.maxRetries ?? 2
    this.baseDelay = opts?.retryDelayMs ?? 1000
    this.gatewayUrl = opts?.gatewayUrl
  }

  /** Embed a single text string → float vector */
  async embed(text: string): Promise<number[]> {
    // Local provider — runs in-process via @xenova/transformers, no network
    if (this.config.provider === 'local') {
      return embedLocal(text, this.config.model)
    }
    // Route through gateway if configured
    if (this.gatewayUrl) {
      return this.embedViaGateway(text)
    }
    // If chain is configured, use fallback logic
    if (this.chain.length > 0) {
      return this.embedWithFallback(text)
    }
    // Legacy: use config directly
    if (this.config.provider === 'gemini') {
      return this.embedGemini(text, this.config.apiKey, this.config.model)
    }
    return this.embedOpenAI(text, this.config.apiKey, this.config.model)
  }

  /** Embed via centralized LLM gateway — it handles routing, fallback, budget, logging */
  private async embedViaGateway(text: string): Promise<number[]> {
    const url = `${this.gatewayUrl!.replace(/\/$/, '')}/v1/embeddings`

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text, model: 'auto' }),
      signal: AbortSignal.timeout(30000),
    })

    if (!res.ok) {
      const err = await res.text().catch(() => '')
      throw new Error(`Gateway embedding failed (${res.status}): ${err.slice(0, 200)}`)
    }

    const data = (await res.json()) as {
      data: Array<{ embedding: number[] }>
    }
    const first = data.data[0]
    if (!first) throw new Error('Gateway returned empty embedding data')
    return first.embedding
  }

  /** Embed multiple texts in batch */
  async embedBatch(texts: string[]): Promise<number[][]> {
    // Local provider supports true batching for major speedup
    if (this.config.provider === 'local') {
      return embedLocalBatch(texts, this.config.model)
    }
    return Promise.all(texts.map((t) => this.embed(t)))
  }

  /* ── Fallback chain logic ────────────────────────────── */

  private async embedWithFallback(text: string): Promise<number[]> {
    const errors: string[] = []

    for (const slot of this.chain) {
      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        try {
          const isGemini = slot.baseUrl.includes('generativelanguage.googleapis.com')
          const result = isGemini
            ? await this.embedGemini(text, slot.apiKey ?? '', slot.model)
            : await this.embedOpenAI(text, slot.apiKey ?? '', slot.model, slot.baseUrl)

          return result
        } catch (err) {
          const msg = String(err)
          // Check if retryable
          const isRetryable = RETRYABLE_CODES.has(this.extractStatusCode(msg))
            || msg.includes('fetch failed')
            || msg.includes('ECONNREFUSED')

          if (isRetryable && attempt < this.maxRetries) {
            const delay = this.baseDelay * Math.pow(2, attempt)
            console.warn(
              `[embedder] ${slot.model}@${slot.accountId} failed, ` +
              `retry ${attempt + 1}/${this.maxRetries} in ${delay}ms`
            )
            await sleep(delay)
            continue
          }
          errors.push(`${slot.model}: ${msg.slice(0, 100)}`)
          break
        }
      }
    }

    // If chain exhausted, fall back to legacy config
    try {
      if (this.config.provider === 'gemini') {
        return await this.embedGemini(text, this.config.apiKey, this.config.model)
      }
      return await this.embedOpenAI(text, this.config.apiKey, this.config.model)
    } catch (err) {
      errors.push(`legacy-${this.config.provider}: ${String(err).slice(0, 100)}`)
    }

    throw new Error(`All embedding slots exhausted: ${errors.join(' | ')}`)
  }

  /** Extract HTTP status from error message */
  private extractStatusCode(msg: string): number {
    const match = msg.match(/\((\d{3})\)/)
    return match ? Number(match[1]) : 0
  }

  /* ── Gemini native API ───────────────────────────────── */

  private async embedGemini(text: string, apiKey: string, model: string): Promise<number[]> {
    const url = `${GEMINI_BASE}/models/${model}:embedContent?key=${apiKey}`

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: { parts: [{ text }] },
      }),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Gemini embedding failed (${res.status}): ${err}`)
    }

    const data = (await res.json()) as { embedding: { values: number[] } }
    return data.embedding.values
  }

  /* ── OpenAI-compatible API ───────────────────────────── */

  private async embedOpenAI(
    text: string,
    apiKey: string,
    model: string,
    baseUrl?: string,
  ): Promise<number[]> {
    const url = baseUrl
      ? `${baseUrl.replace(/\/$/, '')}/embeddings`
      : 'https://api.openai.com/v1/embeddings'

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, input: text }),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`OpenAI embedding failed (${res.status}): ${err}`)
    }

    const data = (await res.json()) as {
      data: Array<{ embedding: number[] }>
    }
    const first = data.data[0]
    if (!first) {
      throw new Error('OpenAI embedding returned empty data array')
    }
    return first.embedding
  }
}
