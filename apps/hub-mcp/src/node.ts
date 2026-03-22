import { serve } from '@hono/node-server'
import app from './index.js'

const port = Number(process.env.PORT) || 8317

console.log(`Cortex Hub MCP Server starting on port ${port}...`)

serve({
  fetch: app.fetch,
  port,
}, (info) => {
  console.log(`MCP Gateway running at http://localhost:${info.port}`)
})
