import { z } from 'zod'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../types.js'

/**
 * Register code intelligence tools.
 * Proxies AST graph, impact analysis, and code search requests to the Dashboard API
 * which routes them natively to the GitNexus backend on the server.
 * Supports project + branch scoping for multi-branch knowledge.
 *
 * Proxied via Dashboard API — GitNexus runs as a CLI tool server-side.
 */
export function registerCodeTools(server: McpServer, env: Env) {
  const apiUrl = () => env.DASHBOARD_API_URL || 'http://localhost:4000'

  // ── Helper: call Dashboard API intel endpoints ──
  async function callIntel(
    endpoint: string,
    params: Record<string, unknown>,
    timeoutMs = 15000,
  ): Promise<unknown> {
    const response = await fetch(`${apiUrl()}/api/intel/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`${endpoint} failed: ${response.status} ${errorText}`)
    }

    return response.json()
  }

  // ── code_search — query codebase concepts and workflows ──
  server.tool(
    'cortex_code_search',
    'Query the codebase for architecture concepts, execution flows, and file matches using GitNexus hybrid vector/AST search. Use projectId to scope to a specific project.',
    {
      query: z.string().describe('Natural language or code query to search for'),
      projectId: z.string().optional().describe('Project ID to scope search to'),
      branch: z.string().optional().describe('Git branch to search (uses the indexed branch data)'),
      limit: z.number().optional().describe('Maximum flows to return (default: 5)'),
    },
    async ({ query, projectId, branch, limit }) => {
      try {
        const data = (await callIntel('search', {
          query,
          projectId,
          branch,
          limit: limit ?? 5,
        })) as { data?: { formatted?: string }; success?: boolean }

        const formatted = data?.data?.formatted
        if (formatted) {
          return {
            content: [{ type: 'text' as const, text: formatted }],
          }
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
        }
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `Code search error: ${error instanceof Error ? error.message : 'Unknown'}`,
          }],
          isError: true,
        }
      }
    }
  )

  // ── code_impact — calculate blast radius for code changes ──
  server.tool(
    'cortex_code_impact',
    'Analyze the blast radius of changing a specific symbol (function, class, file) to verify downstream impact before making edits.',
    {
      target: z.string().describe('The name of the function, class, or file to analyze'),
      projectId: z.string().optional().describe('Project ID to scope analysis to'),
      branch: z.string().optional().describe('Git branch to analyze'),
      direction: z.enum(['upstream', 'downstream']).optional().describe('Direction to analyze (default: downstream)'),
    },
    async ({ target, projectId, branch, direction }) => {
      try {
        const data = await callIntel('impact', {
          target,
          projectId,
          branch,
          direction: direction ?? 'downstream',
        }) as { data?: { results?: { raw?: string } } }

        const raw = data?.data?.results?.raw ?? ''

        // Auto-retry: if target appears "isolated", it may be a class name.
        // Try context lookup to find methods, then retry impact on first method.
        if (raw.includes('appears isolated') || raw.includes('not found')) {
          try {
            let contextRaw = ''

            // First attempt: context lookup without file
            const contextData = await callIntel('context', {
              name: target,
              projectId,
            }) as { data?: { results?: { raw?: string } } }

            contextRaw = contextData?.data?.results?.raw ?? ''

            // Handle disambiguation: "Multiple symbols named 'X'. Disambiguate with file path:"
            // Extract the first file path and retry with it
            if (contextRaw.includes('Disambiguate with file path')) {
              const fileMatch = contextRaw.match(/→\s+\S+\/(\S+\.cs):\d+/)
              if (fileMatch) {
                const fullPathMatch = contextRaw.match(/→\s+(\S+\.cs):\d+/)
                const filePath = fullPathMatch?.[1]
                if (filePath) {
                  try {
                    const retryData = await callIntel('context', {
                      name: target,
                      file: filePath,
                      projectId,
                    }) as { data?: { results?: { raw?: string } } }
                    contextRaw = retryData?.data?.results?.raw ?? contextRaw
                  } catch { /* keep first response */ }
                }
              }
            }

            // Extract method names from context output
            // Pattern 1: [has_method] undefined MethodName
            const methodMatches = contextRaw.match(/\[has_method\]\s+\w+\s+\w+/g)

            if (methodMatches && methodMatches.length > 0) {
              const methods = methodMatches
                .filter((m): m is string => typeof m === 'string')
                .map((m) => {
                  const parts = m.split(/\s+/)
                  return parts[parts.length - 1] ?? ''
                })
                .filter((m) => m && m !== target)

              const lines: string[] = [
                `📋 Class "${target}" — ${methods.length} method(s) found:\n`,
                ...methods.map((m: string) => `  • ${m}`),
                '',
              ]

              if (methods.length > 0) {
                try {
                  const methodImpact = await callIntel('impact', {
                    target: methods[0],
                    projectId,
                    direction: direction ?? 'downstream',
                  }) as { data?: { results?: { raw?: string } } }

                  const methodRaw = methodImpact?.data?.results?.raw ?? ''
                  if (!methodRaw.includes('appears isolated') && !methodRaw.includes('not found')) {
                    lines.push(`\n🎯 Impact for "${methods[0]}" (first method):\n`)
                    lines.push(methodRaw)
                  }
                } catch { /* ignore retry failure */ }
              }

              lines.push(`\n💡 Tip: Run cortex_code_impact on specific methods for detailed blast radius.`)
              lines.push(`💡 Tip: Run cortex_code_context "${target}" for full 360° view.`)

              return {
                content: [{ type: 'text' as const, text: lines.join('\n') }],
              }
            }

            // If no [has_method] but context has useful info, return it enriched
            if (contextRaw && !contextRaw.includes('not found')) {
              const lines: string[] = [
                `⚠️ No direct downstream dependencies found for "${target}".`,
                `\n📋 Context from code graph:\n`,
                contextRaw,
                `\n💡 Tip: Try cortex_code_impact on specific methods/functions listed above.`,
                `💡 Tip: Try cortex_code_context "${target}" for full details.`,
              ]
              return {
                content: [{ type: 'text' as const, text: lines.join('\n') }],
              }
            }
          } catch { /* ignore context failure, return original result */ }
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
        }
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `Impact analysis error: ${error instanceof Error ? error.message : 'Unknown'}`,
          }],
          isError: true,
        }
      }
    }
  )

  // ── code_context — 360° symbol view (callers, callees, methods) ──
  server.tool(
    'cortex_code_context',
    'Get a 360° view of a code symbol: its methods, callers, callees, and related execution flows. Essential for exploring class hierarchies and understanding how a symbol is used across the codebase.',
    {
      name: z.string().describe('The name of the function, class, or symbol to explore'),
      projectId: z.string().optional().describe('Project ID to scope lookup to'),
      file: z.string().optional().describe('File path to disambiguate when multiple symbols share the same name'),
    },
    async ({ name, projectId, file }) => {
      try {
        const data = await callIntel('context', { name, projectId, file }) as {
          data?: { results?: { raw?: string } }
        }

        const raw = data?.data?.results?.raw ?? JSON.stringify(data, null, 2)

        return {
          content: [{ type: 'text' as const, text: raw }],
        }
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `Context lookup error: ${error instanceof Error ? error.message : 'Unknown'}`,
          }],
          isError: true,
        }
      }
    }
  )

  // ── detect_changes — pre-commit risk analysis ──
  server.tool(
    'cortex_detect_changes',
    'Detect uncommitted changes and analyze their risk level across the indexed codebase. Shows changed symbols, affected processes, and risk assessment.',
    {
      scope: z.string().optional().describe('Scope of changes to detect: "all" (default), "staged", or "unstaged"'),
      projectId: z.string().optional().describe('Project ID to scope analysis to'),
    },
    async ({ scope, projectId }) => {
      try {
        const data = await callIntel('detect-changes', { scope: scope ?? 'all', projectId })
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
        }
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Detect changes error: ${error instanceof Error ? error.message : 'Unknown'}` }],
          isError: true,
        }
      }
    }
  )

  // ── cypher — direct graph queries ──
  server.tool(
    'cortex_cypher',
    'Run Cypher queries directly against the GitNexus knowledge graph. Supports MATCH, RETURN, WHERE, ORDER BY for exploring code relationships.',
    {
      query: z.string().describe('Cypher query to run (e.g., MATCH (n:Function) RETURN n.name LIMIT 10)'),
      projectId: z.string().optional().describe('Project ID to scope query to'),
    },
    async ({ query, projectId }) => {
      try {
        const data = await callIntel('cypher', { query, projectId })
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
        }
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Cypher query error: ${error instanceof Error ? error.message : 'Unknown'}` }],
          isError: true,
        }
      }
    }
  )
}
