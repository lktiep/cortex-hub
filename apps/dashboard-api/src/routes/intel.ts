import { Hono } from 'hono'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import { createLogger } from '@cortex/shared-utils'
import { Embedder } from '@cortex/shared-mem9'
import type { EmbedderConfig } from '@cortex/shared-mem9'
import { db } from '../db/client.js'

const logger = createLogger('intel')

export const intelRouter = new Hono()

const GITNEXUS_URL = () => process.env.GITNEXUS_URL ?? 'http://gitnexus:4848'
const QDRANT_URL = process.env.QDRANT_URL ?? 'http://qdrant:6333'
const REPOS_DIR = process.env.REPOS_DIR ?? '/app/data/repos'

/** Max file size for code_read (512KB) */
const MAX_READ_SIZE = 512 * 1024

/** Resolve Gemini API key for embedding */
function resolveGeminiApiKey(): string {
  const envKey = process.env['GEMINI_API_KEY']
  if (envKey) return envKey
  try {
    const row = db.prepare(
      "SELECT api_key FROM provider_accounts WHERE type = 'gemini' AND status = 'enabled' AND api_key IS NOT NULL LIMIT 1"
    ).get() as { api_key: string } | undefined
    if (row?.api_key) return row.api_key
  } catch { /* DB might not be ready */ }
  return ''
}

/**
 * Call GitNexus eval-server HTTP API.
 */
async function callGitNexus(
  tool: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const url = `${GITNEXUS_URL()}/tool/${tool}`
  logger.info(`GitNexus ${tool}: ${JSON.stringify(params)}`)

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(30000),
  })

  const text = await res.text()

  if (!res.ok) {
    throw new Error(text || `GitNexus ${tool} failed: ${res.status}`)
  }

  // GitNexus may return JSON or plain text
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text.trim() }
  }
}

/**
 * Resolve a projectId, slug, or human-readable name to GitNexus-compatible repo name candidates.
 * Returns ordered list of names to try — GitNexus may register repos by:
 *   1. slug (e.g., 'yulgangproject')
 *   2. git URL basename (e.g., 'YulgangProject')
 *   3. projectId folder name (e.g., 'proj-abc123')
 *
 * Supports case-insensitive matching and search by name column,
 * so agents can just say repo: "YulgangProject" without needing a projectId.
 */
function resolveRepoNames(projectId: string): string[] {
  const candidates: string[] = []

  // If it doesn't look like an internal ID, try as-is first
  if (!projectId.startsWith('proj-')) {
    candidates.push(projectId)
  }

  try {
    // Case-insensitive lookup: match by id, slug, OR name
    const project = db.prepare(
      `SELECT id, slug, name, git_repo_url FROM projects
       WHERE id = ?
          OR slug = ? COLLATE NOCASE
          OR name = ? COLLATE NOCASE
          OR name LIKE ? COLLATE NOCASE`
    ).get(projectId, projectId, projectId, `%${projectId}%`) as {
      id?: string; slug?: string; name?: string; git_repo_url?: string
    } | undefined

    if (project) {
      // Strategy 1: Use slug
      if (project.slug && !candidates.includes(project.slug)) {
        candidates.push(project.slug)
      }

      // Strategy 2: Extract repo name from git URL (preserves original casing)
      if (project.git_repo_url) {
        const repoName = project.git_repo_url
          .replace(/\.git$/, '')
          .split('/')
          .pop()
        if (repoName && !candidates.includes(repoName)) {
          candidates.push(repoName)
        }
      }

      // Strategy 3: Use project name (human-readable, may differ from slug)
      if (project.name && !candidates.includes(project.name)) {
        candidates.push(project.name)
      }

      // Strategy 4: Use project ID (folder name in /app/data/repos/)
      if (project.id && !candidates.includes(project.id)) {
        candidates.push(project.id)
      }
    }
  } catch (error) {
    logger.warn(`resolveRepoNames: DB lookup failed: ${error}`)
  }

  // Last resort: use input directly
  if (candidates.length === 0) {
    candidates.push(projectId)
  }

  return candidates
}

/**
 * Legacy single-result resolver for backward compatibility.
 */
function resolveRepoName(projectId: string): string {
  const names = resolveRepoNames(projectId)
  return names[0] ?? projectId
}


/**
 * Call GitNexus with multi-candidate repo fallback.
 * Tries each repo name candidate until one succeeds, then falls back to no-repo mode.
 */
