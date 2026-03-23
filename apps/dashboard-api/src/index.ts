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
import { knowledgeRouter } from './routes/knowledge.js'

const app = new Hono()
const logger = createLogger('dashboard-api')

app.use('*', cors())
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
    checkService('mem9', `${process.env['MEM9_URL'] || 'http://mem9:3100'}/health`),
    checkService('mcp', `${process.env['MCP_HEALTH_URL'] || 'https://cortex-mcp.jackle.dev/health'}`),
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
app.get('*', serveStatic({
  root: './public',
  rewriteRequestPath: () => '/index.html'
}))

const port = Number(process.env.PORT) || 4000

serve({ fetch: app.fetch, port }, () => {
  logger.info(`Dashboard API listening on http://localhost:${port}`)
})
