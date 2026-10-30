import { Hono } from 'hono'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, relative, sep } from 'path'
import { createLogger } from '@cortex/shared-utils'
import { db } from '../db/client.js'
import { createEmbedder } from '../lib/embedder-factory.js'
import { getReranker, RERANK_OVERFETCH } from '../lib/reranker.js'
import { hasSparseVector, buildHybridQuery, HYBRID_FETCH_FLOOR } from '../lib/hybrid-search.js'
import { gitnexusUrl as GITNEXUS_URL, gitnexusHeaders } from '../lib/gitnexus.js'
import { analyzeDiff, parseCypherTable, MAX_DIFF_CHARS, type RunCypher } from '../lib/diff-symbols.js'
import { PERSONAL_ORG, projectOfActiveSession } from '../lib/session-project.js'
import { grepCheckout, type GrepFile, type GrepHit } from '../lib/code-grep.js'

const logger = createLogger('intel')

export const intelRouter = new Hono()

const QDRANT_URL = process.env.QDRANT_URL ?? 'http://qdrant:6333'
const REPOS_DIR = process.env.REPOS_DIR ?? '/app/data/repos'

/** Code search over-fetch, so the copies other branches hold of a chunk do not crowd out the limit. */
const BRANCH_OVERFETCH = 3
/** Where repos are registered when nobody chose an organization; see db/schema.sql. */
/** A repo listed beside the caller's own reaches at least this share of that repo's best score. */
const BESIDE_FLOOR = 0.8

/** Max file size for code_read (512KB) */
const MAX_READ_SIZE = 512 * 1024

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
    headers: gitnexusHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(30000),
  })

  const text = await res.text()

  if (!res.ok) {
    // "Multiple repositories indexed ... Available: <every repo>" names other organizations' repos.
    throw new Error(text.replace(/\s*Available: [^\n]*/g, '') || `GitNexus ${tool} failed: ${res.status}`)
  }

  // GitNexus may return JSON or plain text
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text.trim() }
  }
}

// ── Organization isolation ───────────────────────────────────────────────────────────
//
// Projects live inside an organization, and related repos are grouped by putting them in
// the same one — a game's client, its server and its tools, for instance, so that one
// question can be answered from all three. A multi-project search is therefore meant to
// span an organization, never the whole instance. The fan-out below read
// `SELECT ... FROM projects WHERE indexed_symbols > 0` and returned symbol names, file
// paths and flow summaries from every other organization on the hub.
//
// The scope anchor, in order:
//   1. an explicit orgId on the request
//   2. the project the caller named (projectId, or scopeRepo when the search spans repos),
//      looked up in the caller's own organization first
//   3. the caller's own latest session (X-API-Key-Owner -> session_handoffs.project_id)
//   4. the only organization that owns indexed projects, when there is exactly one
//
// If none of those resolve while several organizations exist, the fan-out is refused
// rather than widened: an agent that cannot say where it is does not get to read
// everywhere. A caller that names one project is a different question — see
// projectOutsideScope below.

type OrgRow = { id: string; name: string; slug: string }
type ProjectRef = { id: string; slug: string; name: string; git_repo_url: string | null; org_id: string }

/**
 * The project a caller means by id, slug or name, optionally looked up inside one
 * organization. The name match is a LIKE, so an exact id/slug/name wins over a partial
 * one: "server" must not resolve to "Yulgang Server Tools" when "Server" exists.
 */
function findProject(ref: string, orgId?: string): ProjectRef | undefined {
  return db.prepare(
    `SELECT id, slug, name, git_repo_url, org_id FROM projects
      WHERE (id = ?
         OR slug = ? COLLATE NOCASE
         OR name = ? COLLATE NOCASE
         OR name LIKE ? COLLATE NOCASE)
        AND (? IS NULL OR org_id = ?)
      ORDER BY (id = ?) DESC,
               (slug = ? COLLATE NOCASE) DESC,
               (name = ? COLLATE NOCASE) DESC
      LIMIT 1`
  ).get(ref, ref, ref, `%${ref}%`, orgId ?? null, orgId ?? null, ref, ref, ref) as ProjectRef | undefined
}

/** The branch a project's remote HEAD names, once the indexer has resolved it. */
function defaultBranchOf(projectId: string): string | undefined {
  const row = db.prepare('SELECT default_branch FROM projects WHERE id = ?').get(projectId) as
    { default_branch: string | null } | undefined
  return row?.default_branch ?? undefined
}

/** org_id of a project named by id, slug or name. undefined when the DB knows no such project. */
function orgOfProject(ref: string | undefined | null, withinOrg?: string): string | undefined {
  if (!ref) return undefined
  try {
    return findProject(ref, withinOrg)?.org_id
  } catch (error) {
    logger.warn(`orgOfProject failed for "${ref}": ${String(error)}`)
    return undefined
  }
}

function orgsWithIndexedProjects(): OrgRow[] {
  try {
    return db.prepare(
      `SELECT DISTINCT o.id AS id, o.name AS name, o.slug AS slug
         FROM organizations o
         JOIN projects p ON p.org_id = o.id
        WHERE p.indexed_symbols > 0
        ORDER BY o.name`
    ).all() as OrgRow[]
  } catch (error) {
    logger.warn(`orgsWithIndexedProjects failed: ${String(error)}`)
    return []
  }
}

/** The organization the caller is currently working in, taken from its most recent session. */
function orgOfActiveSession(apiKeyOwner: string | null | undefined): string | undefined {
  return projectOfActiveSession(apiKeyOwner)?.org_id
}

type OrgScope = {
  orgId?: string
  /** Where the scope came from — logged, and reported when a fan-out is refused. */
  source: 'explicit' | 'project' | 'session' | 'only-org' | 'unresolved'
  /** Populated when source is 'unresolved' and more than one organization has code. */
  candidates?: OrgRow[]
}

function resolveOrgScope(hints: {
  orgId?: string
  projectId?: string
  scopeRepo?: string
  apiKeyOwner?: string | null
}): OrgScope {
  if (hints.orgId) return { orgId: hints.orgId, source: 'explicit' }

  const session = orgOfActiveSession(hints.apiKeyOwner)
  const ref = hints.projectId ?? hints.scopeRepo
  if (ref) {
    // Two organizations may each have a "server". If the caller's own organization has a
    // match, that is the one it means.
    if (session && orgOfProject(ref, session)) return { orgId: session, source: 'session' }
    // Otherwise the project it named decides. The session is not used to refuse a named
    // project: one API key can have sessions open in two organizations at once, and the
    // latest of them says nothing about which one this call came from.
    const named = orgOfProject(ref)
    if (named) return { orgId: named, source: 'project' }
  }

  if (session) return { orgId: session, source: 'session' }

  const orgs = orgsWithIndexedProjects()
  if (orgs.length === 1 && orgs[0]) return { orgId: orgs[0].id, source: 'only-org' }

  return { source: 'unresolved', candidates: orgs }
}

/**
 * True when the caller named a project that belongs to a *different* organization than the
 * one it is working in. A project the DB does not know is not refused: GitNexus also answers
 * to legacy clone names that were never rows in `projects`, and those cannot be attributed
 * to any organization — refusing them would break lookups that have nothing to do with
 * isolation. What matters is that a project we *can* attribute is never read from outside
 * the caller's own organization.
 */
function projectOutsideScope(ref: string | undefined, scope: OrgScope): boolean {
  if (!ref || !scope.orgId) return false
  if (orgOfProject(ref, scope.orgId)) return false
  return orgOfProject(ref) !== undefined
}

