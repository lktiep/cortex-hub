import { Hono } from 'hono'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createLogger } from '@cortex/shared-utils'

const execFileAsync = promisify(execFile)
const logger = createLogger('intel')

export const intelRouter = new Hono()

const REPOS_DIR = process.env.REPOS_DIR ?? '/app/data/repos'
const QDRANT_URL = process.env.QDRANT_URL ?? 'http://qdrant:6333'

/**
 * Run a gitnexus CLI command and return stdout.
 */
async function runGitNexus(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync('npx', ['-y', 'gitnexus', ...args], {
    cwd: cwd ?? REPOS_DIR,
    timeout: 30000,
    env: { ...process.env, PATH: process.env.PATH },
  })
  return stdout
}

/**
 * Fallback: vector search via Qdrant when GitNexus is unavailable.
 * Uses the mem9 embed endpoint to vectorize the query, then searches
 * project code collections in Qdrant.
 */
async function vectorCodeSearch(
  query: string,
  limit: number,
  projectId?: string,
): Promise<{ source: string; results: unknown[] }> {
  // Embed the query
  const embedRes = await fetch('http://localhost:4000/api/mem9/embed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: query }),
    signal: AbortSignal.timeout(10000),
  })

  if (!embedRes.ok) {
    throw new Error(`Embedding failed: ${embedRes.status}`)
  }

  const { vector } = (await embedRes.json()) as { vector: number[] }

  // Find collections to search
  const collections: string[] = []
  if (projectId) {
    collections.push(`cortex-project-${projectId}`)
  } else {
    // Search all project collections — list from Qdrant
    const listRes = await fetch(`${QDRANT_URL}/collections`, {
      signal: AbortSignal.timeout(5000),
    })
    if (listRes.ok) {
      const data = (await listRes.json()) as {
        result?: { collections?: Array<{ name: string }> }
      }
      const allCollections = data.result?.collections ?? []
      for (const col of allCollections) {
        if (col.name.startsWith('cortex-project-')) {
          collections.push(col.name)
        }
      }
    }
  }

  if (collections.length === 0) {
    return { source: 'vector', results: [] }
  }

  // Search each collection and merge results
  const allResults: unknown[] = []
  for (const collection of collections) {
    try {
      const searchRes = await fetch(`${QDRANT_URL}/collections/${collection}/points/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vector,
          limit,
          with_payload: true,
        }),
        signal: AbortSignal.timeout(5000),
      })

      if (searchRes.ok) {
        const data = (await searchRes.json()) as {
          result?: Array<{ score: number; payload?: Record<string, unknown> }>
        }
        for (const hit of data.result ?? []) {
          allResults.push({
            collection,
            score: hit.score,
            file_path: hit.payload?.file_path,
            content: hit.payload?.content,
            chunk_index: hit.payload?.chunk_index,
          })
        }
      }
    } catch {
      // Skip unavailable collections
    }
  }

  // Sort by score descending and take top N
  allResults.sort((a, b) => {
    const sa = (a as { score: number }).score
    const sb = (b as { score: number }).score
    return sb - sa
  })

  return { source: 'vector', results: allResults.slice(0, limit) }
}

intelRouter.post('/search', async (c) => {
  const body = await c.req.json()
  const { query, limit, projectId } = body as { query: string; limit?: number; projectId?: string }

  if (!query) return c.json({ error: 'Query is required' }, 400)

  const searchLimit = limit ?? 5

  // Try GitNexus first
  try {
    const args = ['query', query, '-l', String(searchLimit)]
    if (projectId) args.push('-r', projectId)
    args.push('--content')

    const stdout = await runGitNexus(args)

    let results
    try {
      results = JSON.parse(stdout)
    } catch {
      results = { raw: stdout.trim() }
    }

    return c.json({
      success: true,
      data: { query, limit: searchLimit, source: 'gitnexus', results }
    })
  } catch (gitNexusError) {
    logger.warn(`GitNexus failed, falling back to vector search: ${String(gitNexusError).slice(0, 200)}`)
  }

  // Fallback: vector search via Qdrant
  try {
    const vectorResults = await vectorCodeSearch(query, searchLimit, projectId)
    return c.json({
      success: true,
      data: { query, limit: searchLimit, ...vectorResults }
    })
  } catch (vectorError) {
    return c.json({
      success: false,
      error: `Both GitNexus and vector search failed`,
      details: {
        vectorError: String(vectorError),
      },
      hint: 'Index a project first via the Dashboard Indexing panel.',
    }, 500)
  }
})

intelRouter.post('/impact', async (c) => {
  try {
    const body = await c.req.json()
    const { target, direction } = body as { target: string; direction?: string }
    if (!target) return c.json({ error: 'Target is required' }, 400)

    const args = ['impact', target]
    if (direction === 'upstream') args.push('--direction', 'upstream')

    const stdout = await runGitNexus(args)

    let results
    try {
      results = JSON.parse(stdout)
    } catch {
      results = { raw: stdout.trim() }
    }

    return c.json({
      success: true,
      data: { target, direction: direction ?? 'downstream', ...results }
    })
  } catch (error) {
    return c.json({
      success: false,
      error: String(error),
      hint: 'Ensure the target symbol exists in an indexed repository.'
    }, 500)
  }
})