async function callGitNexusWithFallback(
  tool: string,
  params: Record<string, unknown>,
  projectId?: string,
): Promise<unknown> {
  if (!projectId) {
    return callGitNexus(tool, params)
  }

  const candidates = resolveRepoNames(projectId)
  logger.info(`GitNexus fallback: trying candidates ${JSON.stringify(candidates)} for ${tool}`)

  let lastError: unknown = null

  for (const candidate of candidates) {
    try {
      const result = await callGitNexus(tool, { ...params, repo: candidate })
      logger.info(`GitNexus fallback: success with repo "${candidate}" for ${tool}`)
      return result
    } catch (err) {
      lastError = err
      logger.info(`GitNexus fallback: "${candidate}" failed for ${tool}, trying next...`)
    }
  }

  // Final fallback: try without repo filter
  try {
    logger.info(`GitNexus fallback: all candidates failed, trying ${tool} without repo filter`)
    return await callGitNexus(tool, params)
  } catch {
    throw lastError
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GitNexusResult = Record<string, any>

/**
 * Post-process GitNexus raw text to replace CLI hints with MCP tool references.
 */
function rewriteGitNexusHints(text: string): string {
  return text
    .replace(/gitnexus-context/g, 'cortex_code_context')
    .replace(/gitnexus-impact/g, 'cortex_code_impact')
    .replace(/gitnexus-query/g, 'cortex_code_search')
    .replace(
      /Next: Pick a symbol above and run gitnexus-context .*/g,
      'Next: Use cortex_code_context "<symbol>" to explore callers/callees, or cortex_code_impact "<symbol>" for blast radius.',
    )
    .replace(
      /Next: To check what breaks if you change this, run .*/g,
      'Next: Use cortex_code_impact "<name>" to check blast radius, or cortex_code_search for related logic.',
    )
    .replace(
      /Re-run: gitnexus-context .*/g,
      'Tip: Use cortex_code_context with file parameter to disambiguate.',
    )
    .replace(/Read the source with cat /g, 'Examine the source at ')
}

/**
 * Format GitNexus query results into a readable report for agents.
 * Handles the process-grouped search format that GitNexus returns.
 */
function formatSearchResults(query: string, data: unknown): string {
  const result = data as GitNexusResult

  // Handle raw text response
  if (result?.raw) {
    return `🔍 Search: "${query}"\n\n${rewriteGitNexusHints(result.raw)}`
  }

  // Handle structured response with processes
  const lines: string[] = [`🔍 Search: "${query}"\n`]

  // Extract processes if available
  const processes = result?.processes ?? result?.results?.processes ?? []
  const definitions = result?.definitions ?? result?.results?.definitions ?? []
  const files = result?.files ?? result?.results?.files ?? []

  if (Array.isArray(processes) && processes.length > 0) {
    lines.push(`📦 **Execution Flows** (${processes.length} found)\n`)
    for (const proc of processes.slice(0, 10)) {
      const name = proc.summary ?? proc.name ?? 'Unknown'
      const type = proc.process_type ?? ''
      const steps = proc.step_count ?? proc.symbol_count ?? 0
      lines.push(`  ▸ **${name}** (${steps} steps${type ? `, ${type}` : ''})`)

      // Show symbols in this process
      const symbols = proc.process_symbols ?? proc.symbols ?? []
      for (const sym of symbols.slice(0, 5)) {
        const symType = sym.type ?? sym.kind ?? ''
        const filePath = sym.filePath ?? sym.file ?? ''
        lines.push(`    → ${sym.name} (${symType}) — ${filePath}`)
      }
      lines.push('')
    }
  }

  if (Array.isArray(definitions) && definitions.length > 0) {
    lines.push(`📖 **Definitions** (${definitions.length})\n`)
    for (const def of definitions.slice(0, 10)) {
      const defType = def.type ?? def.kind ?? ''
      const filePath = def.filePath ?? def.file ?? ''
      lines.push(`  → ${def.name} (${defType}) — ${filePath}`)
    }
    lines.push('')
  }

  if (Array.isArray(files) && files.length > 0) {
    lines.push(`📁 **Files** (${files.length})\n`)
    for (const f of files.slice(0, 10)) {
      const filePath = typeof f === 'string' ? f : (f.path ?? f.filePath ?? '')
      lines.push(`  → ${filePath}`)
    }
    lines.push('')
  }

  // If nothing structured was found, include raw JSON
  if (processes.length === 0 && definitions.length === 0 && files.length === 0) {
    // Check if result has any meaningful content
    const hasContent = result && typeof result === 'object' && Object.keys(result).length > 0
    if (hasContent) {
      lines.push('📄 **Raw Results:**\n')
      lines.push('```json')
      lines.push(JSON.stringify(result, null, 2))
      lines.push('```')
    } else {
      lines.push('⚠️ No matching results found.\n')
      lines.push('**Suggestions:**')
      lines.push('• Try broader query terms (e.g., "auth" instead of "authentication middleware")')
      lines.push('• Try specific symbol names (e.g., "handleLogin", "UserService")')
      lines.push('• Check if the repository has been indexed: use `cortex_health` to verify GitNexus status')
      lines.push('• Ensure the project has been indexed with code indexing enabled')
    }
  }

  return lines.join('\n')
}

// ── Search: query codebase via GitNexus knowledge graph ──
intelRouter.post('/search', async (c) => {
  try {
    const body = await c.req.json()
    const { query, limit, projectId, branch } = body as {
      query: string
      limit?: number
      projectId?: string
      branch?: string
    }

    if (!query) return c.json({ error: 'Query is required' }, 400)

    const params: Record<string, unknown> = {
      query,
      limit: limit ?? 5,
      content: true,
    }
    if (branch) {
      params.branch = branch
    }

    // ── No projectId: smart fan-out search across ALL indexed repos ──
    if (!projectId) {
      logger.info(`Code search: fan-out across all repos for "${query}"`)
      const allProjects = db.prepare(
        `SELECT id, slug, name, indexed_symbols FROM projects
         WHERE indexed_symbols > 0
         ORDER BY indexed_symbols DESC`
      ).all() as Array<{ id: string; slug: string; name: string; indexed_symbols: number }>

      if (allProjects.length === 0) {
        return c.json({
          success: true,
          data: {
            query,
            limit: limit ?? 5,
            source: 'gitnexus',
            formatted: '⚠️ No indexed repositories found. Index a project via Code Indexing in the dashboard.',
            results: null,
          },
        })
      }

      // Run searches in parallel with concurrency limit
      const CONCURRENCY = 8
      type ProjectHit = { project: typeof allProjects[0]; result: unknown; error?: string }
      const hits: ProjectHit[] = []

      for (let i = 0; i < allProjects.length; i += CONCURRENCY) {
        const batch = allProjects.slice(i, i + CONCURRENCY)
        const batchResults = await Promise.allSettled(
          batch.map(async (p) => {
            const candidates = resolveRepoNames(p.id)
            for (const candidate of candidates) {
              try {
                const r = await callGitNexus('query', { ...params, repo: candidate, limit: 3 })
                return { project: p, result: r }
              } catch { /* try next candidate */ }
            }
            return { project: p, result: null, error: 'no candidates worked' }
          })
        )
        for (const r of batchResults) {
          if (r.status === 'fulfilled' && r.value.result) {
            hits.push(r.value as ProjectHit)
          }
        }
      }

      // Filter out empty results — count meaningful hits per project
      type ScoredHit = { project: typeof allProjects[0]; result: unknown; score: number; symbols?: Array<{ name: string; type: string; file: string }>; via: 'flow' | 'symbol' }
      const scoredHits: ScoredHit[] = hits.map(h => {
        const r = h.result as Record<string, unknown> | null
        const raw = (r?.raw as string) ?? ''
        const isEmpty = raw.includes('No matching execution flows') || raw.includes('No matching results')
        const procCount = (raw.match(/▸/g) ?? []).length
        const defCount = (raw.match(/→/g) ?? []).length
        return {
          project: h.project,
          result: h.result,
          score: isEmpty ? 0 : procCount * 10 + defCount,
          via: 'flow' as const,
        }
      }).filter(s => s.score > 0)

      // ── Fallback: cypher symbol search if flow search found nothing ──
      if (scoredHits.length === 0) {
        logger.info(`Code search: 0 flow matches, falling back to cypher symbol search`)
        // Extract ALL meaningful keywords (3+ chars), preserve order
        const keywords = query.split(/\s+/).filter(w => w.length >= 3)
        if (keywords.length === 0) keywords.push(query)

        // Capitalize first letter for camelCase variants (e.g. "dialog" → "Dialog")
        const expandKeyword = (k: string): string[] => {
          const variants = new Set<string>([k])
          variants.add(k.charAt(0).toUpperCase() + k.slice(1))
          variants.add(k.toLowerCase())
          return Array.from(variants)
        }

        // Helper: parse GitNexus cypher response — handles raw text wrapper
        const parseCypherRows = (r: Record<string, unknown>): Array<{ name: string; type: string; file: string }> => {
          let payload: Record<string, unknown> = r
          // GitNexus returns JSON + "---\nNext: ..." footer → callGitNexus wraps as {raw: "..."}
          if (r?.raw && typeof r.raw === 'string') {
            const rawText = r.raw as string
            const jsonEnd = rawText.indexOf('\n---')
            const jsonStr = jsonEnd > 0 ? rawText.slice(0, jsonEnd).trim() : rawText.trim()
            try { payload = JSON.parse(jsonStr) as Record<string, unknown> } catch { /* not JSON */ }
          }
          const rows = (payload?.rows ?? payload?.results ?? payload?.data) as Array<Record<string, unknown>> | undefined
          if (Array.isArray(rows) && rows.length > 0) {
            return rows.map(row => ({
              name: String(row.name ?? '?'),
              type: Array.isArray(row.labels) ? row.labels.join(',') : String(row.labels ?? ''),
              file: String(row.file ?? ''),
            }))
          }
          const md = (payload?.markdown as string) ?? ''
          if (md && md.includes('|')) {
            const lines = md.split('\n').filter(l => l.includes('|') && !l.match(/^\|\s*-+/))
            return lines.slice(1).map(l => {
              const cells = l.split('|').map(c => c.trim()).filter(c => c.length > 0)
              return { name: cells[0] ?? '?', type: cells[1] ?? '', file: cells[2] ?? '' }
            }).filter(x => x.name !== '?')
          }
          return []
        }

        // Score: count how many keywords appear in the symbol name (case-insensitive)
        const scoreSymbol = (name: string): number => {
          const lower = name.toLowerCase()
          return keywords.filter(k => lower.includes(k.toLowerCase())).length
        }

        // GitNexus has bugs with OR clauses + toLower() → run separate query per keyword variant.
        // Run sequentially per project to avoid hammering GitNexus.
        for (let i = 0; i < allProjects.length; i += CONCURRENCY) {
          const batch = allProjects.slice(i, i + CONCURRENCY)
          const batchResults = await Promise.allSettled(
            batch.map(async (p) => {
              const candidates = resolveRepoNames(p.id)
              const allSymbols: Array<{ name: string; type: string; file: string }> = []
              const seen = new Set<string>()
              let lastErr: unknown = null

              // Try each candidate repo name
              for (const candidate of candidates) {
                let candidateWorked = false
                // For each keyword + its variants, run a simple query
                for (const keyword of keywords) {
                  for (const variant of expandKeyword(keyword)) {
                    try {
                      const safeVariant = variant.replace(/"/g, '\\"')
                      const cypherQuery = `MATCH (n) WHERE n.name CONTAINS "${safeVariant}" RETURN n.name as name, labels(n) as labels, n.filePath as file LIMIT 15`
                      const r = await callGitNexus('cypher', { query: cypherQuery, repo: candidate }) as Record<string, unknown>
                      const symbols = parseCypherRows(r)
                      if (symbols.length > 0) {
                        candidateWorked = true
                        for (const s of symbols) {
                          const key = `${s.name}|${s.file}`
                          if (!seen.has(key)) {
                            seen.add(key)
                            allSymbols.push(s)
                          }
                        }
                      }
                    } catch (e) { lastErr = e }
                  }
                }
                if (candidateWorked) break // stop trying other candidates if one worked
              }

              if (allSymbols.length > 0) {
                const scored = allSymbols
                  .map(s => ({ ...s, relevance: scoreSymbol(s.name) }))
                  .sort((a, b) => b.relevance - a.relevance)
                const totalScore = scored.reduce((sum, s) => sum + s.relevance, 0)
                return { project: p, symbols: scored.slice(0, 10), count: allSymbols.length, score: totalScore }
              }
              if (lastErr) logger.debug(`Cypher search failed for ${p.id}: ${String(lastErr).slice(0, 100)}`)
              return null
            })
          )
          for (const r of batchResults) {
            if (r.status === 'fulfilled' && r.value) {
              scoredHits.push({
                project: r.value.project,
                result: { cypher: true, symbols: r.value.symbols },
                score: r.value.score,
                symbols: r.value.symbols,
                via: 'symbol' as const,
              })
            }
          }
        }
      }

      scoredHits.sort((a, b) => b.score - a.score)

      // Build aggregated formatted output
      const lines: string[] = []
      lines.push(`🔍 Multi-project search: "${query}"`)
      const viaLabel = scoredHits.length > 0 && scoredHits[0]?.via === 'symbol' ? ' (via symbol search)' : ''
      lines.push(`Scanned ${allProjects.length} repos, found matches in ${scoredHits.length}${viaLabel}\n`)

      if (scoredHits.length === 0) {
        lines.push('⚠️ No matches found in any indexed repository (tried flows + symbols).')
        lines.push('\n**Hints:**')
        lines.push('• Try a single keyword instead of a phrase')
        lines.push('• Use cortex_cypher with custom Cypher query')
        lines.push('• Check cortex_list_repos to verify your target project is indexed')
      } else {
        const topProjects = scoredHits.slice(0, 5)
        for (const hit of topProjects) {
          const projName = hit.project.name || hit.project.slug || hit.project.id
          lines.push(`\n## ${projName} (${hit.project.indexed_symbols} symbols)`)

          if (hit.via === 'symbol' && hit.symbols && hit.symbols.length > 0) {
            // Cypher symbol results
            for (const sym of hit.symbols.slice(0, 8)) {
              lines.push(`  → ${sym.name} (${sym.type}) — ${sym.file}`)
            }
          } else {
            // Flow results
            const raw = ((hit.result as Record<string, unknown>)?.raw as string) ?? ''
            const truncated = raw.split('\n').slice(0, 15).join('\n')
            lines.push(truncated)
          }
          lines.push(`💡 Refine: cortex_code_search(query: "${query}", repo: "${hit.project.slug ?? hit.project.name}")`)
        }

        if (scoredHits.length > 5) {
          lines.push(`\n_+${scoredHits.length - 5} more projects with matches. Use \`repo:\` to narrow._`)
        }
      }

      return c.json({
        success: true,
        data: {
          query,
          limit: limit ?? 5,
          source: 'gitnexus',
          formatted: lines.join('\n'),
          results: { multiProject: true, hits: scoredHits.length, scanned: allProjects.length },
        },
      })
    }

    // ── projectId provided: original single-repo search with fallback ──
    const repoCandidates: string[] = resolveRepoNames(projectId)
    params.repo = repoCandidates[0]
    logger.info(`Code search: trying candidates ${JSON.stringify(repoCandidates)} from "${projectId}"`)

    let results: unknown
    let lastError: unknown = null

    for (const candidate of repoCandidates) {
      try {
        params.repo = candidate
        results = await callGitNexus('query', params)
        logger.info(`Code search: success with repo "${candidate}"`)
        lastError = null
        break
      } catch (err) {
        lastError = err
        logger.info(`Code search: "${candidate}" failed, trying next...`)
      }
    }

    if (lastError) throw lastError

    // Format results as readable report
    const formatted = formatSearchResults(query, results)

    return c.json({
      success: true,
      data: {
        query,
        limit: limit ?? 5,
        source: 'gitnexus',
        formatted,
        results,
      },
    })
  } catch (error) {
    logger.error(`Code search failed: ${String(error)}`)
    return c.json(
      {
        success: false,
        error: String(error),
        hint: 'Make sure GitNexus service is running and the repository has been indexed.',
        suggestions: [
          'Try calling cortex_health to check GitNexus status',
          'Ensure the project has been indexed via Code Indexing in the dashboard',
          'Try a broader search query',
        ],
      },
      500,
    )
  }
})

// ── Impact: blast radius analysis ──
intelRouter.post('/impact', async (c) => {
  try {
    const body = await c.req.json()
    const { target, direction, projectId } = body as {
      target: string
      direction?: string
      projectId?: string
    }
    if (!target) return c.json({ error: 'Target is required' }, 400)

    const params: Record<string, unknown> = {
      target,
      direction: direction ?? 'downstream',
    }

    const results = await callGitNexusWithFallback('impact', params, projectId)

    return c.json({
      success: true,
      data: { target, direction: direction ?? 'downstream', results },
    })
  } catch (error) {
    logger.error(`Impact analysis failed: ${String(error)}`)
    return c.json(
      {
        success: false,
        error: String(error),
        hint: 'Ensure the target symbol exists in an indexed repository.',
      },
      500,
    )
  }
})

// ── Context: 360° symbol view ──
intelRouter.post('/context', async (c) => {
  try {
    const body = await c.req.json()
    const { name, projectId, file } = body as {
      name: string
      projectId?: string
      file?: string
    }
    if (!name) return c.json({ error: 'Symbol name is required' }, 400)

    const params: Record<string, unknown> = { name, content: true }
    if (file) params.file = file

    let results = await callGitNexusWithFallback('context', params, projectId) as { raw?: string }

    // Post-process CLI hints
    if (results?.raw) {
      results.raw = rewriteGitNexusHints(results.raw)
    }

    // ── Auto-resolve disambiguation when file param provided ──
    // GitNexus may return "Multiple symbols named 'X'. Disambiguate with file path:"
    // even when file param is set. Auto-resolve by matching file against disambiguation list.
    if (file && results?.raw?.includes('Disambiguate with file path')) {
      const lines = results.raw.split('\n')
      // Find the line matching the provided file path
      // Pattern: "  undefined HandleAttack → GameServer/Logic/NpcAttackLogic.cs:885  (uid: Method:...)"
      const normalizedFile = file.replace(/\\/g, '/')
      const matchingLine = lines.find((line) => {
        // Match against full path or basename
        const pathMatch = line.match(/→\s+(\S+\.(?:cs|ts|js|py|go|rs|java)):/)
        return pathMatch && (
          pathMatch[1] === normalizedFile ||
          pathMatch[1]?.endsWith(normalizedFile) ||
          normalizedFile.endsWith(pathMatch[1] ?? '')
        )
      })

      if (matchingLine) {
        // Extract UID: (uid: Method:GameServer/Logic/NpcAttackLogic.cs:HandleAttack)
        const uidMatch = matchingLine.match(/\(uid:\s+(\S+)\)/)
        if (uidMatch?.[1]) {
          logger.info(`Context auto-disambiguate: resolved "${name}" + file "${file}" → uid "${uidMatch[1]}"`)
          try {
            const retryParams: Record<string, unknown> = { name: uidMatch[1], content: true }
            const retryResults = await callGitNexusWithFallback('context', retryParams, projectId) as { raw?: string }
            if (retryResults?.raw && !retryResults.raw.includes('not found')) {
              retryResults.raw = rewriteGitNexusHints(retryResults.raw)
              results = retryResults
            }
          } catch {
            // Keep original disambiguation result
            logger.warn(`Context auto-disambiguate retry failed for uid "${uidMatch[1]}"`)
          }
        }
      }
    }

    return c.json({
      success: true,
      data: { name, results },
    })
  } catch (error) {
    logger.error(`Context lookup failed: ${String(error)}`)
    return c.json(
      {
        success: false,
        error: String(error),
        hint: 'Ensure the symbol exists in an indexed repository.',
      },
      500,
    )
  }
})

/**
 * Fetch and parse GitNexus repositories, enriched with project DB metadata.
 */
export async function getGitNexusRepos() {
  const gitNexusResult = await callGitNexus('list_repos', {})

  // Enrich with project DB data for project ID mapping
  const projects = db.prepare(
    'SELECT id, slug, name, git_repo_url, indexed_symbols FROM projects'
  ).all() as Array<{ id: string; slug: string; name: string; git_repo_url: string | null; indexed_symbols: number | null }>

  // Build a lookup for matching by slug or repo URL basename
  const projectBySlug = new Map<string, typeof projects[0]>()
  const projectById = new Map<string, typeof projects[0]>()
  for (const p of projects) {
    projectBySlug.set(p.slug?.toLowerCase(), p)
    projectById.set(p.id, p)
    // Also map by git URL basename (e.g., "cortex-hub" from github.com/lktiep/cortex-hub.git)
    if (p.git_repo_url) {
      const basename = p.git_repo_url.replace(/\.git$/, '').split('/').pop()?.toLowerCase()
      if (basename && !projectBySlug.has(basename)) {
        projectBySlug.set(basename, p)
      }
    }
  }

  // Parse GitNexus raw response — may be array, object with repos, or raw text
  type RepoEntry = { name: string; projectId: string; slug: string; symbols: number | string; relationships: number | string; flows: number | string; gitUrl: string; path: string; indexed: string }
  let repos: RepoEntry[] = []

  const rawData = gitNexusResult as Record<string, unknown>
  if (rawData?.raw && typeof rawData.raw === 'string') {
    // GitNexus raw output format (multi-line per repo):
    //   cortex-hub — 909 symbols, 1656 relationships, 69 flows
    //   Path: /app/data/repos/cortex-hub
    //   Indexed: 2026-03-24T02:15:38.013Z
    //
    // Parse by detecting repo lines (contain " — " with stats)
    const lines = rawData.raw.split('\n').map(l => l.trim())

    let currentRepo: Partial<RepoEntry> | null = null

    for (const line of lines) {
      if (!line || line.startsWith('Indexed repositories')) continue

      // Repo name line: "cortex-hub — 909 symbols, 1656 relationships, 69 flows"
      const repoMatch = line.match(/^(.+?)\s+—\s+(\d+)\s+symbols?,\s*(\d+)\s+relationships?,\s*(\d+)\s+flows?/)
      if (repoMatch) {
        // Save previous repo
        if (currentRepo?.name) {
          repos.push(currentRepo as RepoEntry)
        }
        const repoName = repoMatch[1]!.trim()
        const match = projectBySlug.get(repoName.toLowerCase()) ?? projectById.get(repoName)
        currentRepo = {
          name: match?.name ?? repoName,
          projectId: match?.id ?? '',
          slug: match?.slug ?? repoName,
          symbols: match?.indexed_symbols ?? parseInt(repoMatch[2]!, 10),
          relationships: parseInt(repoMatch[3]!, 10),
          flows: parseInt(repoMatch[4]!, 10),
          gitUrl: match?.git_repo_url ?? '',
          path: '',
          indexed: '',
        }
        continue
      }

      // Path line: "Path: /app/data/repos/proj-5b9a75cd"
      if (line.startsWith('Path:') && currentRepo) {
        currentRepo.path = line.replace('Path:', '').trim()
        continue
      }

      // Indexed line: "Indexed: 2026-03-24T02:15:38.013Z"
      if (line.startsWith('Indexed:') && currentRepo) {
        currentRepo.indexed = line.replace('Indexed:', '').trim()
        continue
      }
    }

    // Don't forget the last repo
    if (currentRepo?.name) {
      repos.push(currentRepo as RepoEntry)
    }
  } else if (Array.isArray(rawData)) {
    repos = rawData.map((r: unknown) => {
      const name = typeof r === 'string' ? r : ((r as Record<string, string>).name ?? 'unknown')
      const match = projectBySlug.get(name.toLowerCase()) ?? projectById.get(name)
      return {
        name: match?.name ?? name,
        projectId: match?.id ?? '',
        slug: match?.slug ?? name,
        symbols: match?.indexed_symbols ?? '?',
        relationships: '?',
        flows: '?',
        gitUrl: match?.git_repo_url ?? '',
        path: '',
        indexed: '',
      }
    })
  }
  return repos
}

// ── List Repos: discover indexed repositories with project mapping ──
intelRouter.get('/repos', async (c) => {
  try {
    const repos = await getGitNexusRepos()
    return c.json({ success: true, data: repos })
  } catch (error) {
    logger.error(`List repos failed: ${String(error)}`)
    return c.json(
      { success: false, error: String(error) },
      500,
    )
  }
})

// ── Detect Changes: pre-commit risk analysis ──
intelRouter.post('/detect-changes', async (c) => {
  try {
    const body = await c.req.json()
    const { scope, projectId } = body as {
      scope?: string
      projectId?: string
    }

    const params: Record<string, unknown> = {
      scope: scope ?? 'all',
    }

    const results = await callGitNexusWithFallback('detect_changes', params, projectId)
    return c.json({ success: true, data: results })
  } catch (error) {
    logger.error(`Detect changes failed: ${String(error)}`)
    return c.json(
      { success: false, error: String(error) },
      500,
    )
  }
})

// ── Cypher: direct graph queries ──
intelRouter.post('/cypher', async (c) => {
  try {
    const body = await c.req.json()
    const { query: cypherQuery, projectId } = body as {
      query: string
      projectId?: string
    }

    if (!cypherQuery) return c.json({ error: 'Cypher query is required' }, 400)

    const params: Record<string, unknown> = { query: cypherQuery }

    const results = await callGitNexusWithFallback('cypher', params, projectId)
    return c.json({ success: true, data: results })
  } catch (error) {
    logger.error(`Cypher query failed: ${String(error)}`)
    return c.json(
      { success: false, error: String(error) },
      500,
    )
  }
})

// ── Register: trigger GitNexus analyze on a cloned repo ──
intelRouter.post('/register', async (c) => {
  try {
    const body = await c.req.json()
    const { projectId } = body as { projectId: string }

    if (!projectId) return c.json({ error: 'projectId is required' }, 400)

    // Look up project to get repo path and slug
    const project = db.prepare(
      'SELECT id, slug, git_repo_url FROM projects WHERE id = ?'
    ).get(projectId) as { id: string; slug?: string; git_repo_url?: string } | undefined

    if (!project) return c.json({ error: 'Project not found' }, 404)

    const repoDir = `/app/data/repos/${projectId}`
    const repoName = project.slug || projectId

    logger.info(`Register: analyzing ${repoName} at ${repoDir}`)

    // Call GitNexus eval-server to analyze the repo
    // The eval-server and cortex-api share /app/data volume
    try {
      const analyzeRes = await fetch(`${GITNEXUS_URL()}/tool/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: repoDir, name: repoName }),
        signal: AbortSignal.timeout(120000), // 2 min for analysis
      })

      if (analyzeRes.ok) {
        const result = await analyzeRes.text()
        logger.info(`Register: GitNexus analyze success for ${repoName}`)
        return c.json({ success: true, data: { repoName, result: result.trim() } })
      }

      // If eval-server doesn't have /tool/analyze, the repo needs to be
      // analyzed via CLI in the gitnexus container
      logger.warn(`Register: eval-server analyze returned ${analyzeRes.status}, repo may need manual registration`)
    } catch (err) {
      logger.warn(`Register: eval-server analyze call failed: ${err}`)
    }

    // Fallback: return info about what needs to be done
    return c.json({
      success: false,
      data: {
        repoName,
        repoDir,
        message: 'GitNexus eval-server does not have an analyze endpoint. '
          + 'Run `gitnexus analyze` in the repo directory inside the gitnexus container, '
          + 'or restart the gitnexus container to trigger auto-discovery.',
        hint: 'docker exec cortex-gitnexus sh -c "cd ' + repoDir + ' && gitnexus analyze --force"',
      },
    })
  } catch (error) {
    logger.error(`Register failed: ${String(error)}`)
    return c.json({ success: false, error: String(error) }, 500)
  }
})

// ── Sync: register all cloned repos with GitNexus ──
intelRouter.post('/sync-repos', async (c) => {
  try {
    // Get all projects that have been indexed
    const projects = db.prepare(
      'SELECT id, slug, git_repo_url, indexed_symbols FROM projects WHERE indexed_at IS NOT NULL'
    ).all() as Array<{ id: string; slug?: string; git_repo_url?: string; indexed_symbols?: number }>

    const results: Array<{ projectId: string; slug: string; status: string; error?: string }> = []

    for (const project of projects) {
      const repoName = project.slug || project.id
      const repoDir = `/app/data/repos/${project.id}`

      try {
        // Try to call GitNexus query to check if already registered
        const checkRes = await fetch(`${GITNEXUS_URL()}/tool/query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'test', repo: repoName, limit: 1 }),
          signal: AbortSignal.timeout(5000),
        })

        if (checkRes.ok) {
          results.push({ projectId: project.id, slug: repoName, status: 'already_registered' })
          continue
        }

        const errorText = await checkRes.text()
        if (errorText.includes('not found')) {
          // Not registered — try to analyze
          const analyzeRes = await fetch(`${GITNEXUS_URL()}/tool/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: repoDir, name: repoName }),
            signal: AbortSignal.timeout(120000),
          })

          if (analyzeRes.ok) {
            results.push({ projectId: project.id, slug: repoName, status: 'analyzed' })
          } else {
            results.push({
              projectId: project.id,
              slug: repoName,
              status: 'needs_manual',
              error: `Analyze returned ${analyzeRes.status}`,
            })
          }
        }
      } catch (err) {
        results.push({
          projectId: project.id,
          slug: repoName,
          status: 'error',
          error: String(err),
        })
      }
    }

    return c.json({
      success: true,
      data: {
        total: projects.length,
        results,
        hint: 'To manually register repos, restart the gitnexus container: docker restart cortex-gitnexus',
      },
    })
  } catch (error) {
    logger.error(`Sync repos failed: ${String(error)}`)
    return c.json({ success: false, error: String(error) }, 500)
  }
})

// ── Code Search (Qdrant semantic): search embedded source code ──
intelRouter.post('/code-search', async (c) => {
  try {
    const body = await c.req.json()
    const { query, projectId, branch, limit, file } = body as {
      query: string
      projectId?: string
      branch?: string
      limit?: number
      file?: string
    }

    if (!query) return c.json({ error: 'query is required' }, 400)
    if (!projectId) return c.json({ error: 'projectId is required for code search' }, 400)

    // Resolve collection name
    const collectionName = `cortex-project-${projectId}`

    // Embed the query
    const config: EmbedderConfig = {
      provider: 'gemini' as const,
      apiKey: resolveGeminiApiKey(),
      model: process.env['MEM9_EMBEDDING_MODEL'] || 'gemini-embedding-exp-03-07',
    }
    const embedder = new Embedder(config)
    const vector = await embedder.embed(query)

    // Build Qdrant filter
    const must: Array<Record<string, unknown>> = []
    if (branch) {
      must.push({ key: 'branch', match: { value: branch } })
    }
    if (file) {
      must.push({ key: 'file_path', match: { text: file } })
    }

    const searchLimit = limit ?? 10

    const res = await fetch(`${QDRANT_URL}/collections/${collectionName}/points/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vector,
        limit: searchLimit,
        with_payload: true,
        filter: must.length > 0 ? { must } : undefined,
      }),
      signal: AbortSignal.timeout(10000),
    })

    if (!res.ok) {
      const errText = await res.text()
      // Collection may not exist (project not embedded yet)
      if (errText.includes('Not found') || errText.includes('doesn\'t exist')) {
        return c.json({
          success: true,
          data: {
            query,
            results: [],
            message: `No embedded code found for project ${projectId}. Run Mem9 embedding first via the dashboard.`,
          },
        })
      }
      return c.json({ error: `Qdrant search failed: ${errText}` }, 500)
    }

    const data = (await res.json()) as {
      result?: Array<{ id: string; score: number; payload?: Record<string, unknown> }>
    }

    const results = (data.result ?? []).map((hit) => ({
      score: hit.score,
      filePath: hit.payload?.file_path as string | undefined,
      chunkIndex: hit.payload?.chunk_index as number | undefined,
      content: hit.payload?.content as string | undefined,
      branch: hit.payload?.branch as string | undefined,
    }))

    return c.json({
      success: true,
      data: { query, projectId, results },
    })
  } catch (error) {
    logger.error(`Code search (Qdrant) failed: ${String(error)}`)
    return c.json({ success: false, error: String(error) }, 500)
  }
})

