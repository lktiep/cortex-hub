// Which organizations an API key may use. A key is bound by rows in api_key_orgs; a key
// with none is unbound and reaches every organization, as every key did before binding
// existed. API_KEY_BINDING decides what an unbound key may still do:
//   off       works as before, nothing said
//   warn      works as before, and the hub says once per key how to bind it (the default)
//   required  refused
// The grant is read from SQLite on every request, so binding or revoking a key takes effect
// on the next call, whatever hub-mcp has cached. lib/key-scope.ts holds each request to it,
// and code that widens a query to "every project" asks currentGrant() how far it may go.
import { AsyncLocalStorage } from 'node:async_hooks'
import { createLogger } from '@cortex/shared-utils'
import { db } from '../db/client.js'
import { findProjectByRepo, normalizeRepo } from './project-match.js'

const logger = createLogger('key-grant')

export type KeyBindingMode = 'off' | 'warn' | 'required'

export function keyBindingMode(env: NodeJS.ProcessEnv = process.env): KeyBindingMode {
  const mode = env['API_KEY_BINDING']?.trim().toLowerCase()
  return mode === 'off' || mode === 'required' ? mode : 'warn'
}

/** What the mode lets an unbound key do, for the startup log. */
export function describeKeyBinding(mode: KeyBindingMode): string {
  if (mode === 'off') return 'unbound API keys reach every organization'
  if (mode === 'warn') return 'unbound API keys reach every organization, and each is logged once'
  return 'unbound API keys are refused'
}

export interface KeyGrant {
  keyId: string
  keyName: string
  /** The organizations the key may use; null when the key is unbound. */
  orgs: ReadonlySet<string> | null
}

/** What the checks below read of a grant. */
export type GrantOrgs = Pick<KeyGrant, 'orgs'>

/** The organizations a key is bound to, in name order. Rows of deleted organizations are left out. */
export function keyOrgIds(keyId: string): string[] {
  const rows = db.prepare(
    `SELECT k.org_id AS id FROM api_key_orgs k
       JOIN organizations o ON o.id = k.org_id
      WHERE k.key_id = ?
      ORDER BY o.name`,
  ).all(keyId) as Array<{ id: string }>
  return rows.map((r) => r.id)
}

/** The grant of a key id, or undefined when no such key exists. */
export function grantOfKey(keyId: string): KeyGrant | undefined {
  const key = db.prepare('SELECT id, name FROM api_keys WHERE id = ?').get(keyId) as { id: string; name: string } | undefined
  if (!key) return undefined
  const bound = (db.prepare('SELECT COUNT(*) AS n FROM api_key_orgs WHERE key_id = ?').get(keyId) as { n: number }).n > 0
  // A key bound only to organizations that were deleted since is bound to nothing, not unbound.
  return { keyId: key.id, keyName: key.name, orgs: bound ? new Set(keyOrgIds(keyId)) : null }
}

/** Replaces the organizations a key is bound to. An empty list unbinds it. */
export function setKeyOrgs(keyId: string, orgIds: readonly string[]): void {
  const replace = db.transaction((ids: readonly string[]) => {
    db.prepare('DELETE FROM api_key_orgs WHERE key_id = ?').run(keyId)
    const insert = db.prepare('INSERT OR IGNORE INTO api_key_orgs (key_id, org_id) VALUES (?, ?)')
    for (const id of ids) insert.run(keyId, id)
  })
  replace(orgIds)
}

/** The ids in the list that are not organizations. */
export function unknownOrgIds(orgIds: readonly string[]): string[] {
  const known = new Set((db.prepare('SELECT id FROM organizations').all() as Array<{ id: string }>).map((r) => r.id))
  return orgIds.filter((id) => !known.has(id))
}

/** True when the grant may use the organization. No grant, or an unbound key, may use any. */
export function orgAllowed(grant: GrantOrgs | undefined, orgId: string | null | undefined): boolean {
  if (!grant?.orgs) return true
  return !!orgId && grant.orgs.has(orgId)
}

/** The organizations the grant limits a request to, or undefined when it is not limited. */
export function allowedOrgs(grant: GrantOrgs | undefined): ReadonlySet<string> | undefined {
  return grant?.orgs ?? undefined
}

