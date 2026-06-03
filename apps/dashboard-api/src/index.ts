import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { readFileSync } from 'node:fs'

// Read version from version.json (copied at build time)
let appVersion = process.env['APP_VERSION'] || '0.0.0-dev'
try {
  const versionJson = JSON.parse(readFileSync('./version.json', 'utf-8'))
  appVersion = versionJson.version || appVersion
} catch {
  // version.json not found — use fallback
}
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

app.get('/health', async (c) => {
  const startTime = Date.now()

  async function checkService(name: string, url: string): Promise<'ok' | 'error'> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
      return res.ok ? 'ok' : 'error'
    } catch {
      return 'error'
    }
  }

  const [qdrant, cliproxy, gitnexus, mem9, mcp] = await Promise.all([
    checkService('qdrant', `${process.env['QDRANT_URL'] || 'http://qdrant:6333'}/healthz`),
    checkService('cliproxy', `${process.env['LLM_PROXY_URL'] || 'http://llm-proxy:8317'}/v1/models`),
    checkService('gitnexus', `${process.env['GITNEXUS_URL'] || 'http://gitnexus:4848'}/health`),
    checkService('mem9', `http://localhost:${process.env.PORT || 4000}/api/mem9/health`),
    checkService('mcp', `${process.env['MCP_HEALTH_URL'] || 'http://cortex-mcp:8317/health'}`),
  ])

  const services = { qdrant, cliproxy, gitnexus, mem9, mcp }
  const allOk = Object.values(services).every(s => s === 'ok')

  return c.json({
    status: allOk ? 'ok' : 'degraded',
    service: 'dashboard-api',
    version: appVersion,
    commit: process.env['COMMIT_SHA'] || 'dev',
    buildDate: process.env['BUILD_DATE'] || 'unknown',
    image: `ghcr.io/lktiep/cortex-hub:${(process.env['COMMIT_SHA'] || 'dev').slice(0, 7)}`,
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    responseTime: Date.now() - startTime,
    services,
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

const server = serve({ fetch: app.fetch, port }, () => {
  logger.info(`Dashboard API listening on http://localhost:${port}`)
})

// WebSocket for Conductor real-time agent communication
try {
  const { setupConductorWebSocket } = await import('./ws/conductor.js')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setupConductorWebSocket(server as any)
} catch (e) {
  console.warn('[ws] Conductor WebSocket not available:', (e as Error).message)
}

// Pre-warm local embedding model if EMBEDDING_PROVIDER=local.
// The first cold-load downloads ~25MB and can take 5-10s. Doing it at
// startup avoids the first API request hanging or timing out.
if (process.env['EMBEDDING_PROVIDER'] === 'local') {
  // Defer to next tick so it doesn't block startup logs
  setTimeout(() => {
    void (async () => {
      try {
        const t0 = Date.now()
        logger.info('[embed] Importing @cortex/shared-mem9...')
        const { embedLocal } = await import('@cortex/shared-mem9')
        const model = process.env['LOCAL_EMBEDDING_MODEL'] || 'Xenova/all-MiniLM-L6-v2'
        logger.info(`[embed] Pre-warming local model: ${model}`)
        const v = await embedLocal('warmup', model)
        logger.info(`[embed] Local model ready in ${Date.now() - t0}ms (dim=${v.length})`)
      } catch (e) {
        const err = e as Error
        logger.error(`[embed] Local pre-warm FAILED: ${err.message}\n${err.stack?.slice(0, 2000)}`)
      }
    })()
  }, 500)
}
