import { Hono } from 'hono'
import { randomUUID } from 'crypto'
import { db } from '../db/client.js'

export const accountsRouter = new Hono()

/** Row shape from provider_accounts table */
interface ProviderAccountRow {
  id: string
  name: string
  type: string
  auth_type: string
  api_base: string
  api_key: string | null
  status: string
  capabilities: string
  models: string
  created_at: string
  updated_at: string
}

interface RoutingRow {
  purpose: string
  chain: string
  updated_at: string
}

const CLIPROXY_URL = () =>
  process.env.LLM_PROXY_URL || process.env.CLIPROXY_URL || 'http://localhost:8317'
const MANAGEMENT_KEY = () =>
  process.env.CLIPROXY_MANAGEMENT_KEY || process.env.MANAGEMENT_PASSWORD || 'cortex2026'

// ── Auto-seed existing providers on first load ──
let seeded = false
function seedExistingProviders() {
  if (seeded) return
  seeded = true

  const count = (db.prepare('SELECT COUNT(*) as c FROM provider_accounts').get() as { c: number }).c
  if (count > 0) return // already have providers

  // Seed CLIProxy (OpenAI via OAuth)
  db.prepare(
    `INSERT OR IGNORE INTO provider_accounts (id, name, type, auth_type, api_base, status, capabilities)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'pa-cliproxy-openai',
    'CLIProxy (OpenAI OAuth)',
    'openai_compat',
    'oauth',
    `${CLIPROXY_URL()}/v1`,
    'enabled',
    '["chat","embedding","code"]'
  )

  // Seed Gemini (if API key exists in env)
  const geminiKey = process.env.GEMINI_API_KEY
  if (geminiKey) {
    db.prepare(
      `INSERT OR IGNORE INTO provider_accounts (id, name, type, auth_type, api_base, api_key, status, capabilities)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'pa-gemini-gcp',
      'Google Gemini (GCP)',
      'gemini',
      'api_key',
      'https://generativelanguage.googleapis.com/v1beta',
      geminiKey,
      'enabled',
      '["chat","embedding"]'
    )
  }

  console.log('[accounts] Auto-seeded existing providers from environment')
}

