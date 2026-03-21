/**
 * CLIProxy LLM client — with fallback chain support
 *
 * Calls OpenAI-compatible /v1/chat/completions for fact extraction
 * and memory deduplication. Supports retry + fallback across
 * multiple provider slots.
 */

import type { LlmConfig, ModelSlot } from './types.js'

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface ChatCompletionResponse {
  choices: Array<{
    message: { content: string }
    finish_reason: string
  }>
  usage?: {
    total_tokens: number
    prompt_tokens: number
    completion_tokens: number
  }
}

/** HTTP status codes that trigger retry/fallback */
const RETRYABLE_CODES = new Set([429, 502, 503, 504])

/** Sleep for ms */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class LlmClient {
  private readonly slots: ModelSlot[]
  private readonly maxRetries: number
  private readonly baseDelay: number

  /**
   * Create an LLM client.
   * @param config - Legacy single config OR fallback chain
   * @param chain - Optional ModelSlot[] fallback chain (takes priority)
   */
  constructor(
    config: LlmConfig,
    chain?: ModelSlot[],
    opts?: { maxRetries?: number; retryDelayMs?: number }
  ) {
    if (chain && chain.length > 0) {
      this.slots = chain
    } else {
      // Legacy: single slot from config
      this.slots = [{
        accountId: 'legacy',
        baseUrl: config.baseUrl,
        model: config.model,
      }]
    }
    this.maxRetries = opts?.maxRetries ?? 2
    this.baseDelay = opts?.retryDelayMs ?? 1000
  }

  /**
   * Send a chat completion request with retry + fallback.
   * Tries each slot in order; within each slot, retries up to maxRetries
   * on transient errors (429, 503, etc.) with exponential backoff.
   */
  async chatJson<T>(
    messages: ChatMessage[],
  ): Promise<{ result: T; tokensUsed: number; slotUsed?: string }> {
    const errors: string[] = []

    for (const slot of this.slots) {
      const baseUrl = slot.baseUrl.replace(/\/$/, '')
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (slot.apiKey) headers['Authorization'] = `Bearer ${slot.apiKey}`

      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        try {
          const res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model: slot.model,
              messages,
              response_format: { type: 'json_object' },
              temperature: 0,
            }),
          })

          // Retryable error → backoff and retry
          if (RETRYABLE_CODES.has(res.status)) {
            const delay = this.baseDelay * Math.pow(2, attempt)
            console.warn(
              `[llm] ${slot.model}@${slot.accountId} returned ${res.status}, ` +
              `retry ${attempt + 1}/${this.maxRetries} in ${delay}ms`
            )
            if (attempt < this.maxRetries) {
              await sleep(delay)
              continue
            }
            // Exhausted retries for this slot → try next
            errors.push(`${slot.model}: ${res.status} after ${this.maxRetries} retries`)
            break
          }

          // Non-retryable error → try next slot
          if (!res.ok) {
            const err = await res.text()
            errors.push(`${slot.model}: ${res.status} ${err.slice(0, 100)}`)
            break
          }

          // Success
          const data = (await res.json()) as ChatCompletionResponse
          const content = data.choices[0]?.message?.content
          if (!content) {
            errors.push(`${slot.model}: empty response`)
            break
          }

          const jsonStr = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
          try {
            const result = JSON.parse(jsonStr) as T
            return {
              result,
              tokensUsed: data.usage?.total_tokens ?? 0,
              slotUsed: slot.accountId,
            }
          } catch {
            errors.push(`${slot.model}: JSON parse error`)
            break
          }
        } catch (err) {
          // Network error → retry
          if (attempt < this.maxRetries) {
            await sleep(this.baseDelay * Math.pow(2, attempt))
            continue
          }
          errors.push(`${slot.model}: ${String(err)}`)
          break
        }
      }
    }

    throw new Error(`All LLM slots exhausted: ${errors.join(' | ')}`)
  }

  /** Check if the first slot is reachable */
  async isHealthy(): Promise<boolean> {
    const slot = this.slots[0]
    if (!slot) return false
    try {
      const headers: Record<string, string> = {}
      if (slot.apiKey) headers['Authorization'] = `Bearer ${slot.apiKey}`
      const res = await fetch(`${slot.baseUrl.replace(/\/$/, '')}/models`, {
        headers,
        signal: AbortSignal.timeout(3000),
      })
      return res.ok
    } catch {
      return false
    }
  }

  /** Get info about configured slots for debugging */
  getSlotInfo(): Array<{ accountId: string; model: string }> {
    return this.slots.map((s) => ({ accountId: s.accountId, model: s.model }))
  }
}
