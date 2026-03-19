import { Hono } from 'hono'
import { db } from '../db/client.js'

export const setupRouter = new Hono()

// ── Helpers ──
const CLIPROXY_URL = () =>
  process.env.LLM_PROXY_URL || process.env.CLIPROXY_URL || 'http://localhost:8317'
const MANAGEMENT_KEY = () =>
  process.env.CLIPROXY_MANAGEMENT_KEY || process.env.MANAGEMENT_PASSWORD || 'cortex2026'
const QDRANT_URL = () =>
  process.env.QDRANT_URL || 'http://localhost:6333'
const DASHBOARD_URL = () =>
  process.env.DASHBOARD_URL || 'https://hub.jackle.dev'

function managementHeaders() {
  return {
    Authorization: `Bearer ${MANAGEMENT_KEY()}`,
    'Content-Type': 'application/json',
  }
}

// ── Setup Status ──
setupRouter.get('/status', (c) => {
  const stmt = db.prepare('SELECT completed FROM setup_status WHERE id = 1')
  const status = stmt.get() as { completed: number } | undefined
  return c.json({ completed: status?.completed === 1 })
})

setupRouter.post('/complete', async (c) => {
  try {
    const stmt = db.prepare(
      'UPDATE setup_status SET completed = 1, completed_at = datetime("now") WHERE id = 1'
    )
    stmt.run()
    return c.json({ success: true })
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500)
  }
})

// ── Configure mem0 ──
setupRouter.post('/configure-mem0', async (c) => {
  const MEM0_URL = process.env.MEM0_URL || 'http://mem0:8050'

  try {
    const body = await c.req.json()
    const { provider, models } = body

    // Check if mem0 is reachable
    const healthRes = await fetch(`${MEM0_URL}/health`, {
      signal: AbortSignal.timeout(5000),
    })

    if (!healthRes.ok) {
      return c.json({ success: false, error: 'mem0 is not reachable' }, 502)
    }

    // Log the configuration
    console.log(`[Setup] Configured mem0 with provider=${provider}, models=${(models as string[]).join(',')}`)

    return c.json({
      success: true,
      message: 'mem0 configured successfully',
      provider,
      modelCount: (models as string[]).length,
    })
  } catch (err) {
    console.error('[Setup] mem0 configuration failed:', err)
    return c.json({ success: false, error: String(err) }, 502)
  }
})

