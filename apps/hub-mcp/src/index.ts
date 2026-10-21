import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'

import { allowedToolNames, MCP_TOOL_PERMISSIONS, publicOrigin, toolNameForPermission } from '@cortex/shared-types'
import { registerAllTools } from './tools/index.js'
import { createPlan, treePlan } from './tools/conductor-lead.js'
import { validateApiKey, invalidateTokenCache } from './middleware/auth.js'
import { telemetryStorage } from './api-call.js'
import { appendHintBlocks, canAppendHints, noteLines, type FileNote } from './hint-blocks.js'
import { claimTreeUpload, MAX_TREE_UPLOAD_BYTES, releaseTreeUpload } from './tree-upload.js'
import type { Env } from './types.js'



const app = new Hono<{ Bindings: Env }>()

// Bridge process.env → c.env for Node.js runtime
// (In Cloudflare Workers, c.env is auto-populated from wrangler bindings.
//  In Node.js, c.env is empty — this middleware fills it from process.env.)
app.use('*', async (c, next) => {
  const envKeys: (keyof Env)[] = [
    'QDRANT_URL', 'CLIPROXY_URL',
    'DASHBOARD_API_URL', 'MCP_SERVER_NAME', 'MCP_SERVER_VERSION', 'API_KEYS',
    'INTERNAL_API_SECRET',
  ]
  for (const key of envKeys) {
    if (!c.env[key] && process.env[key]) {
      ;(c.env as unknown as Record<string, string>)[key] = process.env[key]!
    }
  }
  await next()
})

// MCP server requires open CORS — agents connect from any IDE/origin
// Security is enforced via API key auth, not CORS
app.use('*', cors())
// An upload link is a credential until it is used: keep it out of the access log
app.use('*', logger((line, ...rest) => console.log(line.replace(/\/tree-upload\/[^\s/?]+/g, '/tree-upload/<token>'), ...rest)))

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

// Auth cache invalidation endpoint
app.post('/auth/cache/invalidate', async (c) => {
  const secret = c.env.INTERNAL_API_SECRET || process.env.INTERNAL_API_SECRET
  if (!secret) {
    return c.json({ error: 'Service unavailable: INTERNAL_API_SECRET not configured' }, 503)
  }
  const requestSecret = c.req.header('X-Internal-Secret')
  if (requestSecret !== secret) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  let token: string | undefined = undefined
  try {
    const body = await c.req.json()
    token = body.token
  } catch {
    // If JSON parsing fails or is empty, we will clear the entire cache
  }
  invalidateTokenCache(token)
  return c.json({ success: true, message: token ? 'Token invalidated' : 'Cache cleared' })
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
    resource_documentation: 'https://github.com/lktiep/cortex-hub',
  })
})

// Fallback: root-level Protected Resource Metadata
app.get('/.well-known/oauth-protected-resource', (c) => {
  return c.json({
    resource: c.req.url.replace('/.well-known/oauth-protected-resource', '/'),
    bearer_methods_supported: ['header'],
    resource_documentation: 'https://github.com/lktiep/cortex-hub',
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
    tools: MCP_TOOL_PERMISSIONS.map((p) => toolNameForPermission(p.id)),
  })
})

// Helper: create MCP server with tools registered
function createMcpServer(env: Env, permissions?: string[]) {
  const server = new McpServer({
    name: env.MCP_SERVER_NAME ?? 'cortex-hub',
    version: env.MCP_SERVER_VERSION ?? '0.1.0',
  })

  // A key's permissions name tools with dots for underscores; '*' lets every tool through.
  const allowedTools = allowedToolNames(permissions)

  // Wrap server.tool to filter out unauthorized tools
  const originalTool = server.tool.bind(server)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const serverAny = server as any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same untyped overloads as serverAny above
  serverAny.tool = (name: string, description: string, schema: any, handler: any) => {
    if (allowedTools && !allowedTools.has(name)) {
      return {
        name,
        description,
        inputSchema: schema,
        handler,
        enabled: false,
        enable: () => {},
        disable: () => {},
      }
    }
    return originalTool(name, description, schema, handler)
  }

  registerAllTools(server, env)
  return server
}

/** How often an idle SSE stream says something, so a proxy does not reap it. */
const SSE_KEEPALIVE_MS = 25_000

/**
 * Make the standalone SSE stream say something immediately, and keep saying it.
 *
 * The stream carries nothing until the server has a message to push, so the
 * response is headers and no body bytes — which is fine over a direct connection
 * and fatal through a proxy. The proxy in front of this server withholds the
 * response headers until the first body byte arrives, so the client never sees
 * the stream open and reports the connection closed, even though the origin
 * answered 200 the moment it was asked. A direct request to the container gets
 * its headers in 8ms; the same request through the tunnel times out with zero
 * bytes received, while an unauthorized GET (which has a body) comes back through
 * the same tunnel in 300ms.
 *
 * A line starting with `:` is an SSE comment and every conformant client ignores
 * it, so one on connect is a byte that costs nothing, and one every 25s keeps an
 * idle stream from being dropped by an idle timeout.
 */
