import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { registerCodeTools } from './tools/code.js'
import { registerHealthTools } from './tools/health.js'
import { registerKnowledgeTools } from './tools/knowledge.js'
import { registerMemoryTools } from './tools/memory.js'
import { registerQualityTools } from './tools/quality.js'
import { registerSessionTools } from './tools/session.js'
import { validateApiKey } from './middleware/auth.js'
import type { Env } from './types.js'

const app = new Hono<{ Bindings: Env }>()

app.use('*', cors())
app.use('*', logger())

// Health endpoint (no auth required)
app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    service: 'hub-mcp',
    version: c.env.MCP_SERVER_VERSION ?? '0.1.0',
    timestamp: new Date().toISOString(),
  })
})

// Session Start endpoint (REST)
app.post('/session/start', async (c) => {
  const auth = await validateApiKey(c.req.raw, c.env)
  if (!auth.valid) return c.json({ error: auth.error }, 401)
  
  const sessionData = await c.req.json() as any
  return c.json({ 
    session_id: `sess_${Math.random().toString(36).substr(2, 9)}`,
    status: 'active',
    repo: sessionData.repo,
    mission_brief: 'Refined Phase 6 objectives loaded. SOLID and Clean Architecture enforced.',
  })
})

// Root endpoint — server info
app.get('/', (c) => {
  return c.json({
    name: 'Cortex Hub MCP Server',
    version: c.env.MCP_SERVER_VERSION ?? '0.1.0',
    mcp: '/mcp',
    health: '/health',
    tools: [
      'cortex.health',
      'cortex.memory.store',
      'cortex.memory.search',
      'cortex.knowledge.search',
      'cortex.code.search',
      'cortex.code.impact',
      'cortex.quality.report',
      'cortex.session.start'
    ],
  })
})

// MCP endpoint — requires auth
app.all('/mcp', (c) => {
  const url = new URL(c.req.url)
  if (!url.pathname.endsWith('/')) {
    return c.redirect(url.pathname + '/')
  }
  return c.notFound()
})

app.all('/mcp/*', async (c) => {
  // Validate API key
  const auth = await validateApiKey(c.req.raw, c.env)
  if (!auth.valid) {
    return c.json({ error: auth.error }, 401)
  }

  // Create stateless MCP Server
  const server = new McpServer({
    name: c.env.MCP_SERVER_NAME ?? 'cortex-hub',
    version: c.env.MCP_SERVER_VERSION ?? '0.1.0',
  })

  // Register tools
  registerHealthTools(server, c.env)
  registerMemoryTools(server, c.env)
  registerKnowledgeTools(server, c.env)
  registerCodeTools(server, c.env)
  registerQualityTools(server, c.env)
  registerSessionTools(server, c.env)

  // Implement the MCP handler logic directly for Node.js
  try {
    const request = await c.req.json()
    // The McpServer class in @modelcontextprotocol/sdk/server/mcp.js 
    // uses server.server.handleMessage(request) for the underlying JSON-RPC
    const result = await (server as any).server.handleMessage(request)
    return c.json(result)
  } catch (error: any) {
    return c.json({ 
      jsonrpc: '2.0', 
      error: { code: -32603, message: error.message },
      id: null 
    }, 500)
  }
})

export default app
