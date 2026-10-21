import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { db } from './db/client.js'
import { gitnexusUrl, gitnexusHeaders } from './lib/gitnexus.js'
import { appVersion } from './version.js'
import { projectGuard } from './lib/project-guard.js'
import { cors } from 'hono/cors'
import { logger as honoLogger } from 'hono/logger'
import { createLogger } from '@cortex/shared-utils'
import { setupRouter } from './routes/setup.js'
import { keysRouter } from './routes/keys.js'
import { llmRouter } from './routes/llm.js'
import { intelRouter } from './routes/intel.js'
import { qualityRouter, sessionsRouter } from './routes/quality.js'
import { orgsRouter, projectsRouter } from './routes/organizations.js'
import { indexingRouter } from './routes/indexing.js'
import { usageRouter } from './routes/usage.js'
import { mem9ProxyRouter } from './routes/mem9-proxy.js'
import { statsRouter as metricsRouter } from './routes/stats.js'
import { systemRouter } from './routes/system.js'
import { accountsRouter } from './routes/accounts.js'
import { webhooksRouter } from './routes/webhooks.js'
import { tasksRouter } from './routes/tasks.js'
import { knowledgeRouter } from './routes/knowledge.js'
import { conductorRouter } from './routes/conductor.js'
import { settingsRouter } from './routes/settings.js'
import { recoverInterruptedJobs } from './services/indexer.js'
import { scheduleBranchSweep } from './services/branch-retention.js'
import { scheduleSessionExpiry } from './services/session-expiry.js'
import { captureTaskRisks } from './services/task-risks.js'
import { onTaskSettled } from './conductor/lifecycle.js'
import { scheduleConductor } from './conductor/scheduler.js'
import { apiAuth, apiAuthFromEnv, describeApiAuth } from './lib/api-auth.js'

const app = new Hono()
const logger = createLogger('dashboard-api')