function withFirstByte(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const reader = body.getReader()
  let keepAlive: ReturnType<typeof setInterval> | undefined

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(': open\n\n'))

      keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': ping\n\n'))
        } catch {
          // The stream is already closed; the pump's finally clears the timer.
        }
      }, SSE_KEEPALIVE_MS)

      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            controller.enqueue(value)
          }
          controller.close()
        } catch (err) {
          controller.error(err)
        } finally {
          if (keepAlive) clearInterval(keepAlive)
        }
      })()
    },
    cancel(reason) {
      if (keepAlive) clearInterval(keepAlive)
      return reader.cancel(reason)
    },
  })
}

// ─── MCP Streamable HTTP handler ───────────────────────────────────
// Supports both GET (SSE stream) and POST (JSON-RPC) as required by
// the MCP Streamable HTTP transport spec. This is what mcp-remote expects.
//
// Stateless mode: each request gets a fresh transport + server.
// enableJsonResponse: true allows simple request/response without SSE.
app.all('/mcp', async (c) => {
  // ─── Auth: STRICT enforcement ──────────────────────────────────
  // ALL HTTP requests to /mcp MUST provide a valid Bearer token.
  // Inter-service calls (dashboard-api → hub-mcp) use in-memory
  // setInternalFetch() and never hit this HTTP endpoint.
  const envWithOwner = { ...c.env } as Env & { API_KEY_OWNER?: string }
  let permissions: string[] | undefined = undefined

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
    if (authResult.permissions) {
      permissions = authResult.permissions
    }
    // Links a tool hands out point back at the address this agent reached us on
    envWithOwner.PUBLIC_ORIGIN = publicOrigin((name) => c.req.header(name)) ?? new URL(c.req.url).origin
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

  const mcpServer = createMcpServer(envWithOwner, permissions)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
    enableJsonResponse: true,
  })

  await mcpServer.connect(transport)

  const startTime = Date.now()
  let bodyText = ''
  try {
    bodyText = await c.req.text()
  } catch { /* no body */ }

  const reqInit: RequestInit = {
    method: c.req.raw.method,
    headers: c.req.raw.headers,
  }
  if (c.req.raw.method !== 'GET' && c.req.raw.method !== 'HEAD') {
    reqInit.body = bodyText
  }
  const newReq = new Request(c.req.raw.url, reqInit)

  let toolName = 'unknown'
  let projectId = null
  let argsObj = null
  try {
    const p = JSON.parse(bodyText)
    if (p.method === 'tools/call') {
      toolName = p.params?.name
      argsObj = p.params?.arguments
      projectId = argsObj?.projectId || argsObj?.project_id || null
      
      const rawRepo = argsObj?.repo || null
      if (rawRepo) {
        projectId = rawRepo.replace(/\.git$/, '').replace(/^https?:\/\/.*\//, '').split(/[/\\]/).pop() || rawRepo
      }
    }
  } catch { /* not a JSON-RPC body: logged as tool 'unknown' */ }

  try {
    const response = await telemetryStorage.run({ computeTokens: 0, computeModel: null }, async () => {
      const res = await transport.handleRequest(newReq)
      const latencyMs = Date.now() - startTime
      const inputSize = bodyText.length

      // Reading the body is how telemetry sizes the answer and how hints get
      // appended to it. A GET /mcp answers with the standalone SSE stream, whose
      // body only ends when the connection does, so awaiting text() on it never
      // returns: the response never leaves this handler, the client receives no
      // headers at all, and it reports the connection as closed. Size the
      // buffered JSON responses and hand a live stream straight back.
      const isEventStream = res.headers.get('content-type')?.includes('text/event-stream') ?? false

      // Nothing below this applies to a stream: a GET carries no JSON-RPC call, so
      // there is no tool to log and no answer to append hints to. Hand it back
      // with a first byte in front of it and stay out of the way.
      if (isEventStream && res.body) {
        return new Response(withFirstByte(res.body), {
          status: res.status,
          headers: res.headers,
        })
      }

      let outputSize = 0
      let respBody = ''
      if (!isEventStream) {
        try {
          const cloned = res.clone()
          respBody = await cloned.text()
          outputSize = respBody.length
        } catch { /* ignore clone failures */ }
      }

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
        }).catch((err: unknown) => console.error('[MCP Telemetry Error]', err))
      }

      // cortex_file_notes answers JSON its callers parse, so nothing is appended to it.
      if (toolName !== 'unknown' && toolName !== 'cortex_health' && toolName !== 'cortex_file_notes' && agentId !== 'unknown') {
        try {
          // Parse first: the hints endpoint marks conductor notices delivered, so it must only be
          // asked when this body can carry them.
          const parsed: unknown = respBody ? JSON.parse(respBody) : null
          if (canAppendHints(parsed)) {
            const lastItem = parsed.result.content.at(-1)!
            const [hintsData, notes] = await Promise.all([
              fetch(
                `${apiUrl}/api/metrics/hints/${encodeURIComponent(agentId)}?currentTool=${encodeURIComponent(toolName)}`,
                { signal: AbortSignal.timeout(2000) }
              )
                .then(async (r) => (r.ok ? ((await r.json()) as { hints?: string[]; conductor?: string[] }) : {}))
                .catch(() => ({} as { hints?: string[]; conductor?: string[] })),
              NOTE_TOOLS.has(toolName)
                ? fileNotesNamedIn(apiUrl, agentId, argsObj, parsed.result.content.map((i) => (typeof i.text === 'string' ? i.text : '')).join('\n'))
                : Promise.resolve([]),
            ])
            const hints = hintsData.hints ?? []
            const conductor = hintsData.conductor ?? []
            if (hints.length > 0 || conductor.length > 0 || notes.length > 0) {
              lastItem.text = appendHintBlocks(lastItem.text, hints, conductor, notes)
              return new Response(JSON.stringify(parsed), {
                status: res.status,
                headers: res.headers,
              })
            }
          }
        } catch { /* body not JSON */ }
      }

      return res
    })

    return response
  } catch (error) {
    console.error('[MCP Streamable Error]', error)
    const message = error instanceof Error ? error.message : String(error)
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
          error: message,
          latencyMs,
          projectId,
          inputSize: bodyText.length,
          outputSize: 0,
        })
      }).catch((err: unknown) => console.error('[MCP Telemetry Error]', err))
    }

    return c.json({
      jsonrpc: '2.0',
      error: { code: -32603, message: message || 'Internal error' },
      id: null,
    }, 500)
  }
})

