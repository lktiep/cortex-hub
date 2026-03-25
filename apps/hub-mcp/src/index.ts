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
import { registerChangeTools } from './tools/changes.js'
import { registerAnalyticsTools } from './tools/analytics.js'
import { validateApiKey } from './middleware/auth.js'
import { telemetryStorage } from './api-call.js'
import type { Env } from './types.js'



const app = new Hono<{ Bindings: Env }>()

// Bridge process.env → c.env for Node.js runtime
// (In Cloudflare Workers, c.env is auto-populated from wrangler bindings.
//  In Node.js, c.env is empty — this middleware fills it from process.env.)
app.use('*', async (c, next) => {
  const envKeys: (keyof Env)[] = [
    'QDRANT_URL', 'CLIPROXY_URL',
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
      'cortex_knowledge_store',
      'cortex_knowledge_search',
      'cortex_code_search',
      'cortex_code_impact',
      'cortex_code_context',
      'cortex_code_reindex',
      'cortex_list_repos',
      'cortex_cypher',
      'cortex_detect_changes',
      'cortex_quality_report',
      'cortex_session_start',
      'cortex_session_end',
      'cortex_changes',
      'cortex_plan_quality',
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
  registerChangeTools(server, env)
  registerAnalyticsTools(server, env)
  return server
}

// ─── MCP Streamable HTTP handler ───────────────────────────────────
// Supports both GET (SSE stream) and POST (JSON-RPC) as required by
// the MCP Streamable HTTP transport spec. This is what mcp-remote expects.
//
// Stateless mode: each request gets a fresh transport + server.
// enableJsonResponse: true allows simple request/response without SSE.
app.all('/mcp', async (c) => {
  // ─── Auth: STRICT enforcement ──────────────────────────────────
  // All requests MUST provide a valid Bearer token (API key).
  // Internal Docker-network requests bypass auth for inter-service calls.
  const envWithOwner = { ...c.env } as Env & { API_KEY_OWNER?: string }

  // Check if request is from internal Docker network (inter-service)
  const forwardedFor = c.req.header('x-forwarded-for') ?? ''
  const realIp = c.req.header('x-real-ip') ?? ''
  const isInternal = !forwardedFor && !realIp // No proxy headers = direct Docker network call

  if (!isInternal) {
    // External request — MUST have valid API key
    try {
      const authResult = await validateApiKey(c.req.raw, c.env)
      if (!authResult.valid) {
        return c.json({
          jsonrpc: '2.0',
          error: {
            code: -32001,
            message: `Unauthorized: ${authResult.error || 'Invalid API key'}. Get a key from the Dashboard → API Keys.`,
          },
          id: null,
        }, 401)
      }
      if (authResult.agentId) {
        envWithOwner.API_KEY_OWNER = authResult.agentId
      }
    } catch (err) {
      return c.json({
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: `Auth service unavailable: ${String(err)}`,
        },
        id: null,
      }, 503)
    }
  } else {
    // Internal request — attempt non-blocking identity resolution
    try {
      const authResult = await validateApiKey(c.req.raw, c.env)
      if (authResult.valid && authResult.agentId) {
        envWithOwner.API_KEY_OWNER = authResult.agentId
      }
    } catch {
      // Internal calls proceed without auth
    }
  }

  const mcpServer = createMcpServer(envWithOwner)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
    enableJsonResponse: true,
  })

  await mcpServer.connect(transport)

  const startTime = Date.now()
  let bodyText = ''
  try {
    bodyText = await c.req.text()
  } catch (e) {}

  const newReq = new Request(c.req.raw.url, {
    method: c.req.raw.method,
    headers: c.req.raw.headers,
    body: bodyText,
  })

  let toolName = 'unknown'
  let projectId = null
  let argsObj = null
  try {
    const p = JSON.parse(bodyText)
    if (p.method === 'tools/call') {
      toolName = p.params?.name
      argsObj = p.params?.arguments
      projectId = argsObj?.projectId || argsObj?.project_id || null
      if (toolName === 'cortex_session_start' && argsObj?.repo) {
        projectId = argsObj.repo.split('/').pop()?.replace('.git', '') || null
      }
    }
  } catch (e) {}

  try {
    const response = await telemetryStorage.run({ computeTokens: 0, computeModel: null }, async () => {
      const res = await transport.handleRequest(newReq)
      const latencyMs = Date.now() - startTime
      const inputSize = bodyText.length

      let outputSize = 0
      let respBody = ''
      try {
        const cloned = res.clone()
        respBody = await cloned.text()
        outputSize = respBody.length
      } catch { /* ignore clone failures */ }

      const store = telemetryStorage.getStore()
      const computeTokens = store?.computeTokens || 0
      const computeModel = store?.computeModel || null

      const apiUrl = (c.env.DASHBOARD_API_URL || 'http://localhost:4000').replace(/\/$/, '')
      const agentId = envWithOwner.API_KEY_OWNER || 'unknown'

      if (toolName !== 'unknown') {
        fetch(`${apiUrl}/api/metrics/query-log`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId,
            tool: toolName,
            params: argsObj,
            status: res.status >= 400 ? 'error' : 'ok',
            latencyMs,
            projectId,
            inputSize,
            outputSize,
            computeTokens,
            computeModel,
          })
        }).catch((err: any) => console.error('[MCP Telemetry Error]', err))
      }

      if (toolName !== 'unknown' && toolName !== 'cortex_health' && agentId !== 'unknown') {
        try {
          const hintsRes = await fetch(
            `${apiUrl}/api/metrics/hints/${encodeURIComponent(agentId)}?currentTool=${encodeURIComponent(toolName)}`,
            { signal: AbortSignal.timeout(2000) }
          )
          if (hintsRes.ok) {
            const hintsData = (await hintsRes.json()) as { hints: string[] }
            if (hintsData.hints.length > 0 && respBody) {
              try {
                const parsed = JSON.parse(respBody)
                if (parsed.result?.content && Array.isArray(parsed.result.content)) {
                  const lastItem = parsed.result.content[parsed.result.content.length - 1]
                  if (lastItem?.type === 'text' && typeof lastItem.text === 'string') {
                    lastItem.text += '\n\n---\n💡 Cortex hints:\n' + hintsData.hints.map((h: string) => `  ${h}`).join('\n')
                  }
                  const modifiedBody = JSON.stringify(parsed)
                  return new Response(modifiedBody, {
                    status: res.status,
                    headers: res.headers,
                  })
                }
              } catch { /* JSON parse failed */ }
            }
          }
        } catch { /* hints fetch failed */ }
      }

      return res
    })

    return response
  } catch (error: any) {
    console.error('[MCP Streamable Error]', error)
    const latencyMs = Date.now() - startTime

    if (toolName !== 'unknown') {
      const apiUrl = (c.env.DASHBOARD_API_URL || 'http://localhost:4000').replace(/\/$/, '')
      fetch(`${apiUrl}/api/metrics/query-log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: envWithOwner.API_KEY_OWNER || 'unknown',
          tool: toolName,
          params: argsObj,
          status: 'error',
          error: error.message,
          latencyMs,
          projectId,
          inputSize: bodyText.length,
          outputSize: 0,
        })
      }).catch((err: any) => console.error('[MCP Telemetry Error]', err))
    }

    return c.json({
      jsonrpc: '2.0',
      error: { code: -32603, message: error.message || 'Internal error' },
      id: null,
    }, 500)
  }
})



export default app