// ── File Content: read raw source file from cloned repo ──
intelRouter.post('/file-content', async (c) => {
  try {
    const body = await c.req.json()
    const { projectId, file, startLine, endLine } = body as {
      projectId: string
      file: string
      startLine?: number
      endLine?: number
    }

    if (!projectId) return c.json({ error: 'projectId is required' }, 400)
    if (!file) return c.json({ error: 'file path is required' }, 400)

    // Resolve any identifier (project ID, name, slug, URL) → actual directory
    // Uses the same resolveRepoNames logic as code_search/code_context
    let resolvedId = projectId
    if (!existsSync(join(REPOS_DIR, projectId))) {
      const candidates = resolveRepoNames(projectId)
      for (const candidate of candidates) {
        if (existsSync(join(REPOS_DIR, candidate))) {
          resolvedId = candidate
          break
        }
      }
    }

    // Security: prevent path traversal
    const normalized = file.replace(/\\/g, '/').replace(/\.\.\/|\.\.$/g, '')
    const repoDir = join(REPOS_DIR, resolvedId)
    const fullPath = join(repoDir, normalized)

    // Ensure path stays within repo dir
    if (!fullPath.startsWith(repoDir)) {
      return c.json({ error: 'Invalid file path (path traversal attempt)' }, 400)
    }

    if (!existsSync(fullPath)) {
      // Try to find file by basename in repo
      const basename = normalized.split('/').pop() ?? ''
      const suggestions = findFilesByName(repoDir, basename, 5)
      return c.json({
        error: `File not found: ${normalized}`,
        suggestions: suggestions.length > 0 ? suggestions : undefined,
        hint: 'Use cortex_code_search to find the correct file path first.',
      }, 404)
    }

    const stat = statSync(fullPath)
    if (!stat.isFile()) {
      return c.json({ error: 'Path is a directory, not a file' }, 400)
    }
    if (stat.size > MAX_READ_SIZE) {
      return c.json({
        error: `File too large (${Math.round(stat.size / 1024)}KB > ${MAX_READ_SIZE / 1024}KB limit)`,
        hint: 'Use startLine/endLine to read a portion of the file.',
      }, 400)
    }

    const content = readFileSync(fullPath, 'utf-8')

    // Optional line range
    if (startLine || endLine) {
      const lines = content.split('\n')
      const start = Math.max(1, startLine ?? 1) - 1
      const end = Math.min(lines.length, endLine ?? lines.length)
      const sliced = lines.slice(start, end)

      return c.json({
        success: true,
        data: {
          file: normalized,
          projectId,
          totalLines: lines.length,
          startLine: start + 1,
          endLine: end,
          content: sliced.join('\n'),
        },
      })
    }

    return c.json({
      success: true,
      data: {
        file: normalized,
        projectId,
        totalLines: content.split('\n').length,
        sizeBytes: stat.size,
        content,
      },
    })
  } catch (error) {
    logger.error(`File content read failed: ${String(error)}`)
    return c.json({ success: false, error: String(error) }, 500)
  }
})

