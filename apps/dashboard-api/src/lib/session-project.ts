import { createLogger } from '@cortex/shared-utils'
import { db } from '../db/client.js'

const logger = createLogger('session-project')

/** Where every repo lands unasked: its projects are not related to each other. */
export const PERSONAL_ORG = 'org-default'

/**
 * The project of the caller's most recent session. The agent already declared its repo at
 * cortex_session_start, so nothing has to be passed on every later call. An active session
 * outranks a closed one, and session start bumps created_at when it reuses a row, so "most
 * recent" means the last repo the agent opened.
 */
export function projectOfActiveSession(
  apiKeyOwner: string | null | undefined,
): { id: string; org_id: string } | undefined {
  if (!apiKeyOwner) return undefined
  try {
    const row = db.prepare(
      `SELECT p.id AS id, p.org_id AS org_id
         FROM session_handoffs s
         JOIN projects p ON p.id = s.project_id
        WHERE (s.api_key_name = ? OR s.from_agent = ?)
        ORDER BY (s.status = 'active') DESC, s.created_at DESC
        LIMIT 1`
    ).get(apiKeyOwner, apiKeyOwner) as { id?: string; org_id?: string } | undefined
    return row?.id && row.org_id ? { id: row.id, org_id: row.org_id } : undefined
  } catch (error) {
    logger.warn(`projectOfActiveSession failed: ${String(error)}`)
    return undefined
  }
}

/**
 * The projects whose knowledge an unscoped search reads: the caller's session project, and the
 * other projects of its organization unless that is the personal one. undefined when the caller
 * has no session, which leaves the search as wide as it always was.
 */
export function recallProjects(apiKeyOwner: string | null | undefined): string[] | undefined {
  const project = projectOfActiveSession(apiKeyOwner)
  if (!project) return undefined
  if (project.org_id === PERSONAL_ORG) return [project.id]
  try {
    const rows = db.prepare('SELECT id FROM projects WHERE org_id = ?').all(project.org_id) as Array<{ id: string }>
    return rows.map((r) => r.id)
  } catch (error) {
    logger.warn(`recallProjects failed: ${String(error)}`)
    return [project.id]
  }
}