// ── Models (proxy CLIProxy) ──
setupRouter.get('/models', async (c) => {
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

// ── Connection Test ──
setupRouter.get('/test', async (c) => {
  const results = {
    cliproxy: false,
    qdrant: false,
    dashboardApi: true,
    allPassed: false,
  }

  try {
    const res = await fetch(`${CLIPROXY_URL()}/v1/models`, {
      signal: AbortSignal.timeout(3000),
    })
    if (res.ok || res.status === 401) results.cliproxy = true
  } catch (e) {
    console.error('CLIProxy offline:', e)
  }

  try {
    const res = await fetch(`${QDRANT_URL()}/`, {
      signal: AbortSignal.timeout(3000),
    })
    if (res.ok) results.qdrant = true
  } catch (e) {
    console.error('Qdrant offline:', e)
  }

  results.allPassed = results.cliproxy && results.qdrant && results.dashboardApi
  return c.json(results, results.allPassed ? 200 : 503)
})

// ── Settings ──
setupRouter.get('/settings', (c) => {
  return c.json({
    environment: process.env.NODE_ENV || 'development',
    services: {
      cliproxy: CLIPROXY_URL(),
      qdrant: QDRANT_URL(),
      neo4j: process.env.NEO4J_URL || 'bolt://localhost:7687',
      mem0: process.env.MEM0_URL || 'http://localhost:8050',
      dashboardApi: `http://localhost:${process.env.PORT || 4000}`,
    },
    database: process.env.DATABASE_PATH || 'data/cortex.db',
    version: '0.1.0',
  })
})

// ═══════════════════════════════════════════════════
// OAuth Flow — Dashboard-Managed with CLIProxy Relay
//
// 1. GET /oauth/start/:provider
//    → Calls CLIProxy Management API to get OAuth URL
//    → Rewrites redirect_uri to point to Dashboard callback page
//    → Stores original callback URL for later relay
//    → Returns modified OAuth URL + state to frontend
//
// 2. POST /oauth/relay
//    → Receives code + state from frontend callback page
//    → Forwards to CLIProxy's internal callback endpoint
//    → CLIProxy exchanges code for token and saves it
//
// 3. GET /oauth/status?state=
//    → Polls CLIProxy's auth status (wait/ok/error)
// ═══════════════════════════════════════════════════

// In-memory store for pending OAuth flows (state → original redirect info)
const pendingOAuth = new Map<string, {
  provider: string
  originalCallbackUrl: string
  createdAt: number
}>()

// Clean up stale entries every 5 minutes
setInterval(() => {
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000
  for (const [key, val] of pendingOAuth) {
    if (val.createdAt < fiveMinutesAgo) pendingOAuth.delete(key)
  }
}, 5 * 60 * 1000)

// Provider → CLIProxy management endpoint mapping
const OAUTH_PROVIDER_MAP: Record<string, string> = {
  openai: 'codex-auth-url',
  gemini: 'gemini-cli-auth-url',
  claude: 'anthropic-auth-url',
}

// Step 1: Start OAuth — get URL from CLIProxy, rewrite redirect_uri
setupRouter.get('/oauth/start/:provider', async (c) => {
  const provider = c.req.param('provider')
  const endpoint = OAUTH_PROVIDER_MAP[provider]

  if (!endpoint) {
    return c.json(
      { error: `Unsupported OAuth provider: ${provider}`, supported: Object.keys(OAUTH_PROVIDER_MAP) },
      400
    )
  }

  try {
    // Get OAuth URL from CLIProxy Management API
    const mgmtUrl = `${CLIPROXY_URL()}/v0/management/${endpoint}?is_webui=true`
    const res = await fetch(mgmtUrl, {
      headers: managementHeaders(),
      signal: AbortSignal.timeout(10000),
    })

    if (!res.ok) {
      const text = await res.text()
      return c.json({ error: `CLIProxy returned ${res.status}`, details: text }, res.status as 400)
    }

    const data = (await res.json()) as { status: string; url: string; state: string }

    // Parse the OAuth URL to rewrite redirect_uri
    const oauthUrl = new URL(data.url)
    const originalRedirectUri = oauthUrl.searchParams.get('redirect_uri') || ''

    // Extract the callback base URL from the original redirect_uri
    // e.g., http://localhost:1455/auth/callback → we need to relay to this later
    const callbackUrl = originalRedirectUri

    // Rewrite redirect_uri to point to our Dashboard callback page
    const dashboardCallbackUrl = `${DASHBOARD_URL()}/setup/callback`
    oauthUrl.searchParams.set('redirect_uri', dashboardCallbackUrl)

    // Store the mapping for later relay
    pendingOAuth.set(data.state, {
      provider,
      originalCallbackUrl: callbackUrl,
      createdAt: Date.now(),
    })

    return c.json({
      success: true,
      provider,
      oauthUrl: oauthUrl.toString(),
      state: data.state,
      // Also return the original URL as fallback
      originalOauthUrl: data.url,
    })
  } catch (err) {
    return c.json({ error: 'Failed to start OAuth flow', details: String(err) }, 502)
  }
})

// Step 2: Relay — receives code+state from dashboard callback, forwards to CLIProxy
setupRouter.post('/oauth/relay', async (c) => {
  try {
    const body = await c.req.json()
    const { code, state, scope } = body

    if (!code || !state) {
      return c.json({ error: 'code and state are required' }, 400)
    }

    const pending = pendingOAuth.get(state)
    if (!pending) {
      console.warn(`OAuth state ${state} not found in pending map, trying direct relay`)
    }

    // Build the callback URL with query params
    // CLIProxy binds port 1455 to 127.0.0.1 ONLY — unreachable from other containers
    // So we use `docker exec` + `wget` to relay from INSIDE the CLIProxy container
    const params = new URLSearchParams({ code, state })
    if (scope) params.set('scope', scope)
    const callbackUrl = `http://127.0.0.1:1455/auth/callback?${params.toString()}`

    console.log(`[OAuth Relay] Using docker exec to relay callback to CLIProxy`)

    const { exec } = await import('child_process')
    const { promisify } = await import('util')
    const execAsync = promisify(exec)

    try {
      const { stdout, stderr } = await execAsync(
        `docker exec cortex-llm-proxy wget -q -O - '${callbackUrl}'`,
        { timeout: 15000 }
      )
      console.log(`[OAuth Relay] CLIProxy response: ${stdout.substring(0, 200)}`)
      if (stderr) console.warn(`[OAuth Relay] stderr: ${stderr}`)

      // Check if response contains "Authentication successful"
      if (stdout.includes('Authentication successful') || stdout.includes('successful')) {
        // Clean up
        if (pending) pendingOAuth.delete(state)
        // Give CLIProxy a moment to save the token
        await new Promise((resolve) => setTimeout(resolve, 2000))
        return c.json({ success: true, status: 'completed' })
      } else {
        return c.json({ success: false, error: 'CLIProxy did not confirm auth', details: stdout })
      }
    } catch (execErr: unknown) {
      const errMsg = execErr instanceof Error ? execErr.message : String(execErr)
      console.error(`[OAuth Relay] docker exec failed: ${errMsg}`)
      return c.json({ success: false, error: 'Failed to relay to CLIProxy', details: errMsg }, 502)
    }
  } catch (err) {
    console.error('[OAuth Relay] Error:', err)
    return c.json({ error: 'Failed to relay OAuth callback', details: String(err) }, 502)
  }
})

// Step 3: Poll OAuth status
setupRouter.get('/oauth/status', async (c) => {
  const state = c.req.query('state')
  if (!state) {
    return c.json({ error: 'state query parameter is required' }, 400)
  }

  try {
    const url = `${CLIPROXY_URL()}/v0/management/get-auth-status?state=${encodeURIComponent(state)}`
    const res = await fetch(url, {
      headers: managementHeaders(),
      signal: AbortSignal.timeout(5000),
    })

    if (!res.ok) {
      return c.json({ status: 'error', error: `Management API returned ${res.status}` })
    }

    const data = (await res.json()) as { status: string; error?: string }
    return c.json(data)
  } catch (err) {
    return c.json({ status: 'error', error: String(err) })
  }
})

// ═══════════════════════════════════════════════════
// API Key Configuration — Direct Management API
// For users who have API keys instead of OAuth
// ═══════════════════════════════════════════════════

setupRouter.post('/configure-provider', async (c) => {
  try {
    const body = await c.req.json()
    const { provider, apiKey } = body

    if (!provider || !apiKey) {
      return c.json({ error: 'provider and apiKey are required' }, 400)
    }

    const authDir = process.env.CLIPROXY_AUTH_DIR || '/app/cliproxy-auth'
    const fs = await import('fs')
    const path = await import('path')

    if (!fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true })
    }

    let yamlContent = ''
    const filename = `cortex-${provider}.yaml`

    switch (provider) {
      case 'openai':
        yamlContent = [
          '# Auto-configured by Cortex Hub Setup Wizard',
          'openai-compatibility:',
          '  - name: "openai"',
          '    base-url: "https://api.openai.com/v1"',
          '    api-key-entries:',
          `      - api-key: "${apiKey}"`,
        ].join('\n')
        break
      case 'gemini':
        yamlContent = [
          '# Auto-configured by Cortex Hub Setup Wizard',
          'gemini-api-key:',
          `  - api-key: "${apiKey}"`,
        ].join('\n')
        break
      case 'claude':
        yamlContent = [
          '# Auto-configured by Cortex Hub Setup Wizard',
          'claude-api-key:',
          `  - api-key: "${apiKey}"`,
        ].join('\n')
        break
      case 'custom':
        yamlContent = [
          '# Auto-configured by Cortex Hub Setup Wizard',
          'openai-compatibility:',
          '  - name: "custom"',
          '    base-url: "https://api.openai.com/v1"',
          '    api-key-entries:',
          `      - api-key: "${apiKey}"`,
        ].join('\n')
        break
      default:
        return c.json({ error: `Unsupported provider: ${provider}` }, 400)
    }

    const filePath = path.join(authDir, filename)
    fs.writeFileSync(filePath, yamlContent + '\n', 'utf-8')

    await new Promise((resolve) => setTimeout(resolve, 2500))

    let modelsDetected = 0
    try {
      const res = await fetch(`${CLIPROXY_URL()}/v1/models`, { signal: AbortSignal.timeout(5000) })
      const data = (await res.json()) as { data?: Array<{ id: string }> }
      modelsDetected = data.data?.length || 0
    } catch { /* models might not be immediately available */ }

    return c.json({ success: true, provider, authFile: filename, modelsDetected })
  } catch (err) {
    return c.json({ error: 'Failed to configure provider', details: String(err) }, 500)
  }
})
