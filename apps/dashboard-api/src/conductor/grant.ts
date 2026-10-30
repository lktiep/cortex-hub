// The conductor tasks a request made with an org-bound API key may see (lib/key-grant.ts): the
// tasks of its organizations' projects, and the tasks of no project that its own key created.
// A request without a bound key (the dashboard, an unbound key, the hub itself) sees every task.
import { currentGrant, grantOrgFilter, projectAllowed, type KeyGrant } from '../lib/key-grant.js'

export function taskInGrant(
  task: { project_id: string | null; api_key_owner: string | null },
  grant: Pick<KeyGrant, 'keyName' | 'orgs'> | undefined = currentGrant(),
): boolean {
  if (!grant?.orgs) return true
  return task.project_id ? projectAllowed(grant, task.project_id) : task.api_key_owner === grant.keyName
}

/**
 * taskInGrant as a WHERE condition on conductor_tasks, columns prefixed with `prefix` (an alias
 * and a dot), or undefined when the request is not limited.
 */
export function grantTaskCondition(
  prefix = '',
  grant: Pick<KeyGrant, 'keyName' | 'orgs'> | undefined = currentGrant(),
): { sql: string; params: string[] } | undefined {
  if (!grant?.orgs) return undefined
  const orgs = grantOrgFilter('org_id', grant)
  return {
    sql: `(${prefix}project_id IN (SELECT id FROM projects WHERE 1${orgs.sql})` +
      ` OR (${prefix}project_id IS NULL AND ${prefix}api_key_owner = ?))`,
    params: [...orgs.params, grant.keyName],
  }
}

/** The grant of a worker's socket, or undefined when its key is unbound. */
export function connGrant(conn: { apiKeyOwner: string; apiKeyOrgs?: ReadonlySet<string> | null }): Pick<KeyGrant, 'keyName' | 'orgs'> | undefined {
  return conn.apiKeyOrgs ? { keyName: conn.apiKeyOwner, orgs: conn.apiKeyOrgs } : undefined
}
