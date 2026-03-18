import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createLogger } from '@cortex/shared-utils'
import { setupRouter } from './routes/setup.js'
import { keysRouter } from './routes/keys.js'

const app = new Hono()
const logger = createLogger('dashboard-api')

app.use('*', cors())

app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    service: 'dashboard-api',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
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

const port = Number(process.env['PORT'] ?? 4000)

serve({ fetch: app.fetch, port }, () => {
  logger.info(`Dashboard API running on http://localhost:${port}`)
})
