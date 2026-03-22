import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'

import { registerCodeTools } from './tools/code.js'
import { registerHealthTools } from './tools/health.js'
import { registerIndexingTools } from './tools/indexing.js'
import { registerKnowledgeTools } from './tools/knowledge.js'
import { registerMemoryTools } from './tools/memory.js'
import { registerQualityTools } from './tools/quality.js'
import { registerSessionTools } from './tools/session.js'
import { validateApiKey } from './middleware/auth.js'
import type { Env } from './types.js'

// Re-export for dashboard-api to inject internal fetch
export { setInternalFetch } from './api-call.js'

const app = new Hono<{ Bindings: Env }>()

// Bridge process.env → c.env for Node.js runtime
// (In Cloudflare Workers, c.env is auto-populated from wrangler bindings.
//  In Node.js, c.env is empty — this middleware fills it from process.env.)
app.use('*', async (c, next) => {
  const envKeys: (keyof Env)[] = [
    'QDRANT_URL', 'NEO4J_URL', 'CLIPROXY_URL',
    'DASHBOARD_API_URL', 'MCP_SERVER_NAME', 'MCP_SERVER_VERSION', 'API_KEYS',
  ]
  for (const key of envKeys) {
    if (!c.env[key] && process.env[key]) {
      ;(c.env as unknown as Record<string, string>)[key] = process.env[key]!
    }
  }
  await next()
})

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

// Session Start endpoint (REST — proxies to dashboard-api for real data)
app.post('/session/start', async (c) => {
  const auth = await validateApiKey(c.req.raw, c.env)
  if (!auth.valid) return c.json({ error: auth.error }, 401)
  
  try {
    const sessionData = await c.req.json()
    const apiUrl = c.env.DASHBOARD_API_URL || 'http://localhost:4000'
    const response = await fetch(`${apiUrl}/api/sessions/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessionData),
      signal: AbortSignal.timeout(10000),
    })
    const result = await response.json()
    return c.json(result, response.ok ? 200 : 500)
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// Root endpoint — server info
app.get('/', (c) => {
  return c.json({
    name: 'Cortex Hub MCP Server',
    version: c.env.MCP_SERVER_VERSION ?? '0.1.0',
    mcp: '/mcp',
    health: '/health',
    tools: [
      'cortex_health',
      'cortex_memory_store',
      'cortex_memory_search',
      'cortex_knowledge_search',
      'cortex_code_search',
      'cortex_code_impact',
      'cortex_code_reindex',
      'cortex_quality_report',
      'cortex_session_start'
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
  registerIndexingTools(server, env)
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
