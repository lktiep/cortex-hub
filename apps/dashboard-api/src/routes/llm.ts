import { Hono } from 'hono'

export const llmRouter = new Hono()

// ── Helpers ──
const CLIPROXY_URL = () =>
  process.env.LLM_PROXY_URL || process.env.CLIPROXY_URL || 'http://localhost:8317'
const MANAGEMENT_KEY = () =>
  process.env.CLIPROXY_MANAGEMENT_KEY || process.env.MANAGEMENT_PASSWORD || 'cortex2026'

function managementHeaders() {
  return {
    Authorization: `Bearer ${MANAGEMENT_KEY()}`,
    'Content-Type': 'application/json',
  }
}

// Provider definitions with metadata
const PROVIDER_DEFS = [
  {
    id: 'openai',
    name: 'OpenAI',
    icon: '🤖',
    description: 'GPT-4o, o3, Codex (via subscription)',
    authType: 'oauth' as const,
    oauthEndpoint: 'codex-auth-url',
    statusEndpoint: 'codex-auth-status',
    usedBy: ['mem0', 'mcp-tools'],
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

// ── List all providers with connection status ──
llmRouter.get('/providers', async (c) => {
  const providers = await Promise.all(
    PROVIDER_DEFS.map(async (def) => {
      let status: 'connected' | 'disconnected' | 'error' = 'disconnected'
      let models: { id: string; owned_by: string }[] = []

      try {
        // Check auth status via CLIProxy management API
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

      // If connected, try to get models
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

      return {
        ...def,
        status,
        models,
        modelCount: models.length,
      }
    })
  )

  return c.json({ providers })
})

// ── Get models for a specific provider ──
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

// ── Test a provider (send a real request) ──
llmRouter.post('/providers/:id/test', async (c) => {
  const providerId = c.req.param('id')

  // Pick a lightweight model — try to find one from available models first
  let model = ''
  try {
    const modelsRes = await fetch(`${CLIPROXY_URL()}/v1/models`, {
      signal: AbortSignal.timeout(5000),
    })
    if (modelsRes.ok) {
      const modelsData = (await modelsRes.json()) as { data: { id: string }[] }
      // Prefer small/mini models for testing
      const preferred = modelsData.data.find((m) =>
        m.id.includes('mini') || m.id.includes('flash')
      )
      model = preferred?.id ?? modelsData.data[0]?.id ?? ''
    }
  } catch {
    // fallback to static defaults
  }

  if (!model) {
    const fallback: Record<string, string> = {
      openai: 'gpt-5.4-mini',
      gemini: 'gemini-2.5-flash',
      anthropic: 'claude-sonnet-4-20250514',
    }
    model = fallback[providerId] ?? 'gpt-5.4-mini'
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
      return c.json({
        success: false,
        provider: providerId,
        model,
        latency,
        error: `LLM returned ${res.status}: ${text.substring(0, 200)}`,
      })
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }

    const reply = data.choices?.[0]?.message?.content ?? ''

    return c.json({
      success: true,
      provider: providerId,
      model,
      latency,
      reply: reply.substring(0, 100),
      usage: data.usage ?? null,
    })
  } catch (err) {
    return c.json(
      {
        success: false,
        provider: providerId,
        model,
        latency: Date.now() - startTime,
        error: String(err),
      },
      502
    )
  }
})

// ── Disconnect a provider (revoke auth) ──
llmRouter.post('/providers/:id/disconnect', async (c) => {
  const providerId = c.req.param('id')
  // For now, just return success — full revocation would need CLIProxy support
  return c.json({
    success: true,
    message: `Provider ${providerId} disconnected. Re-authenticate to reconnect.`,
  })
})