app.use('*', cors({
  origin: (origin) => {
    // Allow same-origin, localhost dev, and configured dashboard URL
    const allowed = [
      /^https?:\/\/localhost(:\d+)?$/,
      /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
    ]
    const dashboardUrl = process.env['DASHBOARD_URL']
    if (dashboardUrl) allowed.push(new RegExp(`^${dashboardUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
    if (!origin || allowed.some(re => re.test(origin))) return origin
    return null  // block unknown origins
  },
}))
app.use('*', honoLogger())

// ── Who may call /api (API_AUTH=required) ──
const apiAuthOptions = apiAuthFromEnv()
app.use('/api/*', apiAuth(apiAuthOptions))

// ── Project Enabled Guard Middleware ──
app.use('/api/*', projectGuard)

app.get('/health', async (c) => {
  const startTime = Date.now()

  async function checkService(
    name: string,
    url: string,
    headers?: Record<string, string>,
  ): Promise<'ok' | 'error'> {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(3000) })
      return res.ok ? 'ok' : 'error'
    } catch {
      return 'error'
    }
  }

  const [qdrant, cliproxy, gitnexus, mem9, mcp] = await Promise.all([
    checkService('qdrant', `${process.env['QDRANT_URL'] || 'http://qdrant:6333'}/healthz`),
    checkService('cliproxy', `${process.env['LLM_PROXY_URL'] || 'http://llm-proxy:8317'}/v1/models`),
    // eval-server enforces its bearer token on /health too, so probe it with the header.
    checkService('gitnexus', `${gitnexusUrl()}/health`, gitnexusHeaders()),
    checkService('mem9', `http://localhost:${process.env.PORT || 4000}/api/mem9/health`),
    checkService('mcp', `${process.env['MCP_HEALTH_URL'] || 'http://cortex-mcp:8317/health'}`),
  ])

  // Query enabled Ollama accounts
  let ollamaStatus: 'ok' | 'error' | 'not_configured' = 'not_configured'
  let ollamaError: string | undefined = undefined

  try {
    const ollamaAccounts = db
      .prepare("SELECT name, api_base, api_key FROM provider_accounts WHERE type = 'ollama' AND status = 'enabled'")
      .all() as Array<{ name: string; api_base: string; api_key: string | null }>

    if (ollamaAccounts.length > 0) {
      ollamaStatus = 'ok'
      for (const acct of ollamaAccounts) {
        try {
          const url = `${acct.api_base.replace(/\/$/, '')}/models`
          const headers: Record<string, string> = {}
          if (acct.api_key && acct.api_key !== 'none') {
            headers['Authorization'] = `Bearer ${acct.api_key}`
          }
          const res = await fetch(url, { headers, signal: AbortSignal.timeout(3000) })
          if (!res.ok) {
            ollamaStatus = 'error'
            ollamaError = `Ollama server "${acct.name}" returned ${res.status}: ${res.statusText}`
            break
          }
        } catch (err) {
          ollamaStatus = 'error'
          ollamaError = `Ollama server "${acct.name}" is unreachable: ${String(err)}`
          break
        }
      }
    }
  } catch (err) {
    logger.error('Failed to check Ollama health:', { error: err })
  }

  // Check active Chat Model health
  let chatModelStatus: 'ok' | 'error' | 'not_configured' = 'not_configured'
  let chatModelError: string | undefined = undefined
  try {
    const row = db.prepare("SELECT chain FROM model_routing WHERE purpose = 'chat'").get() as { chain: string } | undefined
    if (row?.chain) {
      const chain = JSON.parse(row.chain) as Array<{ accountId: string; model: string }>
      if (chain.length > 0 && chain[0]) {
        const slot = chain[0]
        const acct = db
          .prepare("SELECT name, api_base, api_key, type FROM provider_accounts WHERE id = ? AND status = 'enabled'")
          .get(slot.accountId) as { name: string; api_base: string; api_key: string | null; type: string } | undefined

        if (!acct) {
          chatModelStatus = 'error'
          chatModelError = `Configured chat account "${slot.accountId}" not found or disabled.`
        } else {
          try {
            if (acct.type === 'gemini') {
              const base = acct.api_base.replace(/\/$/, '')
              const apiKey = acct.api_key ?? ''
              const url = `${base}/models/${slot.model}?key=${apiKey}`
              const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
              if (!res.ok) {
                chatModelStatus = 'error'
                chatModelError = `Gemini API check failed: ${res.status} ${res.statusText}`
              } else {
                chatModelStatus = 'ok'
              }
            } else if (acct.type === 'ollama') {
              const url = `${acct.api_base.replace(/\/$/, '')}/models`
              const headers: Record<string, string> = {}
              if (acct.api_key && acct.api_key !== 'none') {
                headers['Authorization'] = `Bearer ${acct.api_key}`
              }
              const res = await fetch(url, { headers, signal: AbortSignal.timeout(3000) })
              if (!res.ok) {
                chatModelStatus = 'error'
                chatModelError = `Ollama check failed: ${res.status}`
              } else {
                const data = (await res.json()) as { data?: Array<{ id: string }> }
                const models = data.data ?? []
                const exists = models.some((m) => m.id === slot.model || m.id.split(':')[0] === slot.model.split(':')[0])
                if (!exists) {
                  chatModelStatus = 'error'
                  chatModelError = `Model "${slot.model}" is not downloaded on Ollama.`
                } else {
                  chatModelStatus = 'ok'
                }
              }
            } else {
              const url = `${acct.api_base.replace(/\/$/, '')}/models`
              const headers: Record<string, string> = { 'Content-Type': 'application/json' }
              if (acct.api_key) headers['Authorization'] = `Bearer ${acct.api_key}`
              const res = await fetch(url, { headers, signal: AbortSignal.timeout(3000) })
              if (!res.ok) {
                chatModelStatus = 'error'
                chatModelError = `API key/endpoint check failed: ${res.status} ${res.statusText}`
              } else {
                chatModelStatus = 'ok'
              }
            }
          } catch (err) {
            chatModelStatus = 'error'
            chatModelError = `Connection failed: ${String(err)}`
          }
        }
      }
    }
  } catch (err) {
    logger.error('Failed to check chat model health:', { error: err })
  }

  const services = {
    qdrant,
    cliproxy,
    gitnexus,
    mem9,
    mcp,
    ollama: ollamaStatus,
    chatModel: chatModelStatus,
  }
  const allOk = Object.entries(services).every(([name, status]) => {
    if (name === 'ollama' || name === 'chatModel') {
      return status !== 'error'
    }
    return status === 'ok'
  })

  return c.json({
    status: allOk ? 'ok' : 'degraded',
    service: 'dashboard-api',
    version: appVersion,
    commit: process.env['COMMIT_SHA'] || 'dev',
    buildDate: process.env['BUILD_DATE'] || 'unknown',
    image: `${process.env['CORTEX_IMAGE_NAMESPACE'] || 'ghcr.io/lktiep'}/cortex-api:v${appVersion}`,
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    responseTime: Date.now() - startTime,
    services,
    ollamaError,
    chatModelError,
  })
})

app.route('/api/setup', setupRouter)
app.route('/api/keys', keysRouter)
app.route('/api/llm', llmRouter)
app.route('/api/intel', intelRouter)
app.route('/api/quality', qualityRouter)
app.route('/api/sessions', sessionsRouter)
app.route('/api/orgs', orgsRouter)
app.route('/api/projects', projectsRouter)
app.route('/api/projects', indexingRouter)
app.route('/api/usage', usageRouter)
app.route('/api/system', systemRouter)
app.route('/api/metrics', metricsRouter)
app.route('/api/accounts', accountsRouter)
app.route('/api/indexing', indexingRouter)
app.route('/api/mem9', mem9ProxyRouter)
app.route('/api/knowledge', knowledgeRouter)
app.route('/api/webhooks', webhooksRouter)
app.route('/api/tasks', tasksRouter)
app.route('/api/conductor', conductorRouter)
app.route('/api/settings', settingsRouter)

// The risks a task reports are kept as knowledge on its files, stored the way
// cortex_knowledge_store stores (chunked and embedded), off the request that completed it.
onTaskSettled((task) => {
  void captureTaskRisks(task, async (doc) => {
    const res = await knowledgeRouter.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc),
    })
    return res.status === 201
  }).catch((err: unknown) => logger.warn(`[${task.id}] keeping task risks failed: ${String(err)}`))
})

