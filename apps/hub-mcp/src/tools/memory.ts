import { z } from 'zod'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../types.js'

/**
 * Register memory tools.
 * Proxies to dashboard-api mem9 endpoints for agent memory storage and retrieval.
 * Supports branch-scoped knowledge via user_id namespacing:
 *   - project-{id}:branch-{name} → branch-specific memories
 *   - project-{id} → project-level memories (fallback)
 *   - {agentId} → agent-level memories (default)
 */
export function registerMemoryTools(server: McpServer, env: Env) {
  // memory.store — persist a memory for an agent
  server.tool(
    'cortex_memory_store',
    'Store a memory for an AI agent. Memories persist across sessions and can be recalled by semantic search. Use projectId + branch to scope memories to a specific branch.',
    {
      content: z.string().describe('The memory content to store'),
      agentId: z.string().optional().describe('Agent identifier (default: "default")'),
      projectId: z.string().optional().describe('Project ID to scope this memory to'),
      branch: z.string().optional().describe('Git branch to scope this memory to (requires projectId)'),
      metadata: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Optional metadata tags'),
    },
    async ({ content, agentId, projectId, branch, metadata }) => {
      try {
        // Build scoped user_id for branch isolation
        let userId = agentId ?? 'default'
        if (projectId && branch) {
          userId = `project-${projectId}:branch-${branch}`
        } else if (projectId) {
          userId = `project-${projectId}`
        }

        const meta = {
          ...(metadata ?? {}),
          ...(projectId ? { project_id: projectId } : {}),
          ...(branch ? { branch } : {}),
        }

        const apiUrl = env.DASHBOARD_API_URL || 'http://localhost:4000'
        const response = await fetch(`${apiUrl}/api/mem9/store`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [{ role: 'user', content }],
            userId,
            agentId: agentId ?? 'default',
            metadata: meta,
          }),
          signal: AbortSignal.timeout(30000),
        })

        if (!response.ok) {
          const errorText = await response.text()
          return {
            content: [
              {
                type: 'text' as const,
                text: `Failed to store memory: ${response.status} ${errorText}`,
              },
            ],
            isError: true,
          }
        }

        const result = await response.json()
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                { stored: true, userId, projectId, branch, result },
                null,
                2
              ),
            },
          ],
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Memory store error: ${error instanceof Error ? error.message : 'Unknown'}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // memory.search — recall memories by semantic similarity (branch-aware)
  server.tool(
    'cortex_memory_search',
    'Search agent memories by semantic similarity. Use projectId + branch to search branch-specific knowledge with fallback to project-level and then agent-level memories.',
    {
      query: z.string().describe('Search query for memory recall'),
      agentId: z.string().optional().describe('Filter by agent (default: all agents)'),
      projectId: z.string().optional().describe('Project ID to search within'),
      branch: z.string().optional().describe('Git branch to search (with fallback to project-level)'),
      limit: z.number().optional().describe('Max results (default: 5)'),
    },
    async ({ query, agentId, projectId, branch, limit }) => {
      try {
        const maxResults = limit ?? 5
        const apiUrl = env.DASHBOARD_API_URL || 'http://localhost:4000'
        const allMemories: unknown[] = []

        // Branch hierarchy search: branch → project → agent (fallback chain)
        const searchScopes: string[] = []
        if (projectId && branch) {
          searchScopes.push(`project-${projectId}:branch-${branch}`)
          searchScopes.push(`project-${projectId}`) // fallback
        } else if (projectId) {
          searchScopes.push(`project-${projectId}`)
        } else {
          searchScopes.push(agentId ?? 'default')
        }

        for (const userId of searchScopes) {
          if (allMemories.length >= maxResults) break

          const remaining = maxResults - allMemories.length
          const response = await fetch(`${apiUrl}/api/mem9/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              query,
              userId,
              limit: remaining,
            }),
            signal: AbortSignal.timeout(30000),
          })

          if (response.ok) {
            const data = (await response.json()) as { memories?: unknown[] }
            const memories = data.memories ?? []
            if (Array.isArray(memories)) {
              allMemories.push(
                ...memories.map((m: unknown) => ({
                  ...(m as Record<string, unknown>),
                  _scope: userId,
                }))
              )
            }
          }
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  query,
                  scopes: searchScopes,
                  count: allMemories.length,
                  memories: allMemories,
                },
                null,
                2
              ),
            },
          ],
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Memory search error: ${error instanceof Error ? error.message : 'Unknown'}`,
            },
          ],
          isError: true,
        }
      }
    }
  )
}
