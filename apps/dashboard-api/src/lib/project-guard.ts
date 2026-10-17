import type { MiddlewareHandler } from 'hono'
import { db } from '../db/client.js'
import { findProjectByRepo } from './project-match.js'

/** Routes that manage keys, settings and the like, not a project's data. */
const BYPASS_PREFIXES = ['/api/setup', '/api/keys', '/api/settings', '/api/system', '/api/accounts', '/api/webhooks']

type GuardedProject = { id: string; enabled: number }

/**
 * Refuse a write for a project that is disabled or not registered. The project
 * is named by `projectId` (query or JSON body) or by a JSON `repo`. A repo
 * resolves exactly as session start resolves it, so the guard and the handler
 * judge the same project: a repo registered under another name passes.
 *
 * Session start is the one route an unregistered repo gets through: its handler
 * registers a repo of a saved git account, or tells the agent how to add it.
 */
export const projectGuard: MiddlewareHandler = async (c, next) => {
  // GET reads, and PUT is how a disabled project is enabled again.
  if (c.req.method === 'GET' || c.req.method === 'PUT') return next()
  if (BYPASS_PREFIXES.some((prefix) => c.req.path.startsWith(prefix))) return next()

  let projectId: string | null = c.req.query('projectId') || c.req.query('project_id') || null
  let repo: string | null = null
  if (!projectId && c.req.header('Content-Type')?.includes('application/json')) {
    try {
      const body = (await c.req.raw.clone().json()) as Record<string, unknown> | null
      const bodyProject = body?.['projectId'] || body?.['project_id']
      projectId = typeof bodyProject === 'string' ? bodyProject : null
      const bodyRepo = body?.['repo']
      if (!projectId && typeof bodyRepo === 'string' && bodyRepo) repo = bodyRepo
    } catch {
      // ignore JSON parse/read errors
    }
  }

  let project: GuardedProject | undefined
  if (projectId) {
    project = db.prepare(
      `SELECT id, enabled FROM projects
       WHERE id = ? OR slug = ? COLLATE NOCASE OR name = ? COLLATE NOCASE`,
    ).get(projectId, projectId, projectId) as GuardedProject | undefined
  } else if (repo) {
    const match = findProjectByRepo(repo)
    project = match
      ? db.prepare('SELECT id, enabled FROM projects WHERE id = ?').get(match.id) as GuardedProject | undefined
      : undefined
    if (!project && c.req.path === '/api/sessions/start') return next()
  } else {
    return next()
  }

  if (!project) {
    return c.json({ success: false, error: 'Project not registered in Cortex Hub. Please register it in the dashboard first.' }, 403)
  }
  if (project.enabled === 0) {
    return c.json({ success: false, error: 'Cortex Hub is disabled for this project.' }, 403)
  }
  await next()
}