function outsideScopeResponse(ref: string) {
  return {
    success: false as const,
    error: `Project "${ref}" belongs to another organization.`,
    hint: 'Projects are isolated per organization. Search within your own organization, or open that project from its own organization.',
  }
}

/** A lookup in a project that has no graph yet; its message says why. */
class NotIndexedError extends Error {}

/** The graph's error, or, when the project has not been indexed yet, why there is nothing to ask it. */
function whyGraphFailed(error: unknown, projectId: string | undefined, orgId: string | undefined): unknown {
  const pending = projectId ? notIndexedYet(projectId, orgId) : undefined
  return pending ? new NotIndexedError(pending) : error
}

type IndexJobRow = { status: string; progress: number | null; error: string | null; started_at: string | null; created_at: string | null }

/** A line of the GitNexus watchdog's status file for one repo (see infra/gitnexus-entrypoint.sh). */
type GraphStatus =
  | { state: 'analyzing' | 'analyzed'; at: number }
  | { state: 'failed'; at: number; failures: number; exitCode: number; retryIn: number }

function readGraphStatus(projectId: string): GraphStatus | undefined {
  let line: string
  try {
    line = readFileSync(join(REPOS_DIR, '.graph-status', projectId), 'utf-8').trim()
  } catch {
    return undefined
  }
  const [state, , at, failures, exitCode, retryIn] = line.split(/\s+/)
  const epoch = Number(at) * 1000
  if (state === 'analyzing' || state === 'analyzed') return { state, at: epoch }
  if (state === 'failed') {
    return { state, at: epoch, failures: Number(failures) || 1, exitCode: Number(exitCode), retryIn: Number(retryIn) || 0 }
  }
  return undefined
}

const minutesSince = (then: number, now: number) => Math.max(0, Math.round((now - then) / 60000))

/**
 * Why a project the caller named has no code graph to ask yet, as a line an agent can act on, or
 * undefined once it has one (or when the DB does not know it). A repo registered at onboarding is
 * cloned by the API's index job and then analysed by the GitNexus watchdog, which works through
 * the repos one at a time; until both finished every lookup in it came back as a 500 "Repository
 * not found", which reads like a broken hub rather than "wait". The job alone cannot tell: it is
 * 'done', with a symbol count from its own regex pass, before the graph exists.
 */
