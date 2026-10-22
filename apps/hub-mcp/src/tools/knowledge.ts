import { z } from 'zod'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../types.js'
import { apiCall } from '../api-call.js'
import { LOAD_UP_FRONT } from './load-up-front.js'
import { DEFAULT_MAX_CHARS, formatKnowledgeDocument, formatKnowledgeResults, type KnowledgeDoc, type KnowledgeHit } from './knowledge-format.js'

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
      files: z.array(z.string()).optional().describe('Repo-relative files (or "dir/") this is about. Linked notes are shown to the next agent that reads or edits those files, and appended to code tool results that name them — pass them for any risk, pitfall or fix tied to specific code.'),
      category: z.enum(['risk', 'lesson', 'error_fix', 'pattern', 'decision', 'general']).optional().describe('What kind of note: risk | lesson | error_fix | pattern | decision | general'),
    },
    async ({ title, content, tags, projectId, agentId, hallType, validFrom, files, category }) => {
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
            files,
            category,
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
    'Search the platform knowledge base by semantic similarity. Returns one heading and a short excerpt per document; pass `id` for one document in full. Query with the words of the problem in hand (an error message, the feature), not a generic phrase. Supports filtering by tags, project, hall type (MemPalace-inspired hierarchy), and "as of" date (temporal validity).',
    {
      query: z.string().optional().describe('Text query to search for (auto-embedded). Required unless id is given'),
      id: z.string().optional().describe('Document ID from an earlier result: returns that document in full instead of searching'),
      tags: z.array(z.string()).optional().describe('Filter by tags'),
      projectId: z.string().optional().describe('Filter by project ID'),
      limit: z.number().optional().describe('Maximum results (default: 5)'),
      maxChars: z.number().optional().describe(`Size of the answer in characters (default: ${DEFAULT_MAX_CHARS}); hits past it are listed by heading only`),
      hallType: z.enum(['fact', 'event', 'discovery', 'preference', 'advice', 'general']).optional().describe('Filter by MemPalace hall type'),
      asOf: z.string().optional().describe('ISO date — return only facts that were valid at this point in time'),
    },
    async ({ query, id, tags, projectId, limit, maxChars, hallType, asOf }) => {
      try {
        if (id) {
          const docRes = await apiCall(env, `/api/knowledge/${encodeURIComponent(id)}`)
          if (!docRes.ok) {
            return {
              content: [{ type: 'text' as const, text: `Knowledge document ${id}: ${docRes.status} ${await docRes.text()}` }],
              isError: true,
            }
          }
          return { content: [{ type: 'text' as const, text: formatKnowledgeDocument((await docRes.json()) as KnowledgeDoc) }] }
        }
        if (!query) {
          return { content: [{ type: 'text' as const, text: 'Give a query to search, or an id to read one document.' }], isError: true }
        }
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

        const data = (await res.json()) as { query: string; results?: KnowledgeHit[] }
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

        return {
          content: [{ type: 'text' as const, text: formatKnowledgeResults(query, data.results, maxChars) }],
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
  ).update(LOAD_UP_FRONT)

  // ── Notes linked to files ──
  server.tool(
    'cortex_file_notes',
    'Known risks, lessons and past fixes linked to repo files (stored with cortex_knowledge_store files: [...]). Returns JSON {projectId, notes: {path: [{id, title, kind, note, at}]}}. Without files, every linked path of the project.',
    {
      repo: z.string().optional().describe('Git remote URL or repo name; defaults to your session project'),
      projectId: z.string().optional().describe('Project ID, when repo is not given'),
      files: z.array(z.string()).optional().describe('Repo-relative files to get notes for; omit for all linked paths'),
    },
    async ({ repo, projectId, files }) => {
      try {
        const res = await apiCall(env, '/api/knowledge/file-notes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo, projectId, files }),
        })
        const text = await res.text()
        return { content: [{ type: 'text' as const, text: res.ok ? text : `File notes failed: ${res.status} ${text}` }], isError: !res.ok }
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `File notes error: ${error instanceof Error ? error.message : 'Unknown'}` }],
          isError: true,
        }
      }
    }
  )
}
