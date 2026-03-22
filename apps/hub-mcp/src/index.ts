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

// Global error handler — return JSON instead of text/plain
app.onError((err, c) => {
  console.error('[MCP Global Error]', err.message, err.stack)
  return c.json({
    jsonrpc: '2.0',
    error: { code: -32603, message: err.message },
    id: null,
  }, 500)
})

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
    
    // McpServer wraps an internal Server instance
    const innerServer = (server as any).server
    
    // Promise-based transport: resolves when send() is called
    let resolveSend: (msg: any) => void
    let sendPromise = new Promise<any>((resolve) => { resolveSend = resolve })
    
    const transport = {
      start: async () => {},
      close: async () => {},
      send: async (message: any) => { resolveSend!(message) },
      onmessage: null as any,
      onerror: null as any,
      onclose: null as any,
      sessionId: undefined as string | undefined,
    }
    
    await innerServer.connect(transport)
    
    // Auto-initialize: MCP SDK requires handshake before accepting requests
    if (transport.onmessage) {
      transport.onmessage({
        jsonrpc: '2.0',
        id: '__init__',
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'cortex-http-client', version: '1.0.0' },
        },
      })
    }
    
    // Wait for initialize response
    await sendPromise
    
    // Reset Promise for next message
    sendPromise = new Promise<any>((resolve) => { resolveSend = resolve })
    
    // Send initialized notification (no response expected)
    if (transport.onmessage) {
      transport.onmessage({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      })
    }
    
    // Small delay to let notification process
    await new Promise(r => setTimeout(r, 10))
    
    // Reset Promise for the actual client request
    sendPromise = new Promise<any>((resolve) => { resolveSend = resolve })
    
    // Dispatch the actual client request
    if (transport.onmessage) {
      transport.onmessage(body)
    }
    
    // Wait for response with timeout
    const result = await Promise.race([
      sendPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('MCP handler timeout (10s)')), 10000))
    ])
    
    return c.json(result)
  } catch (error: any) {
    console.error('[MCP Handler Error]', error)
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