/**
 * What a project reference means to a key:
 *   'allowed'  it names a project in one of the key's organizations
 *   'hidden'   it names projects only in other organizations, which the key must not learn of
 *   'unknown'  it names no registered project
 * A reference is an id, slug or name (a name matches partly, as the intel routes match it).
 */
export function projectRefAccess(grant: GrantOrgs | undefined, ref: string): 'allowed' | 'hidden' | 'unknown' {
  const orgs = (db.prepare(
    `SELECT DISTINCT org_id FROM projects
      WHERE id = ? OR slug = ? COLLATE NOCASE OR name = ? COLLATE NOCASE OR name LIKE ? COLLATE NOCASE`,
  ).all(ref, ref, ref, `%${ref}%`) as Array<{ org_id: string }>).map((r) => r.org_id)
  if (orgs.length === 0) return 'unknown'
  return orgs.some((org) => orgAllowed(grant, org)) ? 'allowed' : 'hidden'
}

/** What a repo URL or name means to a key, judged as session start resolves it. */
export function repoAccess(grant: GrantOrgs | undefined, repo: string): 'allowed' | 'hidden' | 'unknown' {
  const match = findProjectByRepo(repo, allowedOrgs(grant))
  if (match) return 'allowed'
  if (!grant?.orgs) return 'unknown'
  return findProjectByRepo(normalizeRepo(repo)) ? 'hidden' : 'unknown'
}

const requestGrant = new AsyncLocalStorage<KeyGrant | undefined>()

/** Runs fn as a request made with the grant: currentGrant() answers it in everything fn awaits. */
export function runWithGrant<T>(grant: KeyGrant | undefined, fn: () => T): T {
  return requestGrant.run(grant, fn)
}

/** The grant of the request being served, or undefined when no API key is behind it (the dashboard, the hub itself). */
export function currentGrant(): KeyGrant | undefined {
  return requestGrant.getStore()
}

/**
 * A condition that keeps the rows of the organizations the grant may use, to append to a WHERE:
 * ` AND <column> IN (?, …)`, or nothing when the grant does not limit the request.
 */
export function grantOrgFilter(column: string, grant: GrantOrgs | undefined = currentGrant()): { sql: string; params: string[] } {
  const orgs = allowedOrgs(grant)
  if (!orgs) return { sql: '', params: [] }
  if (orgs.size === 0) return { sql: ' AND 0', params: [] }
  return { sql: ` AND ${column} IN (${[...orgs].map(() => '?').join(', ')})`, params: [...orgs] }
}

/** The ids of the projects the grant may use, or undefined when it does not limit the request. */
export function grantProjectIds(grant: GrantOrgs | undefined = currentGrant()): string[] | undefined {
  if (!allowedOrgs(grant)) return undefined
  const filter = grantOrgFilter('org_id', grant)
  return (db.prepare(`SELECT id FROM projects WHERE 1${filter.sql}`).all(...filter.params) as Array<{ id: string }>).map((r) => r.id)
}

/** True when the grant may use the project. A project id the DB does not know is not one of its organizations'. */
export function projectAllowed(grant: GrantOrgs | undefined, projectId: string | null | undefined): boolean {
  if (!allowedOrgs(grant)) return true
  if (!projectId) return false
  const row = db.prepare('SELECT org_id FROM projects WHERE id = ?').get(projectId) as { org_id: string } | undefined
  return !!row && orgAllowed(grant, row.org_id)
}

const warned = new Set<string>()

/** Says once per key and process that an unbound key should be bound. */
export function warnUnbound(keyId: string, keyName: string): void {
  if (warned.has(keyId)) return
  warned.add(keyId)
  logger.warn(
    `API key "${keyName}" (${keyId}) is not bound to an organization and can use all of them. ` +
    'Bind it in Dashboard → API Keys; with API_KEY_BINDING=required an unbound key is refused.',
  )
}

/** The message an unbound key gets when API_KEY_BINDING=required. */
export const UNBOUND_KEY_ERROR =
  'API key is not bound to an organization. An admin binds it in Dashboard → API Keys (API_KEY_BINDING=required).'

/** The message a key bound to no existing organization gets. */
export const NO_ORG_KEY_ERROR =
  'API key is bound only to organizations that no longer exist. An admin rebinds it in Dashboard → API Keys.'
