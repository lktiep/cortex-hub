import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'

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

// ─── MCP Streamable HTTP handler ───────────────────────────────────
// Supports both GET (SSE stream) and POST (JSON-RPC) as required by
// the MCP Streamable HTTP transport spec. This is what mcp-remote expects.
//
// Stateless mode: each request gets a fresh transport + server.
// enableJsonResponse: true allows simple request/response without SSE.
app.all('/mcp', async (c) => {
  // Validate API key
  const auth = await validateApiKey(c.req.raw, c.env)
  if (!auth.valid) {
    return c.json({ error: auth.error }, 401)
  }

  const mcpServer = createMcpServer(c.env)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
    enableJsonResponse: true,
  })

  await mcpServer.connect(transport)

  try {
    const response = await transport.handleRequest(c.req.raw)
    return response
  } catch (error: any) {
    console.error('[MCP Streamable Error]', error)
    return c.json({
      jsonrpc: '2.0',
      error: { code: -32603, message: error.message || 'Internal error' },
      id: null,
    }, 500)
  }
})

// Catch-all for other POST paths (legacy compat)
app.post('/*', async (c) => {
  // Validate API key
  const auth = await validateApiKey(c.req.raw, c.env)
  if (!auth.valid) {
    return c.json({ error: auth.error }, 401)
  }

  const mcpServer = createMcpServer(c.env)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })

  await mcpServer.connect(transport)

  try {
    const response = await transport.handleRequest(c.req.raw)
    return response
  } catch (error: any) {
    console.error('[MCP Handler Error]', error)
    return c.json({
      jsonrpc: '2.0',
      error: { code: -32603, message: error.message || 'Internal error' },
      id: null,
    }, 500)
  }
})

export default app
