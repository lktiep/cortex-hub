import { z } from 'zod'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../types.js'

/**
 * Register knowledge tools.
 * Supports both text queries (auto-embedded via mem9) and raw vector queries.
 * Searches Qdrant for relevant document snippets.
 */
export function registerKnowledgeTools(server: McpServer, env: Env) {
  // knowledge.search — search vector db for related concepts
  server.tool(
    'cortex_knowledge_search',
    'Search the platform knowledge base by semantic similarity using Qdrant. Returns relevant snippets and document text.',
    {
      query: z.string().optional().describe('Text query to search for (auto-embedded via mem9)'),
      query_vector: z.array(z.number()).optional().describe('Raw embedding vector (alternative to text query)'),
      collection_name: z.string().optional().describe('Qdrant collection to search (default: "knowledge")'),
      limit: z.number().optional().describe('Maximum number of results to return (default: 5)'),
    },
    async ({ query, query_vector, collection_name, limit }) => {
      const collection = collection_name ?? 'knowledge'

      try {
        let vector: number[]

        if (query_vector && query_vector.length > 0) {
          // Use provided vector directly
          vector = query_vector
        } else if (query) {
          // Auto-embed text query via mem9 proxy
          const apiUrl = env.DASHBOARD_API_URL || 'http://localhost:4000'
          const embedRes = await fetch(`${apiUrl}/api/mem9/embed`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: query }),
            signal: AbortSignal.timeout(15000),
          })

          if (!embedRes.ok) {
            const errorText = await embedRes.text()
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to embed query: ${embedRes.status} ${errorText}`,
                },
              ],
              isError: true,
            }
          }

          const embedData = (await embedRes.json()) as { vector: number[] }
          vector = embedData.vector
        } else {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Either query (text) or query_vector (numbers) must be provided',
              },
            ],
            isError: true,
          }
        }

        const response = await fetch(`${env.QDRANT_URL}/collections/${collection}/points/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vector,
            limit: limit ?? 5,
            with_payload: true,
          }),
          signal: AbortSignal.timeout(10000),
        })

        if (!response.ok) {
          const errorText = await response.text()
          return {
            content: [
              {
                type: 'text' as const,
                text: `Knowledge search failed: ${response.status} ${errorText}`,
              },
            ],
            isError: true,
          }
        }

        const data = (await response.json()) as { result?: Array<Record<string, unknown>> }
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                collection,
                query: query ?? '(vector provided)',
                results: data.result ?? [],
              }, null, 2),
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