// Serve Dashboard Web static files (Next.js static export)
// Clean URLs: /keys → /keys.html, / → /index.html
app.use('/*', serveStatic({ 
  root: './public',
  rewriteRequestPath: (path) => {
    if (path === '/') return '/index.html'
    if (!path.includes('.') && !path.startsWith('/api/') && !path.startsWith('/_next/')) {
      return `${path}.html`
    }
    return path
  }
}))

// SPA fallback: serve index.html for unmatched client-side routes
// SKIP /api/* and /health — let Hono return 404 for unmatched API routes
app.get('*', async (c, next) => {
  if (c.req.path.startsWith('/api/') || c.req.path === '/health') {
    return next()
  }
  return serveStatic({ root: './public', rewriteRequestPath: () => '/index.html' })(c, next)
})

const port = Number(process.env.PORT) || 4000

// Index jobs queue in memory; close the ones the last process was running.
recoverInterruptedJobs()
scheduleBranchSweep()
scheduleSessionExpiry()
scheduleConductor()

const server = serve({ fetch: app.fetch, port }, () => {
  logger.info(`Dashboard API listening on http://localhost:${port}`)
  logger.info(describeApiAuth(apiAuthOptions))
  if (apiAuthOptions.required && !apiAuthOptions.internalSecret) {
    logger.error('API_AUTH=required without INTERNAL_API_SECRET: the MCP gateway cannot reach /api, so every MCP tool will fail')
  }
})

// WebSocket for Conductor real-time agent communication
try {
  const { setupConductorWebSocket } = await import('./ws/conductor.js')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setupConductorWebSocket(server as any)
} catch (e) {
  console.warn('[ws] Conductor WebSocket not available:', (e as Error).message)
}
