import { z } from 'zod'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../types.js'

/**
 * Register health check tool.
 * Pings all backend services and returns their status.
 * Skips services with undefined/empty URLs.
 */
export function registerHealthTools(server: McpServer, env: Env) {
  server.tool(
    'cortex_health',
    'Check health status of all Cortex Hub backend services',
    {},
    async () => {
      const apiUrl = env.DASHBOARD_API_URL || 'http://localhost:4000'

      // Build service list, skipping undefined/empty URLs
      const services: Array<{ name: string; url: string }> = [
        { name: 'qdrant', url: `${env.QDRANT_URL}/healthz` },
        { name: 'dashboard-api', url: `${apiUrl}/health` },
        { name: 'mem9', url: `${apiUrl}/api/mem9/health` },
      ]

      // Only add optional services if configured
      if (env.CLIPROXY_URL) {
        services.push({ name: 'cliproxy', url: `${env.CLIPROXY_URL}/v1/models` })
      }
      if (env.NEO4J_URL) {
        services.push({ name: 'neo4j', url: env.NEO4J_URL })
      }

      const results = await Promise.allSettled(
        services.map(async (svc) => {
          const start = Date.now()
          try {
            const res = await fetch(svc.url, { signal: AbortSignal.timeout(5000) })
            return {
              name: svc.name,
              status: res.ok ? 'healthy' : 'unhealthy',
              statusCode: res.status,
              latencyMs: Date.now() - start,
            }
          } catch (error) {
            return {
              name: svc.name,
              status: 'unreachable',
              error: error instanceof Error ? error.message : 'Unknown error',
              latencyMs: Date.now() - start,
            }
          }
        })
      )

      const statuses = results.map((r) =>
        r.status === 'fulfilled' ? r.value : { name: 'unknown', status: 'error' }
      )

      const allHealthy = statuses.every((s) => s.status === 'healthy')

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                overall: allHealthy ? 'healthy' : 'degraded',
                services: statuses,
                checkedAt: new Date().toISOString(),
              },
              null,
              2
            ),
          },
        ],
      }
    }
  )
}
