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
    'Store a knowledge document in the Cortex knowledge base. Auto-chunks and embeds the content for semantic search. Use this to contribute discovered patterns, resolved issues, architecture decisions, and reusable solutions. Supports MemPalace-inspired memory hierarchy (hallType) and temporal validity (validFrom).',
    {
      title: z.string().describe('Document title (concise, descriptive)'),
      content: z.string().describe('Full document content to store'),
      tags: z.array(z.string()).optional().describe('Tags for categorization (e.g., ["typescript", "patterns", "deployment"])'),
      projectId: z.string().optional().describe('Project ID to scope this knowledge to'),
      agentId: z.string().optional().describe('Contributing agent identifier'),
      hallType: z.enum(['fact', 'event', 'discovery', 'preference', 'advice', 'general']).optional().describe('MemPalace-inspired hall type: fact | event | discovery | preference | advice | general (default)'),
      validFrom: z.string().optional().describe('ISO date when this fact became valid (temporal validity)'),
    },
    async ({ title, content, tags, projectId, agentId, hallType, validFrom }) => {
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
            hallType,
            validFrom,
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
    'Search the platform knowledge base by semantic similarity. Returns relevant document snippets with metadata, tags, and hit counts. Supports filtering by tags, project, hall type (MemPalace-inspired hierarchy), and "as of" date (temporal validity).',
    {
      query: z.string().describe('Text query to search for (auto-embedded)'),
      tags: z.array(z.string()).optional().describe('Filter by tags'),
      projectId: z.string().optional().describe('Filter by project ID'),
      limit: z.number().optional().describe('Maximum results (default: 5)'),
      hallType: z.enum(['fact', 'event', 'discovery', 'preference', 'advice', 'general']).optional().describe('Filter by MemPalace hall type'),
      asOf: z.string().optional().describe('ISO date — return only facts that were valid at this point in time'),
    },
    async ({ query, tags, projectId, limit, hallType, asOf }) => {
      try {
        const res = await apiCall(env, '/api/knowledge/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query,
            tags,
            projectId,
            limit: limit ?? 5,
            hallType,
            asOf,
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

        interface SearchResult {
          score?: number
          chunkId?: string
          content?: string
          documentId?: string
          title?: string
          chunkIndex?: number
          deprecated?: boolean
          document?: {
            tags?: string
            hall_type?: string
          }
        }

        interface SearchResponse {
          query: string
          results: SearchResult[]
        }

        const data = (await res.json()) as SearchResponse
        if (!data.results || data.results.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No relevant knowledge found for query: "${query}"`,
              },
            ],
          }
        }

        const formattedResults = data.results.map((r, index) => {
          const tagsList = r.document?.tags ? JSON.parse(r.document.tags) : []
          const tagsStr = tagsList.length > 0 ? ` [Tags: ${tagsList.join(', ')}]` : ''
          const hallTypeStr = r.document?.hall_type ? ` [Type: ${r.document.hall_type}]` : ''
          const deprecationWarning = r.deprecated
            ? `\n⚠️ WARNING: This entry has high fallback rates and might be obsolete/deprecated.`
            : ''
          
          return `### Result ${index + 1}: ${r.title || 'Untitled'} (ID: ${r.documentId ?? 'unknown'}, Chunk: ${r.chunkIndex ?? 0}, Score: ${r.score?.toFixed(3) ?? 'N/A'})${tagsStr}${hallTypeStr}${deprecationWarning}\n\n${r.content || ''}`
        }).join('\n\n---\n\n')

        return {
          content: [
            {
              type: 'text' as const,
              text: `Search results for query: "${query}"\n\n${formattedResults}`,
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
