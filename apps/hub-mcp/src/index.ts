import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createMcpHandler } from 'agents/mcp'

import { registerHealthTools } from './tools/health'
import { registerMemoryTools } from './tools/memory'
import { registerKnowledgeTools } from './tools/knowledge'
import { registerCodeTools } from './tools/code'
import { registerQualityTools } from './tools/quality'
import { validateApiKey } from './middleware/auth'

/**
 * Cortex Hub MCP Server
 *
 * A stateless Cloudflare Worker that exposes MCP tools for:
 * - Service health monitoring
 * - Agent memory (store + search via mem0)
 * - Code intelligence (future: GitNexus proxy)
 *
 * Architecture: createMcpHandler() → stateless, no Durable Objects.
 * Deployed to: mcp.hub.jackle.dev
 */



export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    // Health endpoint (no auth required)
    if (url.pathname === '/health') {
      return new Response(
        JSON.stringify({
          status: 'healthy',
          service: 'hub-mcp',
          version: env.MCP_SERVER_VERSION ?? '0.1.0',
          timestamp: new Date().toISOString(),
        }),
        { headers: { 'Content-Type': 'application/json' } }
      )
    }

    // Root endpoint — server info
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(
        JSON.stringify({
          name: 'Cortex Hub MCP Server',
          version: env.MCP_SERVER_VERSION ?? '0.1.0',
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
        }),
        { headers: { 'Content-Type': 'application/json' } }
      )
    }

    // MCP endpoint — requires auth
    if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) {
      // Validate API key
      const auth = await validateApiKey(request, env)
      if (!auth.valid) {
        return new Response(
          JSON.stringify({ error: auth.error }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        )
      }

      // Create stateless MCP Server & Handler for this request
      const server = new McpServer({
        name: env.MCP_SERVER_NAME ?? 'cortex-hub',
        version: env.MCP_SERVER_VERSION ?? '0.1.0',
      })

      // Register tools
      registerHealthTools(server, env)
      registerMemoryTools(server, env)
      registerKnowledgeTools(server, env)
      registerCodeTools(server, env)
      registerQualityTools(server, env)

      const mcpHandler = createMcpHandler(server as any)
      return mcpHandler(request, env, ctx)
    }

    // 404 for any unmatched routes
    return new Response(
      JSON.stringify({ error: 'Not found', available: ['/', '/health', '/mcp'] }),
      { status: 404, headers: { 'Content-Type': 'application/json' } }
    )
  },
}
