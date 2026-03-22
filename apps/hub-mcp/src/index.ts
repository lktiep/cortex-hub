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

// Helper: create MCP server with tools registered
function createMcpServer(env: Env) {
  const server = new McpServer({
    name: env.MCP_SERVER_NAME ?? 'cortex-hub',
    version: env.MCP_SERVER_VERSION ?? '0.1.0',
  })
  registerHealthTools(server, env)
  registerMemoryTools(server, env)
  registerKnowledgeTools(server, env)
  registerCodeTools(server, env)
  registerQualityTools(server, env)
  registerSessionTools(server, env)
  return server
}



// MCP Stateless JSON-RPC handler
// Uses a fresh server per request (stateless mode)
// Routes are relative — mounted at /mcp in dashboard-api → effective path: /mcp/
app.post('/*', async (c) => {
  // Validate API key
  const auth = await validateApiKey(c.req.raw, c.env)
  if (!auth.valid) {
    return c.json({ error: auth.error }, 401)
  }

  const server = createMcpServer(c.env)

  try {
    const body = await c.req.json()
    
    // Handle JSON-RPC directly via the internal Server instance
    // McpServer wraps a Server at .server which has ._handleMessage()
    const innerServer = (server as any).server
    
    // The SDK's Server needs to be connected to process messages
    // We create a minimal in-memory transport
    const responsePromise = new Promise<any>((resolve) => {
      const transport = {
        start: async () => {},
        close: async () => {},
        send: async (message: any) => { resolve(message) },
        onmessage: null as any,
        onerror: null as any,
        onclose: null as any,
        sessionId: undefined as string | undefined,
      }
      
      innerServer.connect(transport).then(() => {
        // Once connected, dispatch the message
        if (transport.onmessage) {
          transport.onmessage(body)
        }
      })
    })

    const result = await Promise.race([
      responsePromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('MCP handler timeout')), 10000))
    ])

    return c.json(result)
  } catch (error: any) {
    return c.json({ 
      jsonrpc: '2.0', 
      error: { code: -32603, message: error.message || 'Internal error' },
      id: null 
    }, 500)
  }
})

// Handle GET requests (SSE not supported in stateless mode)
app.get('/*', (c) => {
  return c.json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'SSE not supported. Use POST for JSON-RPC requests.' },
    id: null,
  }, 405)
})

export default app