// ── List all provider accounts ──
accountsRouter.get('/', (c) => {
  seedExistingProviders()

  const search = c.req.query('search')?.toLowerCase()
  const page = Number(c.req.query('page') ?? 1)
  const limit = Number(c.req.query('limit') ?? 20)
  const offset = (page - 1) * limit

  try {
    let rows: ProviderAccountRow[]
    let total: number

    if (search) {
      rows = db
        .prepare(
          `SELECT * FROM provider_accounts 
           WHERE LOWER(name) LIKE ? OR LOWER(type) LIKE ? 
           ORDER BY created_at DESC LIMIT ? OFFSET ?`
        )
        .all(`%${search}%`, `%${search}%`, limit, offset) as ProviderAccountRow[]

      total = (
        db
          .prepare(
            `SELECT COUNT(*) as count FROM provider_accounts 
             WHERE LOWER(name) LIKE ? OR LOWER(type) LIKE ?`
          )
          .get(`%${search}%`, `%${search}%`) as { count: number }
      ).count
    } else {
      rows = db
        .prepare('SELECT * FROM provider_accounts ORDER BY created_at DESC LIMIT ? OFFSET ?')
        .all(limit, offset) as ProviderAccountRow[]

      total = (db.prepare('SELECT COUNT(*) as count FROM provider_accounts').get() as { count: number }).count
    }

    // Mask API keys in response
    const accounts = rows.map((row) => ({
      ...row,
      api_key: row.api_key ? '•••' + row.api_key.slice(-4) : null,
      capabilities: JSON.parse(row.capabilities || '["chat"]'),
      models: JSON.parse(row.models || '[]'),
    }))

    return c.json({
      accounts,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Add a new provider account ──
accountsRouter.post('/', async (c) => {
  try {
    const body = await c.req.json()
    const { name, type, authType, apiBase, apiKey, capabilities } = body

    if (!name || !type || !apiBase) {
      return c.json({ error: 'name, type, and apiBase are required' }, 400)
    }

    const id = `pa-${randomUUID().slice(0, 8)}`
    const caps = JSON.stringify(capabilities ?? ['chat'])

    db.prepare(
      `INSERT INTO provider_accounts (id, name, type, auth_type, api_base, api_key, capabilities) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, name, type, authType || 'api_key', apiBase, apiKey || null, caps)

    return c.json({ success: true, id }, 201)
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Update a provider account ──
accountsRouter.put('/:id', async (c) => {
  const id = c.req.param('id')
  try {
    const existing = db.prepare('SELECT id FROM provider_accounts WHERE id = ?').get(id)
    if (!existing) return c.json({ error: 'Account not found' }, 404)

    const body = await c.req.json()
    const { name, type, authType, apiBase, apiKey, status, capabilities, models } = body

    const updates: string[] = []
    const params: unknown[] = []

    if (name !== undefined) { updates.push('name = ?'); params.push(name) }
    if (type !== undefined) { updates.push('type = ?'); params.push(type) }
    if (authType !== undefined) { updates.push('auth_type = ?'); params.push(authType) }
    if (apiBase !== undefined) { updates.push('api_base = ?'); params.push(apiBase) }
    if (apiKey !== undefined) { updates.push('api_key = ?'); params.push(apiKey || null) }
    if (status !== undefined) { updates.push('status = ?'); params.push(status) }
    if (capabilities !== undefined) { updates.push('capabilities = ?'); params.push(JSON.stringify(capabilities)) }
    if (models !== undefined) { updates.push('models = ?'); params.push(JSON.stringify(models)) }

    if (updates.length === 0) {
      return c.json({ error: 'No fields to update' }, 400)
    }

    updates.push("updated_at = datetime('now')")
    params.push(id)

    db.prepare(`UPDATE provider_accounts SET ${updates.join(', ')} WHERE id = ?`).run(...params)

    return c.json({ success: true })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Delete a provider account ──
accountsRouter.delete('/:id', (c) => {
  const id = c.req.param('id')
  try {
    const result = db.prepare('DELETE FROM provider_accounts WHERE id = ?').run(id)
    if (result.changes === 0) return c.json({ error: 'Account not found' }, 404)
    return c.json({ success: true })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Test a provider connection → returns categorized models ──
accountsRouter.post('/:id/test', async (c) => {
  const id = c.req.param('id')
  try {
    const row = db.prepare('SELECT * FROM provider_accounts WHERE id = ?').get(id) as ProviderAccountRow | undefined
    if (!row) return c.json({ error: 'Account not found' }, 404)

    const startTime = Date.now()

    if (row.type === 'gemini') {
      return await testGeminiProvider(row, id, startTime, c)
    } else {
      return await testOpenAICompatProvider(row, id, startTime, c)
    }
  } catch (error) {
    db.prepare("UPDATE provider_accounts SET status = 'error', updated_at = datetime('now') WHERE id = ?").run(id)
    return c.json({ success: false, error: String(error) }, 500)
  }
})

// ── Direct test with API key (before saving) ──
accountsRouter.post('/test-key', async (c) => {
  try {
    const { type, apiBase, apiKey } = await c.req.json()
    const startTime = Date.now()

    if (type === 'gemini') {
      const testUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
      const res = await fetch(testUrl, { signal: AbortSignal.timeout(10000) })
      const latency = Date.now() - startTime

      if (!res.ok) {
        const err = await res.text()
        return c.json({ success: false, latency, error: `Gemini API error: ${err.substring(0, 200)}` })
      }

      const data = (await res.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] }
      const allModels = data.models ?? []

      const chatModels = allModels
        .filter((m) => m.supportedGenerationMethods?.some((g) => g.includes('generateContent')))
        .map((m) => m.name.replace('models/', ''))
      const embedModels = allModels
        .filter((m) => m.supportedGenerationMethods?.some((g) => g.includes('embedContent')))
        .map((m) => m.name.replace('models/', ''))

      return c.json({
        success: true,
        latency,
        chatModels,
        embedModels,
        totalModels: chatModels.length + embedModels.length,
      })
    } else {
      // OpenAI-compatible
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

      const baseUrl = apiBase?.replace(/\/$/, '') || `${CLIPROXY_URL()}/v1`
      const res = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(10000) })
      const latency = Date.now() - startTime

      if (!res.ok) {
        const err = await res.text()
        return c.json({ success: false, latency, error: `API error (${res.status}): ${err.substring(0, 200)}` })
      }

      const data = (await res.json()) as { data?: { id: string; owned_by?: string }[] }
      const allModels = data.data ?? []

      // Categorize models
      const embedKeywords = ['embed', 'text-embedding']
      const codeKeywords = ['codex', 'code']

      const chatModels = allModels
        .filter((m) => !embedKeywords.some((k) => m.id.includes(k)))
        .map((m) => m.id)
      const embedModels = allModels
        .filter((m) => embedKeywords.some((k) => m.id.includes(k)))
        .map((m) => m.id)
      const codeModels = allModels
        .filter((m) => codeKeywords.some((k) => m.id.includes(k)))
        .map((m) => m.id)

      return c.json({
        success: true,
        latency,
        chatModels,
        embedModels,
        codeModels,
        totalModels: allModels.length,
      })
    }
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500)
  }
})

// ── OAuth flow: get auth URL from CLIProxy ──
accountsRouter.post('/oauth/start', async (c) => {
  try {
    const { provider } = await c.req.json()
    const endpointMap: Record<string, string> = {
      openai: 'codex-auth-url',
      gemini: 'gemini-cli-auth-url',
      anthropic: 'anthropic-auth-url',
    }

    const endpoint = endpointMap[provider]
    if (!endpoint) return c.json({ error: `Unknown OAuth provider: ${provider}` }, 400)

    const res = await fetch(`${CLIPROXY_URL()}/v0/management/${endpoint}`, {
      headers: {
        Authorization: `Bearer ${MANAGEMENT_KEY()}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    })

    if (!res.ok) {
      const err = await res.text()
      return c.json({ error: `CLIProxy error: ${err}` }, 502)
    }

    const data = (await res.json()) as { url?: string; status?: string }
    return c.json({ success: true, authUrl: data.url, status: data.status })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── OAuth status check ──
accountsRouter.get('/oauth/status/:provider', async (c) => {
  const provider = c.req.param('provider')
  const statusMap: Record<string, string> = {
    openai: 'codex-auth-status',
    gemini: 'gemini-cli-auth-status',
    anthropic: 'anthropic-auth-status',
  }

  const endpoint = statusMap[provider]
  if (!endpoint) return c.json({ error: 'Unknown provider' }, 400)

  try {
    const res = await fetch(`${CLIPROXY_URL()}/v0/management/${endpoint}`, {
      headers: {
        Authorization: `Bearer ${MANAGEMENT_KEY()}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(5000),
    })

    if (!res.ok) return c.json({ connected: false })
    const data = (await res.json()) as { status?: string }
    return c.json({ connected: data.status === 'ok' })
  } catch {
    return c.json({ connected: false })
  }
})

// ── Get model routing (fallback chains) ──
accountsRouter.get('/routing/chains', (c) => {
  try {
    const rows = db.prepare('SELECT * FROM model_routing').all() as RoutingRow[]
    const routing: Record<string, { chain: unknown[]; updatedAt: string }> = {}

    for (const row of rows) {
      routing[row.purpose] = {
        chain: JSON.parse(row.chain || '[]'),
        updatedAt: row.updated_at,
      }
    }

    return c.json({ routing })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Update model routing ──
accountsRouter.put('/routing/chains', async (c) => {
  try {
    const body = await c.req.json()
    const { purpose, chain } = body

    if (!purpose || !Array.isArray(chain)) {
      return c.json({ error: 'purpose and chain[] are required' }, 400)
    }

    db.prepare(
      `INSERT INTO model_routing (purpose, chain, updated_at) 
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(purpose) DO UPDATE SET chain = ?, updated_at = datetime('now')`
    ).run(purpose, JSON.stringify(chain), JSON.stringify(chain))

    return c.json({ success: true })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Active config summary ──
accountsRouter.get('/routing/active', (c) => {
  try {
    const routing = db.prepare('SELECT * FROM model_routing').all() as RoutingRow[]
    const accounts = db.prepare("SELECT id, name, type, status FROM provider_accounts WHERE status = 'enabled'")
      .all() as Pick<ProviderAccountRow, 'id' | 'name' | 'type' | 'status'>[]

    const accountMap = new Map(accounts.map((a) => [a.id, a]))

    const config = routing.map((r) => {
      const chain = JSON.parse(r.chain || '[]') as { accountId: string; model: string }[]
      return {
        purpose: r.purpose,
        chain: chain.map((slot) => ({
          ...slot,
          accountName: accountMap.get(slot.accountId)?.name ?? 'Unknown',
        })),
      }
    })

    return c.json({ config, totalAccounts: accounts.length })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Helpers ──
async function testGeminiProvider(row: ProviderAccountRow, id: string, startTime: number, c: { json: (data: unknown, status?: number) => Response }) {
  const testUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${row.api_key}`
  const res = await fetch(testUrl, { signal: AbortSignal.timeout(10000) })
  const latency = Date.now() - startTime

  if (!res.ok) {
    const err = await res.text()
    return c.json({ success: false, latency, error: `Gemini API error: ${err.substring(0, 200)}` })
  }

  const data = (await res.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] }
  const allModels = data.models ?? []
  const chatModels = allModels
    .filter((m) => m.supportedGenerationMethods?.some((g) => g.includes('generateContent')))
    .map((m) => m.name.replace('models/', ''))
  const embedModels = allModels
    .filter((m) => m.supportedGenerationMethods?.some((g) => g.includes('embedContent')))
    .map((m) => m.name.replace('models/', ''))

  const models = [...new Set([...chatModels, ...embedModels])]
  db.prepare("UPDATE provider_accounts SET models = ?, status = 'enabled', updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(models), id)

  return c.json({ success: true, latency, chatModels, embedModels, totalModels: models.length })
}

async function testOpenAICompatProvider(row: ProviderAccountRow, id: string, startTime: number, c: { json: (data: unknown, status?: number) => Response }) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (row.api_key) headers['Authorization'] = `Bearer ${row.api_key}`

  // For OAuth providers, no Authorization needed (CLIProxy handles it)
  const res = await fetch(`${row.api_base}/models`, { headers, signal: AbortSignal.timeout(10000) })
  const latency = Date.now() - startTime

  if (!res.ok) {
    const err = await res.text()
    return c.json({ success: false, latency, error: `API error (${res.status}): ${err.substring(0, 200)}` })
  }

  const data = (await res.json()) as { data?: { id: string }[] }
  const allModels = (data.data ?? []).map((m) => m.id)

  const embedKeywords = ['embed', 'text-embedding']
  const chatModels = allModels.filter((m) => !embedKeywords.some((k) => m.includes(k)))
  const embedModels = allModels.filter((m) => embedKeywords.some((k) => m.includes(k)))

  db.prepare("UPDATE provider_accounts SET models = ?, status = 'enabled', updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(allModels), id)

  return c.json({ success: true, latency, chatModels, embedModels, totalModels: allModels.length })
}