/** Find files by basename in a repo directory (for suggestions) */
function findFilesByName(dir: string, basename: string, maxResults: number): string[] {
  const results: string[] = []
  const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.turbo', 'vendor', 'bin', 'obj'])

  function walk(currentDir: string) {
    if (results.length >= maxResults) return
    let entries: string[]
    try { entries = readdirSync(currentDir) } catch { return }

    for (const entry of entries) {
      if (results.length >= maxResults) return
      if (skipDirs.has(entry) || entry.startsWith('.')) continue

      const fullPath = join(currentDir, entry)
      let stat
      try { stat = statSync(fullPath) } catch { continue }

      if (stat.isDirectory()) {
        walk(fullPath)
      } else if (entry.toLowerCase() === basename.toLowerCase()) {
        results.push(relative(dir, fullPath))
      }
    }
  }

  walk(dir)
  return results
}

// ── Health: check GitNexus service status ──
intelRouter.get('/health', async (c) => {
  try {
    const res = await fetch(`${GITNEXUS_URL()}/health`, {
      signal: AbortSignal.timeout(5000),
    })

    if (!res.ok) {
      return c.json({ status: 'unhealthy', statusCode: res.status }, 503)
    }

    const data = await res.json()
    return c.json({ status: 'healthy', ...data })
  } catch (error) {
    return c.json(
      { status: 'unreachable', error: String(error) },
      503,
    )
  }
})
