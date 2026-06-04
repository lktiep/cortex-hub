import { Hono } from 'hono'
import { db } from '../db/client.js'
import {
  analyzeComplexity,
  reorderChainByTier,
  type TaskInput,
} from '@cortex/shared-types'
import { Embedder } from '@cortex/shared-mem9'

export const llmRouter = new Hono()

// ── CLIProxy Helpers ──
const CLIPROXY_URL = () =>
  process.env.LLM_PROXY_URL || process.env.CLIPROXY_URL || 'http://localhost:8317'
const MANAGEMENT_KEY = () =>
  process.env.CLIPROXY_MANAGEMENT_KEY || process.env.MANAGEMENT_PASSWORD || ''

function managementHeaders() {
  return {
    Authorization: `Bearer ${MANAGEMENT_KEY()}`,
    'Content-Type': 'application/json',
  }
}

// ═══════════════════════════════════════════════════
// Gateway Internals — Multi-Provider Proxy
// ═══════════════════════════════════════════════════

interface ProviderSlot {
  accountId: string
  model: string
  apiBase: string
  apiKey: string
  type: string
}

const RETRYABLE_CODES = new Set([429, 502, 503, 504])
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Resolve model_routing chain → provider slots */
function resolveChain(purpose: 'embedding' | 'chat'): ProviderSlot[] {
  const row = db
    .prepare("SELECT chain FROM model_routing WHERE purpose = ?")
    .get(purpose) as { chain: string } | undefined

  if (!row?.chain) return []

  const chain = JSON.parse(row.chain) as Array<{ accountId: string; model: string }>
  const slots: ProviderSlot[] = []

  for (const slot of chain) {
    if (slot.accountId === 'local') {
      slots.push({
        accountId: 'local',
        model: slot.model || 'Xenova/all-MiniLM-L6-v2',
        apiBase: '',
        apiKey: '',
        type: 'local',
      })
    } else {
      const acct = db
        .prepare("SELECT id, api_base, api_key, type FROM provider_accounts WHERE id = ? AND status = 'enabled'")
        .get(slot.accountId) as { id: string; api_base: string; api_key: string | null; type: string } | undefined

      if (acct) {
        slots.push({
          accountId: acct.id,
          model: slot.model,
          apiBase: acct.api_base,
          apiKey: acct.api_key ?? '',
          type: acct.type ?? 'openai',
        })
      }
    }
  }
  return slots
}

/** Check daily/monthly budget — returns error message if over limit */
function checkBudget(): string | null {
  try {
    const budget = db
      .prepare('SELECT daily_limit, monthly_limit FROM budget_settings WHERE id = 1')
      .get() as { daily_limit: number; monthly_limit: number } | undefined

    if (!budget) return null

    const today = new Date().toISOString().slice(0, 10)
    const monthStart = today.slice(0, 7) + '-01'

    if (budget.daily_limit > 0) {
      const dailyUsed = (
        db.prepare("SELECT COALESCE(SUM(total_tokens), 0) as t FROM usage_logs WHERE created_at >= ?")
          .get(`${today}T00:00:00`) as { t: number }
      ).t
      if (dailyUsed >= budget.daily_limit) {
        return `Daily token budget exceeded (${dailyUsed}/${budget.daily_limit})`
      }
    }

    if (budget.monthly_limit > 0) {
      const monthlyUsed = (
        db.prepare("SELECT COALESCE(SUM(total_tokens), 0) as t FROM usage_logs WHERE created_at >= ?")
          .get(`${monthStart}T00:00:00`) as { t: number }
      ).t
      if (monthlyUsed >= budget.monthly_limit) {
        return `Monthly token budget exceeded (${monthlyUsed}/${budget.monthly_limit})`
      }
    }
  } catch {
    // Budget table might not exist yet — allow request
  }
  return null
}

