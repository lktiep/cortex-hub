import { createLogger } from '@cortex/shared-utils'
import { db } from '../db/client.js'

const logger = createLogger('session-project')

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
