import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createLogger } from '@cortex/shared-utils'
import { setupRouter } from './routes/setup.js'
import { keysRouter } from './routes/keys.js'
import { llmRouter } from './routes/llm.js'
import { intelRouter } from './routes/intel.js'
import { qualityRouter, sessionsRouter } from './routes/quality.js'
import { orgsRouter, projectsRouter } from './routes/organizations.js'
import { usageRouter } from './routes/usage.js'

const app = new Hono()
const logger = createLogger('dashboard-api')

app.use('*', cors())

app.get('/health', async (c) => {
  const startTime = Date.now()

  // Check each downstream service
  async function checkService(name: string, url: string): Promise<'ok' | 'error'> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
      return res.ok ? 'ok' : 'error'
    } catch {
      return 'error'
    }
  }

  const [qdrant, neo4j, cliproxy, mem0] = await Promise.all([
    checkService('qdrant', `${process.env['QDRANT_URL'] || 'http://qdrant:6333'}/healthz`),
    checkService('neo4j', `http://${process.env['NEO4J_URL']?.replace('bolt://', '').replace(':7687', '') || 'neo4j'}:7474/`),
    checkService('cliproxy', `${process.env['LLM_PROXY_URL'] || 'http://llm-proxy:8317'}/v1/models`),
    checkService('mem0', `${process.env['MEM0_URL'] || 'http://mem0:8050'}/health`),
  ])

  const services = { qdrant, neo4j, cliproxy, mem0 }
  const allOk = Object.values(services).every(s => s === 'ok')

  return c.json({
    status: allOk ? 'ok' : 'degraded',
    service: 'dashboard-api',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    responseTime: Date.now() - startTime,
    services,
  })
})

app.get('/', (c) => {
  return c.json({
    name: 'Cortex Hub Dashboard API',
    version: '0.1.0',
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
app.route('/api/usage', usageRouter)

const port = Number(process.env['PORT'] ?? 4000)

serve({ fetch: app.fetch, port }, () => {
  logger.info(`Dashboard API running on http://localhost:${port}`)
})