/** Log usage into usage_logs */
function logUsage(opts: {
  agentId: string
  model: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  projectId?: string
  requestType: string
}) {
  try {
    db.prepare(
      `INSERT INTO usage_logs (agent_id, model, prompt_tokens, completion_tokens, total_tokens, project_id, request_type)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      opts.agentId,
      opts.model,
      opts.promptTokens,
      opts.completionTokens,
      opts.totalTokens,
      opts.projectId ?? null,
      opts.requestType
    )
  } catch {
    // Non-fatal — don't block on logging failures
  }
}

// ── Provider-specific API calls ──

function isGeminiProvider(slot: ProviderSlot): boolean {
  return slot.type === 'gemini' || slot.apiBase.includes('generativelanguage.googleapis.com')
}

async function embedViaGemini(
  text: string, apiKey: string, model: string, baseUrl: string
): Promise<{ vector: number[]; tokens: number }> {
  const base = baseUrl.includes('generativelanguage.googleapis.com')
    ? baseUrl.replace(/\/$/, '')
    : 'https://generativelanguage.googleapis.com/v1beta'
  const url = `${base}/models/${model}:embedContent?key=${apiKey}`

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: { parts: [{ text }] } }),
    signal: AbortSignal.timeout(30000),
  })

  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw Object.assign(new Error(`Gemini embed ${res.status}: ${err.slice(0, 200)}`), { status: res.status })
  }

  const data = (await res.json()) as { embedding: { values: number[] } }
  return { vector: data.embedding.values, tokens: Math.ceil(text.length / 4) }
}

async function embedViaOpenAI(
  text: string, apiKey: string, model: string, baseUrl: string
): Promise<{ vector: number[]; tokens: number }> {
  const url = `${baseUrl.replace(/\/$/, '')}/embeddings`

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, input: text }),
    signal: AbortSignal.timeout(30000),
  })

  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw Object.assign(new Error(`OpenAI embed ${res.status}: ${err.slice(0, 200)}`), { status: res.status })
  }

  const data = (await res.json()) as {
    data: Array<{ embedding: number[] }>
    usage?: { prompt_tokens?: number; total_tokens?: number }
  }
  const first = data.data[0]
  if (!first) throw new Error('Empty embedding response')
  return {
    vector: first.embedding,
    tokens: data.usage?.total_tokens ?? Math.ceil(text.length / 4),
  }
}

async function chatViaGemini(
  messages: Array<{ role: string; content: string }>,
  apiKey: string, model: string, baseUrl: string,
  maxTokens?: number,
  responseFormat?: { type: string }
): Promise<{ content: string; promptTokens: number; completionTokens: number }> {
  const base = baseUrl.includes('generativelanguage.googleapis.com')
    ? baseUrl.replace(/\/$/, '').replace(/\/v1$/, '/v1beta')
    : 'https://generativelanguage.googleapis.com/v1beta'
  const url = `${base}/models/${model}:generateContent?key=${apiKey}`

  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }))

  const systemInstruction = messages.find((m) => m.role === 'system')
  const generationConfig: Record<string, unknown> = {}
  if (maxTokens) {
    generationConfig.maxOutputTokens = maxTokens
  }
  if (responseFormat?.type === 'json_object') {
    generationConfig.responseMimeType = 'application/json'
  }

  const body: Record<string, unknown> = { contents }
  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: systemInstruction.content }] }
  }
  if (Object.keys(generationConfig).length > 0) {
    body.generationConfig = generationConfig
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  })

  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw Object.assign(new Error(`Gemini chat ${res.status}: ${err.slice(0, 200)}`), { status: res.status })
  }

  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
  }

  return {
    content: data.candidates?.[0]?.content?.parts?.[0]?.text ?? '',
    promptTokens: data.usageMetadata?.promptTokenCount ?? 0,
    completionTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
  }
}

async function chatViaOpenAI(
  messages: Array<{ role: string; content: string }>,
  apiKey: string, model: string, baseUrl: string,
  maxTokens?: number
): Promise<{ content: string; promptTokens: number; completionTokens: number }> {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

  const body: Record<string, unknown> = { model, messages }
  if (maxTokens) body.max_tokens = maxTokens

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  })

  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw Object.assign(new Error(`OpenAI chat ${res.status}: ${err.slice(0, 200)}`), { status: res.status })
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }

  return {
    content: data.choices?.[0]?.message?.content ?? '',
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
  }
}

// ═══════════════════════════════════════════════════
// Gateway Proxy Endpoints
// ═══════════════════════════════════════════════════

// ── POST /v1/embeddings — OpenAI-compatible embedding proxy ──
llmRouter.post('/v1/embeddings', async (c) => {
  const budgetError = checkBudget()
  if (budgetError) return c.json({ error: budgetError }, 429)

  const body = await c.req.json() as {
    input: string | string[]
    model?: string
    agent_id?: string
    project_id?: string
  }

  const input = Array.isArray(body.input) ? body.input[0] : body.input
  if (!input) return c.json({ error: 'Missing input' }, 400)

  const agentId = body.agent_id ?? 'internal'
  const projectId = body.project_id

  const chain = resolveChain('embedding')
  if (chain.length === 0) {
    return c.json({ error: 'No embedding providers configured. Add a provider in Settings.' }, 503)
  }

  const requestedModel = body.model && body.model !== 'auto' ? body.model : null
  const orderedChain = requestedModel
    ? [...chain.filter((s) => s.model === requestedModel), ...chain.filter((s) => s.model !== requestedModel)]
    : chain

  const errors: string[] = []

  for (const slot of orderedChain) {
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        let result: { vector: number[]; tokens: number }
        if (slot.type === 'local') {
          const embedder = new Embedder({
            provider: 'local',
            apiKey: '',
            model: slot.model,
          })
          const vector = await embedder.embed(input)
          result = {
            vector,
            tokens: Math.ceil(input.length / 4),
          }
        } else {
          result = isGeminiProvider(slot)
            ? await embedViaGemini(input, slot.apiKey, slot.model, slot.apiBase)
            : await embedViaOpenAI(input, slot.apiKey, slot.model, slot.apiBase)
        }

        logUsage({
          agentId,
          model: slot.model,
          promptTokens: result.tokens,
          completionTokens: 0,
          totalTokens: result.tokens,
          projectId,
          requestType: 'embedding',
        })

        return c.json({
          object: 'list',
          data: [{ object: 'embedding', embedding: result.vector, index: 0 }],
          model: slot.model,
          usage: { prompt_tokens: result.tokens, total_tokens: result.tokens },
        })
      } catch (err) {
        const status = (err as { status?: number }).status ?? 0
        if (RETRYABLE_CODES.has(status) && attempt < 2) {
          await sleep(1000 * Math.pow(2, attempt))
          continue
        }
        errors.push(`${slot.model}@${slot.accountId}: ${String(err).slice(0, 100)}`)
        break
      }
    }
  }

  return c.json({ error: 'All embedding providers failed', details: errors }, 502)
})

// ── POST /v1/chat/completions — OpenAI-compatible chat proxy ──
llmRouter.post('/v1/chat/completions', async (c) => {
  const budgetError = checkBudget()
  if (budgetError) return c.json({ error: budgetError }, 429)

  const body = await c.req.json() as {
    messages: Array<{ role: string; content: string }>
    model?: string
    max_tokens?: number
    agent_id?: string
    project_id?: string
    response_format?: { type: string }
    /** Complexity hints for auto-routing */
    complexity?: Partial<TaskInput>
  }

  if (!body.messages?.length) return c.json({ error: 'Missing messages' }, 400)

  const agentId = body.agent_id ?? 'internal'
  const projectId = body.project_id

  const chain = resolveChain('chat')
  if (chain.length === 0) {
    return c.json({ error: 'No chat providers configured. Add a provider in Settings.' }, 503)
  }

  // ── Complexity-Based Routing ──
  // When model is 'auto' or unset, analyze task complexity to pick optimal tier
  const requestedModel = body.model && body.model !== 'auto' ? body.model : null
  let orderedChain: ProviderSlot[]
  let complexityInfo: { tier: string; score: number; reasoning: string } | null = null

  if (requestedModel) {
    // Explicit model requested → prioritize it
    orderedChain = [
      ...chain.filter((s) => s.model === requestedModel),
      ...chain.filter((s) => s.model !== requestedModel),
    ]
  } else {
    // Auto-routing: analyze complexity from last user message + hints
    const lastUserMsg = [...body.messages].reverse().find(m => m.role === 'user')
    const prompt = lastUserMsg?.content ?? ''

    const analysis = analyzeComplexity({
      prompt,
      ...body.complexity,
    })

    orderedChain = reorderChainByTier(chain, analysis.tier)
    complexityInfo = { tier: analysis.tier, score: analysis.score, reasoning: analysis.reasoning }
  }

  const errors: string[] = []

  for (const slot of orderedChain) {
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        const result = isGeminiProvider(slot)
          ? await chatViaGemini(body.messages, slot.apiKey, slot.model, slot.apiBase, body.max_tokens, body.response_format)
          : await chatViaOpenAI(body.messages, slot.apiKey, slot.model, slot.apiBase, body.max_tokens)

        const totalTokens = result.promptTokens + result.completionTokens

        logUsage({
          agentId,
          model: slot.model,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          totalTokens,
          projectId,
          requestType: 'chat',
        })

        return c.json({
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          model: slot.model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: result.content },
            finish_reason: 'stop',
          }],
          usage: {
            prompt_tokens: result.promptTokens,
            completion_tokens: result.completionTokens,
            total_tokens: totalTokens,
          },
          // Complexity routing metadata (when auto-routed)
          ...(complexityInfo ? { routing: complexityInfo } : {}),
        })
      } catch (err) {
        const status = (err as { status?: number }).status ?? 0
        if (RETRYABLE_CODES.has(status) && attempt < 2) {
          await sleep(1000 * Math.pow(2, attempt))
          continue
        }
        errors.push(`${slot.model}@${slot.accountId}: ${String(err).slice(0, 100)}`)
        break
      }
    }
  }

  return c.json({ error: 'All chat providers failed', details: errors }, 502)
})

// ═══════════════════════════════════════════════════
// Complexity Analysis & Plan Quality Endpoints
// ═══════════════════════════════════════════════════

/** POST /analyze-complexity — Analyze task complexity without making an LLM call */
llmRouter.post('/analyze-complexity', async (c) => {
  const body = await c.req.json() as TaskInput
  if (!body.prompt) return c.json({ error: 'prompt is required' }, 400)

  const analysis = analyzeComplexity(body)
  return c.json({ analysis })
})

// ═══════════════════════════════════════════════════
// Legacy CLIProxy Routes
// ═══════════════════════════════════════════════════

const PROVIDER_DEFS = [
  {
    id: 'openai',
    name: 'OpenAI',
    icon: '🤖',
    description: 'GPT-4o, o3, Codex (via subscription)',
    authType: 'oauth' as const,
    oauthEndpoint: 'codex-auth-url',
    statusEndpoint: 'codex-auth-status',
    usedBy: ['mem9', 'mcp-tools'],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    icon: '✨',
    description: 'Gemini 2.5 Pro, Flash',
    authType: 'oauth' as const,
    oauthEndpoint: 'gemini-cli-auth-url',
    statusEndpoint: 'gemini-cli-auth-status',
    usedBy: [],
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    icon: '🧩',
    description: 'Claude 4, Sonnet',
    authType: 'oauth' as const,
    oauthEndpoint: 'anthropic-auth-url',
    statusEndpoint: 'anthropic-auth-status',
    usedBy: [],
  },
]

llmRouter.get('/providers', async (c) => {
  const providers = await Promise.all(
    PROVIDER_DEFS.map(async (def) => {
      let status: 'connected' | 'disconnected' | 'error' = 'disconnected'
      let models: { id: string; owned_by: string }[] = []

      try {
        const statusUrl = `${CLIPROXY_URL()}/v0/management/get-auth-status`
        const statusRes = await fetch(statusUrl, {
          headers: managementHeaders(),
          signal: AbortSignal.timeout(3000),
        })
        if (statusRes.ok) {
          const statusData = (await statusRes.json()) as { status: string }
          if (statusData.status === 'ok') {
            status = 'connected'
          }
        }
      } catch {
        status = 'error'
      }

      if (status === 'connected') {
        try {
          const modelsRes = await fetch(`${CLIPROXY_URL()}/v1/models`, {
            signal: AbortSignal.timeout(3000),
          })
          if (modelsRes.ok) {
            const modelsData = (await modelsRes.json()) as {
              data: { id: string; owned_by: string }[]
            }
            models = modelsData.data
              .filter((m) => m.owned_by === def.id || def.id === 'openai')
              .map((m) => ({ id: m.id, owned_by: m.owned_by }))
          }
        } catch {
          // Models fetch failed but auth is still valid
        }
      }

      return { ...def, status, models, modelCount: models.length }
    })
  )
  return c.json({ providers })
})

llmRouter.get('/models', async (c) => {
  try {
    const res = await fetch(`${CLIPROXY_URL()}/v1/models`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) throw new Error(`CLIProxy returned ${res.status}`)
    const data = await res.json()
    return c.json(data)
  } catch (err) {
    return c.json({ error: 'Failed to fetch models', details: String(err) }, 502)
  }
})

llmRouter.get('/v1/models', async (c) => {
  try {
    const res = await fetch(`${CLIPROXY_URL()}/v1/models`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) throw new Error(`CLIProxy returned ${res.status}`)
    const data = await res.json()
    return c.json(data)
  } catch (err) {
    return c.json({ error: 'Failed to fetch models', details: String(err) }, 502)
  }
})

llmRouter.post('/providers/:id/test', async (c) => {
  const providerId = c.req.param('id')

  let model = ''
  try {
    const modelsRes = await fetch(`${CLIPROXY_URL()}/v1/models`, {
      signal: AbortSignal.timeout(5000),
    })
    if (modelsRes.ok) {
      const modelsData = (await modelsRes.json()) as { data: { id: string }[] }
      const preferred = modelsData.data.find((m) =>
        m.id.includes('mini') || m.id.includes('flash')
      )
      model = preferred?.id ?? modelsData.data[0]?.id ?? ''
    }
  } catch {
    // fallback to static defaults
  }

  if (!model) {
    try {
      const row = db
        .prepare("SELECT models FROM provider_accounts WHERE type = ? AND status = 'enabled' LIMIT 1")
        .get(providerId) as { models: string } | undefined
      if (row?.models) {
        const modelsList = JSON.parse(row.models) as string[]
        if (modelsList.length > 0) {
          model = modelsList[0]!
        }
      }
    } catch {
      // Ignore DB error
    }
  }

  if (!model) {
    return c.json({ success: false, error: `No active models configured for provider "${providerId}". Please configure models under Providers Settings first.` }, 400)
  }
  const startTime = Date.now()

  try {
    const res = await fetch(`${CLIPROXY_URL()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with "OK" only.' }],
        max_tokens: 5,
      }),
      signal: AbortSignal.timeout(15000),
    })

    const latency = Date.now() - startTime

    if (!res.ok) {
      const text = await res.text()
      return c.json({ success: false, provider: providerId, model, latency, error: `LLM returned ${res.status}: ${text.substring(0, 200)}` })
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }

    return c.json({
      success: true,
      provider: providerId,
      model,
      latency,
      reply: (data.choices?.[0]?.message?.content ?? '').substring(0, 100),
      usage: data.usage ?? null,
    })
  } catch (err) {
    return c.json({ success: false, provider: providerId, model, latency: Date.now() - startTime, error: String(err) }, 502)
  }
})

llmRouter.post('/providers/:id/disconnect', async (c) => {
  const providerId = c.req.param('id')
  return c.json({
    success: true,
    message: `Provider ${providerId} disconnected. Re-authenticate to reconnect.`,
  })
})
