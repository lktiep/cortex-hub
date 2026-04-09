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

  // ── Helper: resolve repo name/URL → projectId ──
  async function resolveRepo(repo?: string, projectId?: string): Promise<string | undefined> {
    if (projectId) return projectId
    if (!repo) return undefined
    // Try as-is first (might be a valid repo name like "cortex-hub")
    // GitNexus accepts repo name directly — return it
    // Strip URL to get repo name: https://github.com/org/name.git → name
    const name = repo
      .replace(/\.git$/, '')
      .replace(/^https?:\/\/.*\//, '')
      .split('/').pop() || repo
    return name
  }

  // ── code_search — query codebase concepts and workflows ──
  server.tool(
    'cortex_code_search',
    'Query the codebase for architecture concepts, execution flows, and file matches using GitNexus hybrid vector/AST search. Accepts repo name (e.g. "cortex-hub"), git URL, or projectId. OMIT repo to search across ALL indexed projects in parallel and get ranked hints (perfect when you don\'t know which project has the code).',
    {
      query: z.string().describe('Natural language or code query to search for'),
      repo: z.string().optional().describe('Repository name (e.g. "cortex-hub") or git URL. Preferred over projectId.'),
      projectId: z.string().optional().describe('Project ID (e.g. "proj-704127e3"). Use repo name instead if possible.'),
      branch: z.string().optional().describe('Git branch to search'),
      limit: z.number().optional().describe('Maximum flows to return (default: 5)'),
    },
    async ({ query, repo, projectId, branch, limit }) => {
      try {
        const resolvedProject = await resolveRepo(repo, projectId)
        const data = (await callIntel('search', {
          query,
          projectId: resolvedProject,
          branch,
          limit: limit ?? 5,
        })) as { data?: { formatted?: string }; success?: boolean }

        let formatted = data?.data?.formatted ?? ''

        // ── P0 Fix: Suggest alternatives when no flows found ──
        // Repos with 0 execution flows (e.g., YulgangProject) always return empty.
        // Guide agents to code_context and cypher which work on symbols directly.
        const isEmpty = formatted && (
          formatted.includes('No matching execution flows') ||
          formatted.includes('No matching results found')
        )
        if (isEmpty) {
          const searchTerms = query.split(/\s+/).filter(w => w.length > 3).slice(0, 2)
          const symbolSuggestion = searchTerms[0] ?? query
          formatted += '\n\n---'
          formatted += `\nNext: Pick a symbol above and run cortex_code_context "${symbolSuggestion}" to see all its callers, callees, and execution flows.`
          formatted += `\nAlternative: Use cortex_cypher 'MATCH (n) WHERE n.name CONTAINS "${symbolSuggestion}" RETURN n.name, labels(n) LIMIT 20' for direct graph query.`
          if (projectId) {
            formatted += `\nProject routing: Use cortex_list_repos to verify which projectId maps to your repository.`
          }
        }

        // ── Qdrant semantic code search: supplement GitNexus with actual source code ──
        if (projectId) {
          try {
            const codeRes = await fetch(`${apiUrl()}/api/intel/code-search`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ query, projectId, branch, limit: limit ?? 5 }),
              signal: AbortSignal.timeout(15000),
            })

            if (codeRes.ok) {
              const codeData = (await codeRes.json()) as {
                success?: boolean
                data?: {
                  results?: Array<{
                    score: number
                    filePath?: string
                    content?: string
                    chunkIndex?: number
                  }>
                  message?: string
                }
              }

              const codeResults = codeData?.data?.results ?? []
              if (codeResults.length > 0) {
                const codeLines: string[] = ['\n\n📄 **Source Code Matches** (semantic search)\n']
                for (const hit of codeResults.slice(0, 5)) {
                  const score = (hit.score * 100).toFixed(1)
                  codeLines.push(`### ${hit.filePath ?? 'unknown'} (${score}% match)`)
                  if (hit.content) {
                    // Detect language from file extension
                    const ext = hit.filePath?.split('.').pop() ?? ''
                    const lang = { ts: 'typescript', js: 'javascript', cs: 'csharp', py: 'python', go: 'go', rs: 'rust', java: 'java' }[ext] ?? ext
                    codeLines.push(`\`\`\`${lang}`)
                    codeLines.push(hit.content.slice(0, 2000))
                    codeLines.push('```')
                  }
                  codeLines.push('')
                }
                codeLines.push('💡 Use cortex_code_read to view the full file content.')
                formatted += codeLines.join('\n')
              } else if (isEmpty && codeData?.data?.message) {
                formatted += `\n\n⚠️ ${codeData.data.message}`
              }
            }
          } catch {
            // Qdrant search is best-effort — don't fail the entire search
          }
        }

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
      repo: z.string().optional().describe('Repository name (e.g. "cortex-hub") or git URL'),
      projectId: z.string().optional().describe('Project ID. Use repo name instead if possible.'),
      branch: z.string().optional().describe('Git branch to analyze'),
      direction: z.enum(['upstream', 'downstream']).optional().describe('Direction to analyze (default: downstream)'),
    },
    async ({ target, repo, projectId, branch, direction }) => {
      try {
        const resolvedProject = await resolveRepo(repo, projectId)
        const data = await callIntel('impact', {
          target,
          projectId: resolvedProject,
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
      repo: z.string().optional().describe('Repository name (e.g. "cortex-hub") or git URL'),
      projectId: z.string().optional().describe('Project ID. Use repo name instead if possible.'),
      file: z.string().optional().describe('File path to disambiguate when multiple symbols share the same name'),
    },
    async ({ name, repo, projectId, file }) => {
      try {
        const resolvedProject = await resolveRepo(repo, projectId)
        const data = await callIntel('context', { name, projectId: resolvedProject, file }) as {
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
    'Run Cypher queries directly against the GitNexus knowledge graph. Supports MATCH, RETURN, WHERE, ORDER BY for exploring code relationships.\n\nAvailable node properties: name, filePath. Use labels(n) for type.\nExample: MATCH (n) WHERE n.name CONTAINS "Attack" RETURN n.name, labels(n) LIMIT 20',
    {
      query: z.string().describe('Cypher query to run (e.g., MATCH (n:Function) RETURN n.name LIMIT 10)'),
      repo: z.string().optional().describe('Repository name (e.g. "cortex-hub") or git URL'),
      projectId: z.string().optional().describe('Project ID. Use repo name instead if possible.'),
    },
    async ({ query, repo, projectId }) => {
      try {
        const resolvedProject = await resolveRepo(repo, projectId)
        const data = await callIntel('cypher', { query, projectId: resolvedProject })
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : 'Unknown'
        // ── P2: Include schema hint when property not found ──
        const schemaHint = errMsg.includes('Cannot find property')
          ? '\n\n💡 Available properties: name, filePath. Use labels(n) for node type, not n.type.\nExample: MATCH (n) WHERE n.name CONTAINS "X" RETURN n.name, labels(n) LIMIT 20'
          : ''
        return {
          content: [{ type: 'text' as const, text: `Cypher query error: ${errMsg}${schemaHint}` }],
          isError: true,
        }
      }
    }
  )

  // ── list_repos — discover indexed repositories and their project mapping ──
  server.tool(
    'cortex_list_repos',
    'List all indexed repositories with project ID mapping. Use this to find which projectId to pass to code_search, code_context, code_impact, and cypher tools.',
    {},
    async () => {
      try {
        const response = await fetch(`${apiUrl()}/api/intel/repos`, {
          signal: AbortSignal.timeout(10000),
        })

        if (!response.ok) {
          throw new Error(`Failed to list repos: ${response.status}`)
        }

        const data = await response.json() as { success?: boolean; data?: unknown }
        const repoData = data?.data

        const lines: string[] = ['📦 Indexed Repositories\n']

        if (Array.isArray(repoData) && repoData.length > 0) {
          // Deduplicate by name
          const seen = new Map<string, typeof repoData[0]>()
          for (const repo of repoData) {
            const name = typeof repo === 'string' ? repo : (repo.name ?? repo.repo ?? 'unknown')
            const key = name.toLowerCase()
            if (!seen.has(key) || (repo.symbols && repo.symbols !== '?')) {
              seen.set(key, repo)
            }
          }

          // Format as clean table with all useful columns
          lines.push('| # | Name | Slug (use with `repo:`) | Symbols | Flows |')
          lines.push('|---|------|------------------------|---------|-------|')

          let idx = 0
          for (const [, repo] of seen) {
            idx++
            const name = typeof repo === 'string' ? repo : (repo.name ?? 'unknown')
            const slug = repo.slug ?? name
            const symbols = repo.symbols ?? '?'
            const flows = repo.flows ?? '?'
            lines.push(`| ${idx} | **${name}** | \`${slug}\` | ${symbols} | ${flows} |`)
          }

          lines.push('')
          lines.push(`Total: ${seen.size} repositories indexed.`)
        } else {
          lines.push('No indexed repositories found.')
        }

        lines.push('')
        lines.push('💡 **Usage**: Pass the Name or Slug directly to the `repo` parameter:')
        lines.push('  `cortex_code_search(query: "...", repo: "cortex-hub")`')
        lines.push('  `cortex_code_context(name: "MyClass", repo: "YulgangProject")`')
        lines.push('  No need to use `projectId` — just use the repo name.')

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        }
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `List repos error: ${error instanceof Error ? error.message : 'Unknown'}`,
          }],
          isError: true,
        }
      }
    }
  )

  // ── code_read — read raw source file content ──
  server.tool(
    'cortex_code_read',
    'Read raw source code from an indexed repository. Returns full file content or a line range. Use after cortex_code_search to view complete files. Requires the project to be cloned via Code Indexing.',
    {
      file: z.string().describe('Relative file path within the repo (e.g., "src/utils/auth.ts")'),
      repo: z.string().optional().describe('Repository name (e.g. "cortex-hub") or git URL'),
      projectId: z.string().optional().describe('Project ID. Use repo name instead if possible.'),
      startLine: z.number().optional().describe('Start line (1-indexed, inclusive)'),
      endLine: z.number().optional().describe('End line (1-indexed, inclusive)'),
    },
    async ({ file, repo, projectId, startLine, endLine }) => {
      try {
        const resolvedProject = await resolveRepo(repo, projectId)
        const res = await fetch(`${apiUrl()}/api/intel/file-content`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: resolvedProject, file, startLine, endLine }),
          signal: AbortSignal.timeout(10000),
        })

        const data = (await res.json()) as {
          success?: boolean
          data?: {
            file?: string
            totalLines?: number
            startLine?: number
            endLine?: number
            content?: string
            sizeBytes?: number
          }
          error?: string
          suggestions?: string[]
          hint?: string
        }

        if (!res.ok || !data.success) {
          let errorMsg = data.error ?? `Failed: ${res.status}`
          if (data.suggestions && data.suggestions.length > 0) {
            errorMsg += '\n\nDid you mean one of these files?'
            for (const s of data.suggestions) {
              errorMsg += `\n  → ${s}`
            }
          }
          if (data.hint) {
            errorMsg += `\n\n💡 ${data.hint}`
          }
          return {
            content: [{ type: 'text' as const, text: errorMsg }],
            isError: true,
          }
        }

        const fileData = data.data!
        const header = `📄 **${fileData.file}** (${fileData.totalLines} lines${fileData.sizeBytes ? `, ${Math.round(fileData.sizeBytes / 1024)}KB` : ''})`
        const lineRange = fileData.startLine && fileData.endLine
          ? `\nShowing lines ${fileData.startLine}-${fileData.endLine}`
          : ''

        // Detect language for syntax highlighting
        const ext = (fileData.file ?? '').split('.').pop() ?? ''
        const langMap: Record<string, string> = {
          ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
          cs: 'csharp', py: 'python', go: 'go', rs: 'rust', java: 'java',
          kt: 'kotlin', rb: 'ruby', php: 'php', swift: 'swift', dart: 'dart',
          sql: 'sql', sh: 'bash', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
          lua: 'lua', vue: 'vue', svelte: 'svelte',
        }
        const lang = langMap[ext] ?? ext

        const output = `${header}${lineRange}\n\n\`\`\`${lang}\n${fileData.content}\n\`\`\``

        return {
          content: [{ type: 'text' as const, text: output }],
        }
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `Code read error: ${error instanceof Error ? error.message : 'Unknown'}`,
          }],
          isError: true,
        }
      }
    }
  )
}
