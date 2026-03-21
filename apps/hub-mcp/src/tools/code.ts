import { z } from 'zod'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../types.js'

/**
 * Register code intelligence tools.
 * Proxies AST graph, impact analysis, and code search requests to the Dashboard API
 * which routes them natively to the GitNexus backend on the server.
 * Supports project + branch scoping for multi-branch knowledge.
 */
export function registerCodeTools(server: McpServer, env: Env) {
  // code.search — query codebase concepts and workflows
  server.tool(
    'cortex.code.search',
    'Query the codebase for architecture concepts, execution flows, and file matches using GitNexus hybrid vector/AST search. Use projectId to scope to a specific project.',
    {
      query: z.string().describe('Natural language or code query to search for'),
      projectId: z.string().optional().describe('Project ID to scope search to'),
      branch: z.string().optional().describe('Git branch to search (uses the indexed branch data)'),
      limit: z.number().optional().describe('Maximum flows to return (default: 5)'),
    },
    async ({ query, projectId, branch, limit }) => {
      try {
        const response = await fetch(`${env.DASHBOARD_API_URL}/api/intel/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query,
            projectId,
            branch,
            limit: limit ?? 5,
          }),
          signal: AbortSignal.timeout(10000),
        })

        if (!response.ok) {
          const errorText = await response.text()
          return {
            content: [
              {
                type: 'text' as const,
                text: `Code search failed: ${response.status} ${errorText}`,
              },
            ],
            isError: true,
          }
        }

        const data = await response.json()
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(data, null, 2),
            },
          ],
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Code search error: ${error instanceof Error ? error.message : 'Unknown'}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // code.impact — calculate blast radius for code changes
  server.tool(
    'cortex.code.impact',
    'Analyze the blast radius of changing a specific symbol (function, class, file) to verify downstream impact before making edits.',
    {
      target: z.string().describe('The name of the function, class, or file to analyze'),
      projectId: z.string().optional().describe('Project ID to scope analysis to'),
      branch: z.string().optional().describe('Git branch to analyze'),
      direction: z.enum(['upstream', 'downstream']).optional().describe('Direction to analyze (default: downstream)'),
    },
    async ({ target, projectId, branch, direction }) => {
      try {
        const response = await fetch(`${env.DASHBOARD_API_URL}/api/intel/impact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            target,
            projectId,
            branch,
            direction: direction ?? 'downstream',
          }),
          signal: AbortSignal.timeout(10000),
        })

        if (!response.ok) {
          const errorText = await response.text()
          return {
            content: [
              {
                type: 'text' as const,
                text: `Impact analysis failed: ${response.status} ${errorText}`,
              },
            ],
            isError: true,
          }
        }

        const data = await response.json()
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(data, null, 2),
            },
          ],
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Impact analysis error: ${error instanceof Error ? error.message : 'Unknown'}`,
            },
          ],
          isError: true,
        }
      }
    }
  )
}
