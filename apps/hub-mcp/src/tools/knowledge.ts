import { z } from 'zod'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../types.js'
import { apiCall } from '../api-call.js'

/**
 * Register knowledge tools.
 * cortex_knowledge_store — agents contribute knowledge documents
 * cortex_knowledge_search — semantic search with metadata filtering
 * Both proxy through Dashboard API for unified chunking, embedding, and hit tracking.
 */
export function registerKnowledgeTools(server: McpServer, env: Env) {
  // ── Store knowledge ──
  server.tool(
    'cortex_knowledge_store',
    'Store a knowledge document in the Cortex knowledge base. Auto-chunks and embeds the content for semantic search. Use this to contribute discovered patterns, resolved issues, architecture decisions, and reusable solutions.',
    {
      title: z.string().describe('Document title (concise, descriptive)'),
      content: z.string().describe('Full document content to store'),
      tags: z.array(z.string()).optional().describe('Tags for categorization (e.g., ["typescript", "patterns", "deployment"])'),
      projectId: z.string().optional().describe('Project ID to scope this knowledge to'),
      agentId: z.string().optional().describe('Contributing agent identifier'),
    },
    async ({ title, content, tags, projectId, agentId }) => {
      try {
        const res = await apiCall(env, '/api/knowledge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            content,
            tags: tags ?? [],
            projectId,
            sourceAgentId: agentId,
            source: 'agent',
          }),
        })

        if (!res.ok) {
          const errorText = await res.text()
          return {
            content: [
              {
                type: 'text' as const,
                text: `Failed to store knowledge: ${res.status} ${errorText}`,
              },
            ],
            isError: true,
          }
        }

        const doc = await res.json()
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(doc, null, 2),
            },
          ],
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Knowledge store error: ${error instanceof Error ? error.message : 'Unknown'}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // ── Search knowledge ──
  server.tool(
    'cortex_knowledge_search',
    'Search the platform knowledge base by semantic similarity. Returns relevant document snippets with metadata, tags, and hit counts. Supports filtering by tags and project.',
    {
      query: z.string().describe('Text query to search for (auto-embedded)'),
      tags: z.array(z.string()).optional().describe('Filter by tags'),
      projectId: z.string().optional().describe('Filter by project ID'),
      limit: z.number().optional().describe('Maximum results (default: 5)'),
    },
    async ({ query, tags, projectId, limit }) => {
      try {
        const res = await apiCall(env, '/api/knowledge/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query,
            tags,
            projectId,
            limit: limit ?? 5,
          }),
        })

        if (!res.ok) {
          const errorText = await res.text()
          return {
            content: [
              {
                type: 'text' as const,
                text: `Knowledge search failed: ${res.status} ${errorText}`,
              },
            ],
            isError: true,
          }
        }

        const data = await res.json()
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
              text: `Knowledge search error: ${error instanceof Error ? error.message : 'Unknown'}`,
            },
          ],
          isError: true,
        }
      }
    }
  )
}