export function notIndexedYet(ref: string, orgId?: string, now = Date.now()): string | undefined {
  let project: { id: string; name: string; indexed_symbols: number | null } | undefined
  let job: IndexJobRow | undefined
  try {
    const found = findProject(ref, orgId)
    if (!found) return undefined
    project = db.prepare('SELECT id, name, indexed_symbols FROM projects WHERE id = ?')
      .get(found.id) as typeof project
    if (!project) return undefined
    job = db.prepare(
      'SELECT status, progress, error, started_at, created_at FROM index_jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(project.id) as IndexJobRow | undefined
  } catch (error) {
    logger.warn(`notIndexedYet failed for "${ref}": ${String(error)}`)
    return undefined
  }

  const graph = readGraphStatus(project.id)
  if (graph?.state === 'analyzed') return undefined

  const meanwhile = 'Use Grep/rg on your checkout meanwhile.'
  if (job && job.status !== 'done' && job.status !== 'error') {
    const since = Date.parse(job.started_at ?? job.created_at ?? '')
    const ago = Number.isNaN(since) ? '' : `, started ${minutesSince(since, now)} min ago`
    return `⏳ ${project.name} is still being indexed (${job.status}, ${job.progress ?? 0}%${ago}). ${meanwhile}`
  }
  if (job?.status === 'error') {
    // A failed clone prints the remote, which may carry a token: keep the host, drop the credentials.
    const why = (job.error ?? '').split('\n').find(l => l.trim())?.replace(/\/\/[^/@\s]+@/g, '//').trim().slice(0, 200)
    return `⚠️ Indexing ${project.name} failed${why ? `: ${why}` : ''}. Re-run it with cortex_code_reindex. ${meanwhile}`
  }
  if (graph?.state === 'analyzing') {
    return `⏳ The code graph of ${project.name} is being built (started ${minutesSince(graph.at, now)} min ago; a large repo takes several). ${meanwhile}`
  }
  if (graph?.state === 'failed') {
    const why = graph.exitCode === 137 ? 'the analyzer was killed, most likely out of memory'
      : graph.exitCode === 124 ? 'the analyzer timed out'
      : `the analyzer exited with ${graph.exitCode}`
    const retry = Math.max(0, Math.round((graph.at + graph.retryIn * 1000 - now) / 60000))
    return `⚠️ Building the code graph of ${project.name} failed ${graph.failures === 1 ? 'once' : `${graph.failures} times`} (${why}); `
      + `it is retried in ${retry} min, or on a new commit. Whoever runs the hub may need to give GitNexus more memory or time. ${meanwhile}`
  }
  if (!job) {
    if ((project.indexed_symbols ?? 0) > 0) return undefined
    return `⚠️ ${project.name} has not been indexed, so there is nothing to search. Start it with cortex_code_reindex. ${meanwhile}`
  }
  // Cloned, but the watchdog has not reached it: the analyzer writes .gitnexus into the checkout.
  if (!existsSync(join(REPOS_DIR, project.id, '.gitnexus'))) {
    return `⏳ ${project.name} is cloned and waiting for its code graph to be built. ${meanwhile}`
  }
  if ((project.indexed_symbols ?? 0) > 0) return undefined
  return `⚠️ ${project.name} was indexed, but no symbols were found in it. ${meanwhile}`
}

/**
 * Resolve a projectId, slug, or human-readable name to GitNexus-compatible repo name candidates.
 * Returns ordered list of names to try — GitNexus may register repos by:
 *   0. absolute clone path (e.g., '/app/data/repos/proj-abc123') — unambiguous
 *   1. slug (e.g., 'my-backend')
 *   2. git URL basename (e.g., 'MyBackend')
 *   3. projectId folder name (e.g., 'proj-abc123')
 *
 * Supports case-insensitive matching and search by name column,
 * so agents can just say repo: "MyBackend" without needing a projectId.
 */
function resolveRepoNames(projectId: string, orgId?: string): string[] {
  const candidates: string[] = []

  let project: ProjectRef | undefined

  try {
    // Case-insensitive lookup by id, slug or name. The name match is a LIKE, so without
    // the org constraint "client" could resolve to another organization's project.
    project = findProject(projectId, orgId)
  } catch (error) {
    logger.warn(`resolveRepoNames: DB lookup failed: ${error}`)
  }

  // The clone path, tried before any name, because it is the only key that
  // cannot be ambiguous.
  //
  // GitNexus registers a repo under its directory basename, and a repo cloned
  // twice therefore registers twice under one name — a legacy
  // /app/data/repos/cortex-hub beside the current /app/data/repos/proj-30946766
  // both answered to "cortex-hub". It then refuses the name outright ("Multiple
  // registered repos match") while also rejecting the project id, which is not
  // a name it knows, so every candidate below failed and cortex_code_search
  // returned 500 for this repo — the one repo the agents editing it search most.
  // Its own error says to pass the absolute path instead; that path is unique by
  // construction, so ask by path and let the names stay a fallback.
  if (project?.id) {
    candidates.push(join(REPOS_DIR, project.id))
  } else if (projectId.startsWith('proj-')) {
    // Unknown to the DB but shaped like an id: the directory is still the best guess.
    candidates.push(join(REPOS_DIR, projectId))
  }

  // If it doesn't look like an internal ID, try as-is next
  if (!projectId.startsWith('proj-') && !candidates.includes(projectId)) {
    candidates.push(projectId)
  }

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

  // Last resort: use input directly
  if (candidates.length === 0) {
    candidates.push(projectId)
  }

  return candidates
}

/**
 * Call GitNexus with multi-candidate repo fallback.
 * Tries each repo name candidate until one succeeds, then falls back to no-repo mode.
 */
async function callGitNexusWithFallback(
  tool: string,
  params: Record<string, unknown>,
  projectId?: string,
  orgId?: string,
): Promise<unknown> {
  if (!projectId) {
    return callGitNexusAcrossOrg(tool, params, orgId)
  }

  const candidates = resolveRepoNames(projectId, orgId)
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

function indexedProjectsOf(orgId: string): Array<{ id: string; name: string }> {
  return db.prepare('SELECT id, name FROM projects WHERE org_id = ? AND indexed_symbols > 0 ORDER BY name')
    .all(orgId) as Array<{ id: string; name: string }>
}

/** A GitNexus answer that names nothing: the symbol is not in that repo, or the query failed. */
function foundNothing(result: unknown): boolean {
  const text = typeof (result as { raw?: unknown })?.raw === 'string' ? (result as { raw: string }).raw : JSON.stringify(result)
  return /not found|^Error/i.test(text ?? '')
}

/**
 * A graph lookup that names no project. GitNexus without a repo answers only while it holds a
 * single one; with more it refused, and listed every repo it holds, every organization's. So each
 * indexed project of the caller's organization is asked by its own name, and the answers that
 * found something are kept, under the project's name when there are several.
 */
async function callGitNexusAcrossOrg(tool: string, params: Record<string, unknown>, orgId?: string): Promise<unknown> {
  if (!orgId) {
    if (orgsWithIndexedProjects().length > 1) {
      throw new Error('Several organizations hold indexed code: name the repo, or pass org.')
    }
    return callGitNexus(tool, params)
  }
  const projects = indexedProjectsOf(orgId)
  if (projects.length === 0) return callGitNexus(tool, params)
  if (projects.length === 1) return callGitNexusWithFallback(tool, params, projects[0]?.id, orgId)

  const answers = await Promise.all(projects.map(async (project) => {
    try {
      return { project, result: await callGitNexusWithFallback(tool, params, project.id, orgId) }
    } catch (error) {
      return { project, error }
    }
  }))
  const found = answers.filter((a) => !a.error && !foundNothing(a.result))
  if (found.length === 1) return found[0]?.result
  if (found.length > 1) {
    if (found.every((a) => typeof (a.result as { raw?: unknown }).raw === 'string')) {
      return { raw: found.map((a) => `## ${a.project.name}\n${(a.result as { raw: string }).raw}`).join('\n\n') }
    }
    return found[0]?.result
  }
  const answered = answers.find((a) => !a.error)
  if (answered) return answered.result
  throw answers[0]?.error ?? new Error(`GitNexus ${tool} failed`)
}

/**
 * Cypher bound to one project's graph, or null when none of its names reaches one.
 *
 * GitNexus answers a failed query with HTTP 200 and an "Error: ..." body, so the generic
 * fallback above would accept the first candidate name whether or not it is a repo. Each
 * candidate is probed with a query that cannot fail on a real graph instead. There is
 * deliberately no repo-less fallback: a diff belongs to one repository, and on a hub with a
 * single indexed repo that fallback would map it onto somebody else's code.
 */
async function cypherForProject(ref: string, orgId?: string): Promise<{ repo: string; run: RunCypher } | null> {
  for (const candidate of resolveRepoNames(ref, orgId)) {
    try {
      parseCypherTable(await callGitNexus('cypher', { query: 'RETURN 1 AS ok', repo: candidate }))
      return { repo: candidate, run: (query) => callGitNexus('cypher', { query, repo: candidate }) }
    } catch {
      logger.info(`cypherForProject: "${candidate}" is not a graph for ${ref}, trying next...`)
    }
  }
  return null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GitNexusResult = Record<string, any>

/**
 * Post-process GitNexus raw text to replace CLI hints with MCP tool references.
 */
export function rewriteGitNexusHints(text: string): string {
  return text
    // A symbol with no kind prints as "undefined": a flow step as "undefined main → file", an
    // edge as "[calls] undefined index.ts → file". It is noise in every result an agent reads.
    .replace(/^(\s+)undefined (?=\S)/gm, '$1')
    .replace(/(\[\w+\]) undefined (?=\S)/g, '$1 ')
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

const CYPHER_SCHEMA_HINT =
  '💡 Node labels: Function, Method, Class, Interface, TypeAlias, Const, Property, File, Folder, Route. ' +
  'Every edge is one table, CodeRelation, with its kind in r.type (CALLS, IMPORTS, DEFINES, HAS_METHOD, ' +
  'EXTENDS, IMPLEMENTS, ACCESSES, HANDLES_ROUTE). Properties: id, name, filePath, startLine, endLine.\n' +
  'Example: MATCH (a)-[r:CodeRelation {type: \'CALLS\'}]->(b:Function {name: \'X\'}) RETURN a.name, labels(a) AS type, a.filePath LIMIT 20'

/**
 * A cypher answer as an agent reads it. The graph returns a table as JSON — {"markdown": "| a |
 * …", "row_count": 2} — which reached agents escaped twice, every row break a literal \n. And it
 * answers a failed query with HTTP 200 and an "Error:" body, so the schema is named right there:
 * the usual failure is guessing an edge table such as [:CALLS], which does not exist.
 */
export function formatCypherRaw(raw: string): string {
  let text = rewriteGitNexusHints(raw).replace(/^\{\n[\s\S]*?\n\}$/gm, (block) => {
    try {
      const { markdown, row_count: rows } = JSON.parse(block) as { markdown?: unknown; row_count?: unknown }
      return typeof markdown === 'string' ? `${markdown}\n(${String(rows)} row${rows === 1 ? '' : 's'})` : block
    } catch {
      return block
    }
  })
  if (/^Error:/m.test(text) && /does not exist|Cannot find property|Binder exception/.test(text)) {
    text += `\n${CYPHER_SCHEMA_HINT}`
  }
  return text
}

const MAX_CALL_SITES = 6

/**
 * The lines of each caller's file that name the symbol. The graph keeps one edge per file and
 * prints the caller as a bare path, so every lookup of callers was followed by an `rg` of the
 * repository for the line numbers. Import lines are left out: they name the symbol but call
 * nothing. A file the checkout does not hold, or no longer names the symbol in, stays bare.
 */
export function addCallSites(raw: string, name: string, readSource: (path: string) => string | undefined): string {
  // A method asked for as `Class.method` is called as `.method`.
  const word = name.split(/[.:#]/).pop() ?? name
  const named = new RegExp(`(^|[^\\w$])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`)
  const withSites = (line: string, head: string, path: string, tail = ''): string => {
    if (/:\d/.test(path)) return line
    const lines = readSource(path)?.split('\n')
    if (!lines) return line
    const sites: number[] = []
    lines.forEach((text, i) => {
      if (named.test(text) && !/^\s*import\b/.test(text)) sites.push(i + 1)
    })
    if (sites.length === 0) return line
    const more = sites.length > MAX_CALL_SITES ? ` (+${sites.length - MAX_CALL_SITES} more)` : ''
    return `${head}${path}:${sites.slice(0, MAX_CALL_SITES).join(',')}${more}${tail}`
  }
  return raw
    // code_context: "  ← [calls] intel.ts → apps/api/src/routes/intel.ts"
    .replace(/^(\s*← \[\w+\] .*→ )(\S+)[ \t]*$/gm, (line, head: string, path: string) => withSites(line, head, path))
    // code_impact upstream: "  intel.ts → apps/api/src/routes/intel.ts [CALLS] (conf: 0.85)"
    .replace(/^(\s+\S+ → )(\S+)( \[CALLS\].*)$/gm, (line, head: string, path: string, tail: string) =>
      withSites(line, head, path, tail))
}

/**
 * The checkout a graph result reads from. Without a project the graph answers across the
 * organization, so the checkout is the project's that holds a file the result names: where the
 * symbol is defined for code_context, the first caller for code_impact.
 */
function graphCheckout(raw: string, projectId: string | undefined, orgId: string | undefined): string | undefined {
  try {
    if (projectId) {
      const dir = join(REPOS_DIR, findProject(projectId, orgId)?.id ?? projectId)
      return existsSync(dir) ? dir : undefined
    }
    const definedIn = raw.match(/^\S+ \S+ → (\S+?):\d/m)?.[1] ?? raw.match(/→ (\S+) \[CALLS\]/)?.[1]
    if (!definedIn) return undefined
    const projects = db.prepare('SELECT id FROM projects WHERE (? IS NULL OR org_id = ?)')
      .all(orgId ?? null, orgId ?? null) as Array<{ id: string }>
    return projects.map((p) => join(REPOS_DIR, p.id)).find((dir) => existsSync(join(dir, definedIn)))
  } catch {
    return undefined
  }
}

function readCheckoutFile(repoDir: string, path: string): string | undefined {
  const fullPath = join(repoDir, path)
  if (!fullPath.startsWith(`${repoDir}${sep}`)) return undefined
  try {
    if (!existsSync(fullPath) || statSync(fullPath).size > MAX_READ_SIZE) return undefined
    return readFileSync(fullPath, 'utf-8')
  } catch {
    return undefined
  }
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
    const { query, limit, projectId, branch, orgId, scopeRepo } = body as {
      query: string
      limit?: number
      projectId?: string
      branch?: string
      orgId?: string
      /** The repo the caller is working in. Anchors a multi-project search to its organization. */
      scopeRepo?: string
    }

    if (!query) return c.json({ error: 'Query is required' }, 400)

    const scope = resolveOrgScope({
      orgId,
      projectId,
      scopeRepo,
      apiKeyOwner: c.req.header('X-API-Key-Owner'),
    })
    if (projectOutsideScope(projectId, scope)) {
      return c.json(outsideScopeResponse(projectId as string), 403)
    }

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
      // Several organizations have code and nothing says which one the caller is in. Widening
      // the search would read across the isolation boundary, so say what is missing instead.
      if (!scope.orgId) {
        const names = (scope.candidates ?? []).map(o => `${o.name} (orgId: ${o.id})`).join(', ')
        return c.json({
          success: true,
          data: {
            query,
            limit: limit ?? 5,
            source: 'gitnexus',
            formatted: '⚠️ Multi-project search needs to know which organization to search.\n\n'
              + 'Projects are isolated per organization, so a search across repos stays inside one.\n'
              + `Organizations with indexed code: ${names || 'none'}\n\n`
              + 'Pass `repo:` to search one project, or `org:` to search every repo in that organization.',
            results: null,
          },
        })
      }

      logger.info(`Code search: fan-out across org ${scope.orgId} (via ${scope.source}) for "${query}"`)
      const allProjects = db.prepare(
        `SELECT id, slug, name, indexed_symbols FROM projects
         WHERE indexed_symbols > 0
           AND org_id = ?
         ORDER BY indexed_symbols DESC`
      ).all(scope.orgId) as Array<{ id: string; slug: string; name: string; indexed_symbols: number }>

      if (allProjects.length === 0) {
        return c.json({
          success: true,
          data: {
            query,
            limit: limit ?? 5,
            source: 'gitnexus',
            formatted: '⚠️ No indexed repositories found in this organization. Index a project via Code Indexing in the dashboard.',
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
                // Quadratic score: multi-keyword matches weigh exponentially more.
                // 1 kw = 1, 2 kw = 4, 3 kw = 9 — strongly prefers symbols matching ALL keywords.
                const totalScore = scored.reduce((sum, s) => sum + (s.relevance * s.relevance), 0)
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

      // Sort by best match quality first, then total volume.
      // Projects with at least 1 multi-keyword match always rank above
      // projects with only single-keyword matches, regardless of volume.
      scoredHits.sort((a, b) => {
        const maxA = a.symbols ? Math.max(0, ...a.symbols.map(s => (s as { relevance?: number }).relevance ?? 0)) : 0
        const maxB = b.symbols ? Math.max(0, ...b.symbols.map(s => (s as { relevance?: number }).relevance ?? 0)) : 0
        if (maxA !== maxB) return maxB - maxA
        return b.score - a.score
      })

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
            // Filter out File/Folder/Section noise — prefer actual code symbols
            const codeSyms = hit.symbols.filter(s => !['File', 'Folder', 'Section'].includes(s.type))
            const showSyms = codeSyms.length > 0 ? codeSyms : hit.symbols
            for (const sym of showSyms.slice(0, 8)) {
              lines.push(`  → ${sym.name} (${sym.type}) — ${sym.file}`)
            }
          } else {
            // Flow results
            const raw = ((hit.result as Record<string, unknown>)?.raw as string) ?? ''
            const truncated = rewriteGitNexusHints(raw).split('\n').slice(0, 15).join('\n')
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
    const repoCandidates: string[] = resolveRepoNames(projectId, scope.orgId)
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

    if (lastError) {
      // A repo registered at onboarding is indexed in the background: say so, not 500.
      const pending = notIndexedYet(projectId, scope.orgId)
      if (pending) {
        return c.json({ success: true, data: { query, limit: limit ?? 5, source: 'gitnexus', formatted: pending, results: null, pending: true } })
      }
      throw lastError
    }

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
    const { target, direction, projectId, orgId } = body as {
      target: string
      direction?: string
      projectId?: string
      orgId?: string
    }
    if (!target) return c.json({ error: 'Target is required' }, 400)

    // A named project is only refused when we know the caller's organization and the
    // project belongs to a different one. See projectOutsideScope.
    const scope = resolveOrgScope({ orgId, projectId, apiKeyOwner: c.req.header('X-API-Key-Owner') })
    if (projectOutsideScope(projectId, scope)) {
      return c.json(outsideScopeResponse(projectId as string), 403)
    }

    const params: Record<string, unknown> = {
      target,
      direction: direction ?? 'downstream',
    }

    const results = await callGitNexusWithFallback('impact', params, projectId, scope.orgId)
      .catch((error: unknown) => { throw whyGraphFailed(error, projectId, scope.orgId) }) as { raw?: string }
    if (typeof results?.raw === 'string') {
      results.raw = rewriteGitNexusHints(results.raw)
      // Upstream, the callers are what breaks: name the lines that call, as code_context does.
      if (params.direction === 'upstream' && results.raw.includes('[CALLS]')) {
        const repoDir = graphCheckout(results.raw, projectId, scope.orgId)
        if (repoDir) results.raw = addCallSites(results.raw, target, (path) => readCheckoutFile(repoDir, path))
      }
    }

    return c.json({
      success: true,
      data: { target, direction: direction ?? 'downstream', results },
    })
  } catch (error) {
    if (error instanceof NotIndexedError) return c.json({ success: false, error: error.message }, 409)
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
    const { name, projectId, file, orgId } = body as {
      name: string
      projectId?: string
      file?: string
      orgId?: string
    }
    if (!name) return c.json({ error: 'Symbol name is required' }, 400)

    // A named project is only refused when we know the caller's organization and the
    // project belongs to a different one. See projectOutsideScope.
    const scope = resolveOrgScope({ orgId, projectId, apiKeyOwner: c.req.header('X-API-Key-Owner') })
    if (projectOutsideScope(projectId, scope)) {
      return c.json(outsideScopeResponse(projectId as string), 403)
    }

    const params: Record<string, unknown> = { name, content: true }
    if (file) params.file = file

    let results = await callGitNexusWithFallback('context', params, projectId, scope.orgId)
      .catch((error: unknown) => { throw whyGraphFailed(error, projectId, scope.orgId) }) as { raw?: string }

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
      // Pattern: "  undefined MyFunction → src/services/auth.ts:42  (uid: Method:...)"
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
        // Extract UID: (uid: Method:src/services/auth.ts:validateToken)
        const uidMatch = matchingLine.match(/\(uid:\s+(\S+)\)/)
        if (uidMatch?.[1]) {
          logger.info(`Context auto-disambiguate: resolved "${name}" + file "${file}" → uid "${uidMatch[1]}"`)
          try {
            const retryParams: Record<string, unknown> = { name: uidMatch[1], content: true }
            const retryResults = await callGitNexusWithFallback('context', retryParams, projectId, scope.orgId) as { raw?: string }
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

    if (results?.raw?.includes('←')) {
      const repoDir = graphCheckout(results.raw, projectId, scope.orgId)
      if (repoDir) results.raw = addCallSites(results.raw, name, (path) => readCheckoutFile(repoDir, path))
    }

    return c.json({
      success: true,
      data: { name, results },
    })
  } catch (error) {
    if (error instanceof NotIndexedError) return c.json({ success: false, error: error.message }, 409)
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
/**
 * GitNexus repos, mapped to projects. With `scope.orgId` the listing is restricted to that
 * organization: this is what agents call to discover what they can search, and it used to
 * name every repo on the instance. Every repo is mapped against *all* projects first, so a
 * repo that belongs to another organization is recognised as such and never passes for an
 * unattributed one. Unattributed repos (legacy clones, repos registered by hand) are kept
 * only when `keepUnattributed` says they cannot belong to anyone else.
 */
export async function getGitNexusRepos(scope: { orgId?: string; keepUnattributed?: boolean } = {}) {
  const gitNexusResult = await callGitNexus('list_repos', {})

  // Enrich with project DB data for project ID mapping
  const projects = db.prepare(
    'SELECT id, slug, name, git_repo_url, indexed_symbols, org_id FROM projects'
  ).all() as Array<{ id: string; slug: string; name: string; git_repo_url: string | null; indexed_symbols: number | null; org_id: string }>
  const orgOfProjectId = new Map(projects.map(p => [p.id, p.org_id]))

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

  if (!scope.orgId) return repos
  return repos.filter(r => r.projectId
    ? orgOfProjectId.get(r.projectId) === scope.orgId
    : scope.keepUnattributed === true)
}

// ── List Repos: discover indexed repositories with project mapping ──
intelRouter.get('/repos', async (c) => {
  try {
    const scope = resolveOrgScope({
      orgId: c.req.query('orgId') ?? undefined,
      scopeRepo: c.req.query('repo') ?? undefined,
      apiKeyOwner: c.req.header('X-API-Key-Owner'),
    })
    // Same rule as the fan-out: with several organizations and nothing to say which one the
    // caller is in, name the organizations rather than every repo in all of them.
    if (!scope.orgId && (scope.candidates?.length ?? 0) > 1) {
      return c.json({
        success: true,
        data: [],
        orgId: null,
        organizations: scope.candidates,
        hint: 'Projects are isolated per organization. Pass orgId to list one organization\'s repos.',
      })
    }
    // With only one organization holding code, an unattributed clone cannot be anyone else's.
    const repos = await getGitNexusRepos({ orgId: scope.orgId, keepUnattributed: scope.source === 'only-org' })
    return c.json({ success: true, data: repos, orgId: scope.orgId ?? null })
  } catch (error) {
    logger.error(`List repos failed: ${String(error)}`)
    return c.json(
      { success: false, error: String(error) },
      500,
    )
  }
})

// ── Detect Changes: pre-commit risk analysis ──
//
// The hub's clone never holds the caller's uncommitted work, so asking GitNexus to run
// `git diff` there reported "No changes detected" for every change an agent was about to
// commit. The caller sends its diff instead and it is mapped onto the graph here. What the
// hub can answer by itself is a comparison of history it has, so scope "compare" still
// goes to GitNexus; the working-tree scopes without a diff are refused with the fix.
const WORKING_TREE_DIFF: Record<string, string> = {
  staged: 'git diff --staged',
  unstaged: 'git diff',
  all: 'git diff HEAD',
}

intelRouter.post('/detect-changes', async (c) => {
  try {
    const body = await c.req.json()
    const { scope, projectId, orgId, diff, baseRef } = body as {
      scope?: string
      projectId?: string
      orgId?: string
      diff?: unknown
      baseRef?: string
    }
    const apiKeyOwner = c.req.header('X-API-Key-Owner')

    if (diff !== undefined) {
      if (typeof diff !== 'string') {
        return c.json({ success: false, error: 'diff must be the text of a unified diff.' }, 400)
      }
      if (diff.length > MAX_DIFF_CHARS) {
        return c.json(
          {
            success: false,
            error: `The diff is ${diff.length} characters; the limit is ${MAX_DIFF_CHARS}.`,
            hint: 'Check the change in parts: pass `git diff --staged -- <paths>` for a subset of files.',
          },
          413,
        )
      }

      // A diff belongs to one repository: the one named, else the one the caller's session opened.
      const ref = projectId ?? projectOfActiveSession(apiKeyOwner)?.id
      if (!ref) {
        return c.json(
          {
            success: false,
            error: 'No repository to map the diff onto.',
            hint: 'Pass repo (e.g. "cortex-hub"), or call cortex_session_start for this repo first.',
          },
          400,
        )
      }
      const orgScope = resolveOrgScope({ orgId, projectId: ref, apiKeyOwner })
      if (projectOutsideScope(ref, orgScope)) {
        return c.json(outsideScopeResponse(ref), 403)
      }

      const graph = await cypherForProject(ref, orgScope.orgId)
      if (!graph) {
        return c.json(
          {
            success: false,
            error: `"${ref}" has no code graph on this hub, so the diff cannot be mapped onto it.`,
            hint: 'Index the repo first (cortex_code_reindex), then check the change again.',
          },
          404,
        )
      }

      const impact = await analyzeDiff(diff, graph.run)
      return c.json({ success: true, data: { ...impact, repo: ref } })
    }

    if (scope === 'compare') {
      if (!baseRef) {
        return c.json({ success: false, error: 'scope "compare" needs baseRef, e.g. "master" or "v0.8.3".' }, 400)
      }
      const orgScope = resolveOrgScope({ orgId, projectId, apiKeyOwner })
      if (projectOutsideScope(projectId, orgScope)) {
        return c.json(outsideScopeResponse(projectId as string), 403)
      }
      const results = await callGitNexusWithFallback(
        'detect_changes',
        { scope: 'compare', base_ref: baseRef },
        projectId,
        orgScope.orgId,
      )
      return c.json({ success: true, data: results })
    }

    // Instructions written before the diff parameter existed still call scope "staged" or
    // "all" alone, and a git worktree cut from such a commit carries them however current the
    // main checkout is. Name the one command that makes the call work, rather than leave the
    // agent to work out that the tool it was told to use needs something else.
    const command = WORKING_TREE_DIFF[scope ?? 'all'] ?? 'git diff HEAD'
    return c.json(
      {
        success: false,
        error:
          `The hub cannot see your working tree, so scope "${scope ?? 'all'}" alone would report ` +
          `no changes whatever you have edited. Run \`${command}\` and call again with diff set to its output.`,
        hint:
          'Run it in the directory you edited: in a git worktree that is the worktree, since the main ' +
          'checkout does not hold its changes. `git diff --staged` is what the next commit contains, ' +
          '`git diff HEAD` all uncommitted work; for a large change add `-U0` and keep only the ' +
          '`diff`/`---`/`+++`/`@@` lines. Instructions that call cortex_detect_changes with a scope and ' +
          'no diff predate the diff parameter. To compare the indexed code against a ref, pass scope ' +
          '"compare" with baseRef.',
        command,
      },
      400,
    )
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
    const { query: cypherQuery, projectId, orgId } = body as {
      query: string
      projectId?: string
      orgId?: string
    }

    if (!cypherQuery) return c.json({ error: 'Cypher query is required' }, 400)

    // A named project is only refused when we know the caller's organization and the
    // project belongs to a different one. See projectOutsideScope.
    const scope = resolveOrgScope({ orgId, projectId, apiKeyOwner: c.req.header('X-API-Key-Owner') })
    if (projectOutsideScope(projectId, scope)) {
      return c.json(outsideScopeResponse(projectId as string), 403)
    }

    const params: Record<string, unknown> = { query: cypherQuery }

    const results = await callGitNexusWithFallback('cypher', params, projectId, scope.orgId)
      .catch((error: unknown) => { throw whyGraphFailed(error, projectId, scope.orgId) }) as { raw?: string }
    if (typeof results?.raw === 'string') results.raw = formatCypherRaw(results.raw)
    return c.json({ success: true, data: results })
  } catch (error) {
    if (error instanceof NotIndexedError) return c.json({ success: false, error: error.message }, 409)
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
        headers: gitnexusHeaders({ 'Content-Type': 'application/json' }),
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
          headers: gitnexusHeaders({ 'Content-Type': 'application/json' }),
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
            headers: gitnexusHeaders({ 'Content-Type': 'application/json' }),
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
    const { query, projectId, branch, limit, file, orgId, scopeRepo, exclude, perRepo } = body as {
      query: string
      projectId?: string
      branch?: string
      limit?: number
      file?: string
      orgId?: string
      /** The repo the caller is working in. Anchors a search across repos to its organization. */
      scopeRepo?: string
      /** Without projectId: a repo to leave out, the one the caller already searched on its own. */
      exclude?: string
      /** Without projectId: at most this many files from any one repo. */
      perRepo?: number
    }

    if (!query) return c.json({ error: 'query is required' }, 400)
    if (!projectId) {
      const scope = resolveOrgScope({ orgId, scopeRepo, apiKeyOwner: c.req.header('X-API-Key-Owner') })
      if (!scope.orgId) {
        return c.json({ success: false, error: 'Several organizations hold indexed code: name the repo, or pass org.' }, 400)
      }
      // The repos beside the caller's are worth showing only where someone grouped them. The
      // personal organization is where every repo lands unasked, so its neighbours are unrelated:
      // measured on one, they outscored the caller's own top hit for 15 of 15 gold queries.
      if (exclude && scope.orgId === PERSONAL_ORG) {
        return c.json({ success: true, data: { query, orgId: scope.orgId, retrieval: 'vector', results: [] } })
      }
      const results = await searchOrganization(query, scope.orgId, { branch, limit: limit ?? 10, exclude, perRepo })
      return c.json({ success: true, data: { query, orgId: scope.orgId, retrieval: 'vector', results } })
    }

    // One Qdrant collection per project, so this route is single-project by construction —
    // but the project it is handed still has to be one the caller may read.
    const scope = resolveOrgScope({ orgId, projectId, apiKeyOwner: c.req.header('X-API-Key-Owner') })
    if (projectOutsideScope(projectId, scope)) {
      return c.json(outsideScopeResponse(projectId), 403)
    }

    // The collection is named after the project id, and agents name the repo ("cortex-hub")
    // as the tool tells them to. Searching cortex-project-cortex-hub found no collection and
    // said so only in a message nobody showed, so every such search came back empty.
    const project = findProject(projectId, scope.orgId)
    const collectionName = `cortex-project-${project?.id ?? projectId}`

    // Embed query through LLM gateway — routes to configured provider (Ollama bge-m3:latest)
    const embedder = createEmbedder()
    const vector = await embedder.embed(query)

    // A project indexed on several branches holds a copy of every chunk per branch, and an
    // unfiltered search spends its depth on the copies: 30 hits on a repo with seven branches
    // came back as 3–7 files, and the expected file was in the top 10 for 10 of 15 gold queries
    // (13 of 15 on one branch). Unless the caller names a branch, search the project's default
    // branch, and every branch only when that one holds nothing.
    const defaultBranch = branch ? undefined : defaultBranchOf(project?.id ?? projectId)

    const searchLimit = limit ?? 10

    // With a reranker configured, over-fetch and let it decide the final order.
    // A single embedding can only answer "is this similar"; the reranker answers
    // "does this actually contain what was asked for", which is what lifts the
    // top few hits. Without one this stays an exact-limit vector search.
    const reranker = getReranker()
    const fetchLimit = Math.min(searchLimit * (reranker ? RERANK_OVERFETCH : BRANCH_OVERFETCH), 50)

    // Fuse a BM25 arm in when the collection was indexed with one. Each arm
    // returns its own ranking and Qdrant merges them by reciprocal rank, so a
    // chunk that both arms like outranks one that only looks similar. Collections
    // indexed before this existed have no sparse vector and search exactly as
    // before.
    const sparse = await hasSparseVector(QDRANT_URL, collectionName)
    const ask = (onBranch: string | undefined) => {
      const must: Array<Record<string, unknown>> = []
      if (onBranch) must.push({ key: 'branch', match: { value: onBranch } })
      if (file) must.push({ key: 'file_path', match: { text: file } })
      const filter = must.length > 0 ? { must } : undefined
      return sparse
        ? fetch(`${QDRANT_URL}/collections/${collectionName}/points/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildHybridQuery({ vector, query, limit: Math.max(fetchLimit, HYBRID_FETCH_FLOOR), filter })),
            signal: AbortSignal.timeout(10000),
          })
        : fetch(`${QDRANT_URL}/collections/${collectionName}/points/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ vector, limit: fetchLimit, with_payload: true, filter }),
            signal: AbortSignal.timeout(10000),
          })
    }
    // /points/search answers with an array, /points/query wraps it in `points`.
    type Point = { id: string; score: number; payload?: Record<string, unknown> }
    const pointsOf = async (r: Response) => {
      const data = (await r.json()) as { result?: Point[] | { points?: Point[] } }
      return Array.isArray(data.result) ? data.result : (data.result?.points ?? [])
    }

    const asked = branch ?? defaultBranch
    const res = await ask(asked)

    if (!res.ok) {
      const errText = await res.text()
      // Collection may not exist (project not embedded yet)
      if (errText.includes('Not found') || errText.includes('doesn\'t exist')) {
        return c.json({
          success: true,
          data: {
            query,
            results: [],
            message: notIndexedYet(projectId, scope.orgId)
              ?? `No embedded code found for project ${projectId}. Run Mem9 embedding first via the dashboard.`,
          },
        })
      }
      return c.json({ error: `Qdrant search failed: ${errText}` }, 500)
    }

    let points = await pointsOf(res)
    // A branch the indexer never saw — any feature branch an agent works on before it is
    // pushed — holds nothing; its default branch is the closest code there is, then every branch.
    const fallbacks = branch ? [defaultBranchOf(project?.id ?? projectId), undefined] : defaultBranch ? [undefined] : []
    for (const onBranch of fallbacks.filter((b, i) => b !== asked && fallbacks.indexOf(b) === i)) {
      if (points.length > 0) break
      const wider = await ask(onBranch)
      if (wider.ok) points = await pointsOf(wider)
    }

    // Copies of one chunk still come back when no branch filter applied. Keep the best ranked
    // copy of each place in the code.
    const seen = new Set<string>()
    const hits = points.map((hit) => ({
      score: hit.score,
      filePath: hit.payload?.file_path as string | undefined,
      chunkIndex: hit.payload?.chunk_index as number | undefined,
      content: hit.payload?.content as string | undefined,
      branch: hit.payload?.branch as string | undefined,
    })).filter((hit) => {
      const place = `${hit.filePath}#${hit.chunkIndex}`
      if (seen.has(place)) return false
      seen.add(place)
      return true
    })

    let results = hits
    let reranked = false

    if (reranker && hits.length > 1) {
      try {
        const ranked = await reranker.rerank(
          query,
          hits.map((h) => ({
            item: h,
            // The chunk already starts with a "// File: <path>" line, but the
            // path is worth repeating: half of what identifies a chunk is where
            // it lives, and the payload copy is truncated at 2000 chars.
            text: `${h.filePath ?? ''}\n${h.content ?? ''}`,
            score: h.score,
          })),
        )
        results = ranked.map((r) => ({ ...r.item, score: r.score, vectorScore: r.retrievalScore, relevance: r.relevance }))
        reranked = true
      } catch (err) {
        // Reranking is an improvement, not a dependency: fall back to vector order.
        logger.warn(`[code-search] rerank failed, using vector order: ${String(err).slice(0, 200)}`)
      }
    }

    results = results.slice(0, searchLimit).map((hit) => ({ ...hit, ...chunkLines(project?.id ?? projectId, hit) }))

    return c.json({
      success: true,
      // `retrieval` says what `score` means: a cosine similarity from the vector
      // arm alone, or a reciprocal-rank-fusion score once both arms have voted.
      data: { query, projectId, retrieval: sparse ? 'hybrid' : 'vector', reranked, results },
    })
  } catch (error) {
    logger.error(`Code search (Qdrant) failed: ${String(error)}`)
    return c.json({ success: false, error: String(error) }, 500)
  }
})

/**
 * The code that best matches a query across every indexed repo of one organization: one
 * embedding, each project's collection asked in parallel, and the hits merged by score. The
 * organization is the unit that shares code — a product's client, server and tools — so this
 * is what answers "where else is this". Each collection is asked by the dense vector alone:
 * a fused hybrid score is a rank within one collection and does not compare across them.
 */
async function searchOrganization(
  query: string,
  orgId: string,
  opts: { branch?: string; limit: number; exclude?: string; perRepo?: number },
) {
  type Repo = { id: string; slug: string | null; name: string; default_branch: string | null }
  const repos = db.prepare(
    'SELECT id, slug, name, default_branch FROM projects WHERE org_id = ? AND indexed_symbols > 0 ORDER BY name'
  ).all(orgId) as Repo[]
  const skip = opts.exclude ? findProject(opts.exclude, orgId)?.id : undefined
  const projects = repos.filter(p => p.id !== skip)
  if (projects.length === 0) return []

  const vector = await createEmbedder().embed(query)
  const perProject = Math.min(opts.limit, 5) * BRANCH_OVERFETCH
  const CONCURRENCY = 8

  // Each repo on the branch asked for, else on its default branch: see the single-repo search.
  const searchRepo = async (p: Repo, limit: number) => {
    const ask = async (branch: string | null | undefined) => {
      const res = await fetch(`${QDRANT_URL}/collections/cortex-project-${p.id}/points/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vector, limit, with_payload: true,
          filter: branch ? { must: [{ key: 'branch', match: { value: branch } }] } : undefined,
        }),
        signal: AbortSignal.timeout(10000),
      })
      // A project with no embeddings yet has no collection: it simply has nothing to add.
      if (!res.ok) return []
      return ((await res.json()) as { result?: Array<{ score: number; payload?: Record<string, unknown> }> }).result ?? []
    }
    const found = await ask(opts.branch ?? p.default_branch)
    if (found.length > 0) return found
    // A branch this repo was never indexed on: its default branch, then every branch.
    if (opts.branch && p.default_branch && p.default_branch !== opts.branch) {
      const onDefault = await ask(p.default_branch)
      if (onDefault.length > 0) return onDefault
    }
    return opts.branch || p.default_branch ? ask(undefined) : found
  }

  // Hits listed beside the caller's own repo have to come close to that repo's best. Without a
  // floor every search listed something: in an organization of related repos, the others' best
  // stayed under the caller's own on 18 of 18 sampled queries, mostly at a third of its score.
  const own = skip ? repos.find(p => p.id === skip) : undefined
  const floorFrom = own ? searchRepo(own, 1).catch(() => []) : Promise.resolve([])

  type OrgHit = { repo: string; projectId: string; score: number; filePath?: string; chunkIndex?: number; content?: string; branch?: string }
  const hits: OrgHit[] = []
  for (let i = 0; i < projects.length; i += CONCURRENCY) {
    const settled = await Promise.allSettled(projects.slice(i, i + CONCURRENCY).map(async (p) =>
      (await searchRepo(p, perProject)).map((hit): OrgHit => ({
        repo: p.slug || p.name,
        projectId: p.id,
        score: hit.score,
        filePath: hit.payload?.file_path as string | undefined,
        chunkIndex: hit.payload?.chunk_index as number | undefined,
        content: hit.payload?.content as string | undefined,
        branch: hit.payload?.branch as string | undefined,
      }))))
    for (const r of settled) if (r.status === 'fulfilled') hits.push(...r.value)
  }
  const floor = ((await floorFrom)[0]?.score ?? 0) * BESIDE_FLOOR

  // A chunk indexed on several branches comes back once per branch. With perRepo a file is
  // listed once, by its best chunk, and a large repo cannot fill every place.
  const seen = new Set<string>()
  const files = new Map<string, number>()
  return hits
    .filter((hit) => hit.score >= floor)
    .sort((a, b) => b.score - a.score)
    .filter((hit) => {
      const place = opts.perRepo ? `${hit.projectId}:${hit.filePath}` : `${hit.projectId}:${hit.filePath}#${hit.chunkIndex}`
      if (seen.has(place)) return false
      seen.add(place)
      if (!opts.perRepo) return true
      const n = files.get(hit.projectId) ?? 0
      files.set(hit.projectId, n + 1)
      return n < opts.perRepo
    })
    .slice(0, opts.limit)
    .map((hit) => ({ ...hit, ...chunkLines(hit.projectId, hit) }))
}

/**
 * Where a chunk sits in the project's checkout, so an agent can read those lines and not the
 * whole file. Chunks are stored without line numbers; without them every hit was followed by a
 * read of the entire file, 9–25k characters for a 1.5k chunk. The checkout may be on another
 * branch than the chunk, so a chunk whose text is not in the file gets no lines.
 */
export function locateChunk(fileText: string, chunk: string): { startLine: number; endLine: number } | undefined {
  const body = chunk.replace(/^\/\/ File: [^\n]*\n/, '').replace(/\s+$/, '')
  if (!body) return undefined
  const at = fileText.indexOf(body)
  if (at < 0) return undefined
  const startLine = fileText.slice(0, at).split('\n').length
  return { startLine, endLine: startLine + body.split('\n').length - 1 }
}

function chunkLines(projectDir: string, hit: { filePath?: string; content?: string }) {
  if (!hit.filePath || !hit.content) return {}
  const fileText = readCheckoutFile(join(REPOS_DIR, projectDir), hit.filePath)
  return (fileText && locateChunk(fileText, hit.content)) || {}
}

// ── File Content: read raw source file from cloned repo ──
intelRouter.post('/file-content', async (c) => {
  try {
    const body = await c.req.json()
    const { projectId, file, startLine, endLine, orgId } = body as {
      projectId: string
      file: string
      startLine?: number
      endLine?: number
      orgId?: string
    }

    if (!projectId) return c.json({ error: 'projectId is required' }, 400)
    if (!file) return c.json({ error: 'file path is required' }, 400)

    // Raw file contents are the most direct read there is — same org boundary as search.
    const scope = resolveOrgScope({ orgId, projectId, apiKeyOwner: c.req.header('X-API-Key-Owner') })
    if (projectOutsideScope(projectId, scope)) {
      return c.json(outsideScopeResponse(projectId), 403)
    }

    // Resolve any identifier (project ID, name, slug, URL) → actual directory
    // Uses the same resolveRepoNames logic as code_search/code_context
    let resolvedId = projectId
    if (!existsSync(join(REPOS_DIR, projectId))) {
      const candidates = resolveRepoNames(projectId, scope.orgId)
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
    // A line range of a large file is still a small answer: the file the benchmark needed was 21k lines.
    if (stat.size > MAX_READ_SIZE && !startLine && !endLine) {
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

// ── Grep: an exact string across the organization's checkouts ──
//
// The checkouts under REPOS_DIR are the default branch of each project, kept current by the
// indexer. Each repo is searched on its own with a time and output budget, so one huge repo or a
// pattern that matches every line cannot hold the others up.
const GREP_MAX_PATTERN = 300
const GREP_DEFAULT_LIMIT = 60
const GREP_MAX_LIMIT = 200
// A file list is what a broad sweep (encrypt|decrypt|cipher) is for: a name costs a few dozen
// bytes, so many more fit than lines do.
const GREP_FILES_DEFAULT_LIMIT = 150
const GREP_FILES_MAX_LIMIT = 400
const GREP_CONCURRENCY = 4

intelRouter.post('/grep', async (c) => {
  try {
    const body = await c.req.json()
    const { pattern, projectId, orgId, scopeRepo, path, ignoreCase, fixed, files, limit } = body as {
      pattern?: string
      /** One repo; without it every repo of the organization. */
      projectId?: string
      orgId?: string
      /** The repo the caller is working in: anchors the organization when none is named. */
      scopeRepo?: string
      /** Git pathspecs, e.g. "*.cs" or "src/net/". */
      path?: string | string[]
      ignoreCase?: boolean
      fixed?: boolean
      /** Name the matching files with a count each, instead of listing lines. */
      files?: boolean
      limit?: number
    }

    if (!pattern) return c.json({ error: 'pattern is required' }, 400)
    if (pattern.length > GREP_MAX_PATTERN) return c.json({ error: `pattern is longer than ${GREP_MAX_PATTERN} characters` }, 400)
    const paths = (Array.isArray(path) ? path : path ? [path] : []).filter((p) => typeof p === 'string' && p.trim())
    if (paths.length > 10 || paths.some((p) => p.length > 200)) return c.json({ error: 'path takes at most 10 pathspecs of 200 characters' }, 400)

    const scope = resolveOrgScope({ orgId, projectId, scopeRepo, apiKeyOwner: c.req.header('X-API-Key-Owner') })
    if (!scope.orgId) {
      return c.json({ success: false, error: 'Several organizations hold indexed code: name the repo, or pass org.' }, 400)
    }

    type Repo = { id: string; name: string }
    let repos: Repo[]
    if (projectId) {
      if (projectOutsideScope(projectId, scope)) return c.json(outsideScopeResponse(projectId), 403)
      const project = findProject(projectId, scope.orgId)
      if (!project) {
        return c.json({ error: `No repo "${projectId}" in this organization.`, hint: 'cortex_list_repos lists the names to pass as repo.' }, 404)
      }
      repos = [project]
    } else {
      repos = db.prepare('SELECT id, name FROM projects WHERE org_id = ? ORDER BY name').all(scope.orgId) as Repo[]
    }
    const searchable = repos.filter((r) => existsSync(join(REPOS_DIR, r.id, '.git')))

    const filesOnly = files === true
    const max = filesOnly
      ? Math.min(Math.max(1, limit ?? GREP_FILES_DEFAULT_LIMIT), GREP_FILES_MAX_LIMIT)
      : Math.min(Math.max(1, limit ?? GREP_DEFAULT_LIMIT), GREP_MAX_LIMIT)
    type Found = { repo: string; projectId: string; hits: GrepHit[]; files: GrepFile[]; truncated: boolean; error?: string }
    const results: Found[] = []
    const items = (r: Found) => (filesOnly ? r.files : r.hits)
    const queue = [...searchable]
    const worker = async () => {
      for (let repo = queue.shift(); repo; repo = queue.shift()) {
        try {
          // Each repo may fill the whole limit: which repos matter is decided after, not by speed.
          const found = await grepCheckout(join(REPOS_DIR, repo.id), pattern, { ignoreCase, fixed, paths, filesOnly })
          results.push({ repo: repo.name, projectId: repo.id, ...found })
        } catch (error) {
          results.push({ repo: repo.name, projectId: repo.id, hits: [], files: [], truncated: false, error: error instanceof Error ? error.message : String(error) })
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(GREP_CONCURRENCY, searchable.length) }, worker))

    // A bad pattern fails the same way in every repo: say it once, as the caller's error.
    const failed = results.filter((r) => r.error)
    if (failed.length > 0 && failed.length === results.length) {
      return c.json({ success: false, error: `git grep refused the pattern: ${failed[0]!.error}` }, 400)
    }

    // Fewer hits first: a repo where the string is rare is where it means something, and a repo
    // that matches everywhere would otherwise spend the whole limit.
    results.sort((a, b) => (items(a).length === 0 ? 1 : 0) - (items(b).length === 0 ? 1 : 0) || items(a).length - items(b).length || a.repo.localeCompare(b.repo))
    let left = max
    const shown = results.map((r) => {
      const all = items(r)
      const kept = all.slice(0, Math.max(0, left))
      left -= kept.length
      const listed = filesOnly ? { hits: [], files: kept as GrepFile[] } : { hits: kept as GrepHit[], files: [] }
      return { ...r, ...listed, total: all.length, truncated: r.truncated || kept.length < all.length }
    })

    return c.json({
      success: true,
      data: {
        pattern,
        filesOnly,
        orgId: scope.orgId,
        searched: searchable.map((r) => r.name),
        notCloned: repos.filter((r) => !searchable.includes(r)).map((r) => r.name),
        results: shown,
      },
    })
  } catch (error) {
    logger.error(`Grep failed: ${String(error)}`)
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
      headers: gitnexusHeaders(),
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