// ─── Plan upload: the file behind cortex_task_tree_create(upload: true) ─────
// No API key here: the one-time token from the tool call is the credential, and the tree is
// created as the agent that asked for it (see tree-upload.ts). Answers are plain text, the
// same lines the tool would have returned, so curl prints them as they are.
const PLAN_TOO_BIG = `The file is over ${MAX_TREE_UPLOAD_BYTES / 1024 / 1024} MiB. Split the plan: create the first part, then upload the rest with parentId set to one of its tasks.`

app.post('/tree-upload/:token', bodyLimit({ maxSize: MAX_TREE_UPLOAD_BYTES, onError: (c) => c.text(PLAN_TOO_BIG, 413) }), async (c) => {
  const token = c.req.param('token')
  const claim = claimTreeUpload(token)
  if (!claim.ok) return c.text(claim.error, claim.status)

  let created = false
  try {
    let raw: unknown
    try {
      raw = JSON.parse(await c.req.text())
    } catch (err) {
      if (err instanceof Error && err.name === 'BodyLimitError') return c.text(PLAN_TOO_BIG, 413)
      return c.text(`The file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, 400)
    }

    const parsed = treePlan.safeParse(raw)
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 10).map((i) => `- ${i.path.join('.') || '(file)'}: ${i.message}`)
      return c.text(['The file does not match the plan schema:', ...issues].join('\n'), 400)
    }

    const result = await createPlan({ ...c.env, API_KEY_OWNER: claim.owner }, parsed.data)
    created = result.ok
    // A 5xx is the hub failing, not this gateway: report it as a bad gateway
    const status = (result.ok ? 201 : result.status >= 500 ? 502 : result.status) as ContentfulStatusCode
    return c.text(result.text, status)
  } catch (err) {
    return c.text(`Plan creation failed: ${err instanceof Error ? err.message : String(err)}`, 502)
  } finally {
    releaseTreeUpload(token, created)
  }
})

/** Code lookups whose answers name files: the notes linked to those files are appended to them. */
const NOTE_TOOLS = new Set(['cortex_code_search', 'cortex_code_context', 'cortex_code_impact', 'cortex_detect_changes'])

/** Note lines for the linked files a tool answer names; none when the hub is slow or has none. */
async function fileNotesNamedIn(apiUrl: string, owner: string, args: unknown, text: string): Promise<string[]> {
  const a = (args ?? {}) as { repo?: unknown; projectId?: unknown }
  try {
    const res = await fetch(`${apiUrl}/api/knowledge/file-notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key-Owner': owner },
      body: JSON.stringify({
        repo: typeof a.repo === 'string' ? a.repo : undefined,
        projectId: typeof a.projectId === 'string' ? a.projectId : undefined,
        text,
      }),
      signal: AbortSignal.timeout(1500),
    })
    if (!res.ok) return []
    const data = (await res.json()) as { notes?: Record<string, FileNote[]> }
    return noteLines(data.notes ?? {})
  } catch {
    return []
  }
}

export default app
