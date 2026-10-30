// Holds a request made with an API key to the organizations the key is bound to (lib/key-grant.ts).
//
// The key comes from the Bearer token, or, for a call hub-mcp makes on a key's behalf, from
// X-Cortex-Key-Id, which apiAuth believes from trusted callers only. A request without a key
// (the dashboard, the hub itself) and a request with an unbound key go on as before.
//
// A bound key reaches the routes its tools, the editor extension and the worker use, and no
// others: everything else manages the hub (keys, settings, accounts, organizations) or lists
// across it, and is refused rather than taught to filter. On the routes it reaches, a project,
// repo or organization the request names must be one of the key's: another organization's
// project answers 404, as a project that does not exist would, and another organization 403.
// What a route widens to when nothing is named (a session's project, a fan-out, a listing) is
// limited inside the route, through currentGrant().
import type { Context, MiddlewareHandler } from 'hono'
import { taskInGrant } from '../conductor/grant.js'
import { db } from '../db/client.js'
import { authenticatedKeyId, lookupApiKey } from './api-auth.js'
import {
  grantOfKey,
  keyBindingMode,
  orgAllowed,
  projectAllowed,
  projectRefAccess,
  repoAccess,
  runWithGrant,
  NO_ORG_KEY_ERROR,
  UNBOUND_KEY_ERROR,
  warnUnbound,
  type KeyGrant,
} from './key-grant.js'

/** The routes a bound key may call, by method. */
const BOUND_KEY_ROUTES: Array<[method: string, path: RegExp]> = [
  ['GET', /^\/api\/intel\/(repos|health)$/],
  ['POST', /^\/api\/intel\/(search|code-search|context|impact|cypher|grep|detect-changes|file-content)$/],
  ['POST', /^\/api\/knowledge(\/search|\/file-notes|\/track-feedback)?$/],
  ['GET', /^\/api\/knowledge\/[^/]+$/],
  ['POST', /^\/api\/mem9\/(store|search|embed)$/],
  ['DELETE', /^\/api\/mem9\/[^/]+$/],
  ['GET', /^\/api\/mem9\/health$/],
  ['POST', /^\/api\/sessions\/(start|[^/]+\/end)$/],
  ['GET', /^\/api\/sessions\/all$/],
  ['POST', /^\/api\/quality\/(report|plan-quality)$/],
  ['GET', /^\/api\/conductor(\/agents|\/[^/]+)?$/],
  ['POST', /^\/api\/conductor(\/pickup|\/tree|\/[^/]+\/(review|route|cancel))?$/],
  ['PUT', /^\/api\/conductor\/[^/]+(\/strategy)?$/],
  ['GET', /^\/api\/projects(\/lookup)?$/],
  ['POST', /^\/api\/projects\/[^/]+\/index$/],
  ['GET', /^\/api\/webhooks\/changes$/],
  ['POST', /^\/api\/webhooks\/(changes\/ack|push)$/],
  ['GET', /^\/api\/metrics\/(hints\/[^/]+|tool-analytics|overview-v2)$/],
  ['POST', /^\/api\/metrics\/query-log$/],
]

/** Path segments under these prefixes are ids, not sub-routes. */
const CONDUCTOR_ROUTES = new Set(['agents', 'pickup', 'tree'])
const PROJECT_ROUTES = new Set(['lookup'])

type Refusal = { status: 403 | 404; error: string }

const hiddenProject = (ref: string): Refusal => ({ status: 404, error: `Project "${ref}" not found.` })
const otherOrg = (org: string): Refusal => ({
  status: 403,
  error: `This API key is not bound to organization "${org}". An admin adds it in Dashboard → API Keys.`,
})

function strings(...values: unknown[]): string[] {
  return values.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
}

/** The projects, repos and organizations a request names in its query and JSON body. */
async function namedRefs(c: Context): Promise<{ projects: string[]; repos: string[]; orgs: string[] }> {
  const q = (name: string) => c.req.query(name)
  let body: Record<string, unknown> = {}
  if (c.req.header('Content-Type')?.includes('application/json')) {
    try {
      const parsed = (await c.req.raw.clone().json()) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
    } catch {
      // the route answers a body it cannot read
    }
  }
  const metadata = body['metadata'] && typeof body['metadata'] === 'object' ? body['metadata'] as Record<string, unknown> : {}
  // mem9 names a project's memories "project-<id>", optionally ":branch-<name>".
  const memoryProjects = strings(q('userId'), body['userId'])
    .filter((u) => u.startsWith('project-'))
    .map((u) => u.slice('project-'.length).split(':branch-')[0]!)
  return {
    projects: [
      ...strings(q('projectId'), q('project_id'), q('project'), q('exclude')),
      ...strings(body['projectId'], body['project_id'], body['project'], body['exclude'], metadata['project_id']),
      ...memoryProjects,
    ],
    repos: strings(q('repo'), q('scopeRepo'), body['repo'], body['scopeRepo']),
    orgs: strings(q('orgId'), q('org_id'), q('org'), body['orgId'], body['org_id'], body['org']),
  }
}

