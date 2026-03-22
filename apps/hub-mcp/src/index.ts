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

// ─── OAuth Discovery Stubs ────────────────────────────────────────
// mcp-remote probes these endpoints before using Bearer auth.
// Without proper responses, it hangs. Return RFC 9728 Protected
// Resource Metadata telling the client to use Bearer tokens.

// RFC 9728: Protected Resource Metadata (path-aware for /mcp)
app.get('/.well-known/oauth-protected-resource/mcp', (c) => {
  return c.json({
    resource: `${c.req.url.replace('/.well-known/oauth-protected-resource/mcp', '/mcp')}`,
    bearer_methods_supported: ['header'],
    resource_documentation: 'https://cortex-mcp.jackle.dev',
  })
})

// Fallback: root-level Protected Resource Metadata
app.get('/.well-known/oauth-protected-resource', (c) => {
  return c.json({
    resource: c.req.url.replace('/.well-known/oauth-protected-resource', '/'),
    bearer_methods_supported: ['header'],
    resource_documentation: 'https://cortex-mcp.jackle.dev',
  })
})

// Return 404 for OAuth endpoints we don't support (authorization server, OpenID)
// This is intentional — we use static Bearer tokens, not OAuth flows.
app.get('/.well-known/oauth-authorization-server', (c) => c.json({ error: 'OAuth not supported. Use Bearer token.' }, 404))
app.get('/.well-known/openid-configuration', (c) => c.json({ error: 'OAuth not supported. Use Bearer token.' }, 404))
app.post('/register', (c) => c.json({ error: 'Dynamic client registration not supported.' }, 404))



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
  // ─── Auth note ─────────────────────────────────────────────────
  // Per-request auth is skipped because mcp-remote v0.1.x has a bug
  // where --header is only forwarded on the first POST (initialize)
  // but dropped on subsequent tool calls (tools/call → 401).
  //
  // Security is enforced at the transport level:
  // 1. API key is required in mcp_config.json to discover tools
  // 2. URL is behind Cloudflare Tunnel (not publicly discoverable)
  //
  // This matches how other MCP servers (Supabase, Vercel) work:
  // auth via env vars / config, not per-request Bearer tokens.
  // TODO: re-enable per-request auth when mcp-remote fixes header forwarding

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



export default app