/** Whether the grant may act on a conductor task: one of its projects, or a task with no project that its key created. */
function taskRefusal(grant: KeyGrant, taskId: string): Refusal | undefined {
  const task = db.prepare('SELECT project_id, api_key_owner FROM conductor_tasks WHERE id = ?')
    .get(taskId) as { project_id: string | null; api_key_owner: string | null } | undefined
  if (!task) return undefined
  return taskInGrant(task, grant) ? undefined : { status: 404, error: `Task ${taskId} not found` }
}

/** Whether the grant may act on a session: one in its projects, or one of no project that its key opened. */
function sessionRefusal(grant: KeyGrant, sessionId: string): Refusal | undefined {
  const session = db.prepare('SELECT project_id, api_key_name FROM session_handoffs WHERE id = ?')
    .get(sessionId) as { project_id: string | null; api_key_name: string | null } | undefined
  if (!session) return undefined
  const allowed = session.project_id ? projectAllowed(grant, session.project_id) : session.api_key_name === grant.keyName
  return allowed ? undefined : { status: 404, error: 'Session not found' }
}

function knowledgeRefusal(grant: KeyGrant, docId: string): Refusal | undefined {
  const doc = db.prepare('SELECT project_id FROM knowledge_documents WHERE id = ?')
    .get(docId) as { project_id: string | null } | undefined
  if (!doc) return undefined
  // A document of no project is the hub's own, which every key reads.
  if (!doc.project_id) return undefined
  return projectAllowed(grant, doc.project_id) ? undefined : { status: 404, error: 'Document not found' }
}

/** What the path itself names: /projects/:id, /conductor/:taskId, /sessions/:id, /knowledge/:id. */
function pathRefusal(grant: KeyGrant, path: string): Refusal | undefined {
  const [, , area, id] = path.split('/').map((s) => decodeURIComponent(s))
  if (!id) return undefined
  if (area === 'projects' && !PROJECT_ROUTES.has(id)) {
    return projectRefAccess(grant, id) === 'hidden' ? hiddenProject(id) : undefined
  }
  if (area === 'conductor' && !CONDUCTOR_ROUTES.has(id)) return taskRefusal(grant, id)
  if (area === 'sessions' && id !== 'start' && id !== 'all') return sessionRefusal(grant, id)
  if (area === 'knowledge' && !['search', 'file-notes', 'track-feedback'].includes(id)) return knowledgeRefusal(grant, id)
  return undefined
}

/** Why a bound key may not make this request, or undefined when it may. */
export async function boundKeyRefusal(c: Context, grant: KeyGrant): Promise<Refusal | undefined> {
  const path = c.req.path
  if (!BOUND_KEY_ROUTES.some(([method, re]) => method === c.req.method && re.test(path))) {
    return { status: 403, error: 'This API is not available to an API key bound to organizations.' }
  }
  const refs = await namedRefs(c)
  for (const org of refs.orgs) if (!orgAllowed(grant, org)) return otherOrg(org)
  for (const ref of refs.projects) if (projectRefAccess(grant, ref) === 'hidden') return hiddenProject(ref)
  for (const repo of refs.repos) if (repoAccess(grant, repo) === 'hidden') return hiddenProject(repo)
  return pathRefusal(grant, path)
}

function requestKeyId(c: Context): string | undefined {
  const authenticated = authenticatedKeyId(c)
  if (authenticated) return authenticated
  const header = c.req.header('X-Cortex-Key-Id')?.trim()
  if (header) return header
  // With API_AUTH off nothing has looked at the token yet.
  const bearer = c.req.header('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  if (!bearer) return undefined
  const found = lookupApiKey(bearer)
  return 'key' in found ? found.key.id : undefined
}

export const keyScope: MiddlewareHandler = async (c, next) => {
  const keyId = requestKeyId(c)
  if (!keyId) return next()
  const grant = grantOfKey(keyId)
  if (!grant) return c.json({ error: 'Invalid API key' }, 401)

  if (!grant.orgs) {
    const mode = keyBindingMode()
    if (mode === 'required') return c.json({ error: UNBOUND_KEY_ERROR }, 401)
    if (mode === 'warn') warnUnbound(grant.keyId, grant.keyName)
    return next()
  }
  if (grant.orgs.size === 0) return c.json({ error: NO_ORG_KEY_ERROR }, 401)

  const refusal = await boundKeyRefusal(c, grant)
  if (refusal) return c.json({ success: false, error: refusal.error }, refusal.status)
  return runWithGrant(grant, () => next())
}
