import { randomUUID } from 'crypto'
import { db } from '../db/client.js'
import { createLogger } from '@cortex/shared-utils'
import { parseRepoUrl, gitProviderForHost, httpsRepoUrl, savedTokenFor, type RepoRef } from '../lib/git-credentials.js'
import { checkRemoteAccess, requestIndexing } from './indexer.js'

const logger = createLogger('auto-register')

export interface AutoRegistration {
  projectId: string
  orgId: string
  orgName: string
  name: string
  repoUrl: string
  /** The saved account whose token the project now uses. */
  username: string
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/**
 * The org that already holds most of this owner's repositories (ties go to the
 * one touched last), else the org of the project the token was saved on.
 */
function pickOrg(ref: RepoRef, tokenProjectId: string): string {
  const counts = new Map<string, { n: number; latest: string }>()
  const rows = db.prepare(
    'SELECT org_id, git_repo_url, updated_at FROM projects WHERE git_repo_url IS NOT NULL',
  ).all() as Array<{ org_id: string; git_repo_url: string; updated_at: string | null }>
  for (const row of rows) {
    const other = parseRepoUrl(row.git_repo_url)
    if (other?.host !== ref.host || other.owner.toLowerCase() !== ref.owner.toLowerCase()) continue
    const entry = counts.get(row.org_id) ?? { n: 0, latest: '' }
    entry.n++
    if ((row.updated_at ?? '') > entry.latest) entry.latest = row.updated_at ?? ''
    counts.set(row.org_id, entry)
  }
  const best = [...counts.entries()].sort(([, a], [, b]) => b.n - a.n || b.latest.localeCompare(a.latest))[0]
  if (best) return best[0]
  return (db.prepare('SELECT org_id FROM projects WHERE id = ?').get(tokenProjectId) as { org_id: string }).org_id
}

/**
 * Register a repository nobody added yet, when it belongs to an account whose
 * token the hub already holds: the owner in its URL is a saved git username on
 * the same host, or owns a repo whose token was saved without a username.
 * Repositories of any other owner are left alone. Synchronous,
 * so it never holds up the session start that calls it; indexing is
 * `indexRegisteredProject`'s job.
 *
 * The caller has already looked the repo up and found nothing.
 */
export function autoRegisterProject(repo: string): AutoRegistration | null {
  const ref = parseRepoUrl(repo)
  if (!ref) return null
  const saved = savedTokenFor(ref.host, ref.owner)
  if (!saved) return null

  const orgId = pickOrg(ref, saved.projectId)
  const orgName = (db.prepare('SELECT name FROM organizations WHERE id = ?').get(orgId) as { name: string }).name
  const repoUrl = httpsRepoUrl(ref)
  const insert = db.prepare(
    `INSERT INTO projects (id, org_id, name, slug, description, git_repo_url, git_provider, git_username, git_token)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  // The org may already use the bare name for something else; owner/name is the fallback.
  for (const name of [ref.name, `${ref.owner}/${ref.name}`]) {
    const projectId = `proj-${randomUUID().slice(0, 8)}`
    try {
      insert.run(
        projectId, orgId, name, slugify(name),
        'Registered automatically when an agent started a session in this repo.',
        // The username exactly as saved with the token: git authenticates the same way it did there.
        repoUrl, gitProviderForHost(ref.host), saved.username, saved.token,
      )
    } catch (err) {
      if (String(err).includes('UNIQUE constraint')) continue
      throw err
    }
    logger.info(`Auto-registered ${ref.host}/${ref.path} as ${projectId} in ${orgId} with the token saved for ${saved.account}`)
    return { projectId, orgId, orgName, name, repoUrl, username: saved.account }
  }
  return null
}

/**
 * Index a project `autoRegisterProject` just made. The token is checked first:
 * a fine-grained PAT only reads the repositories it lists, and a clone that
 * fails on that says so badly. When it cannot read the repo, a failed job
 * carries the reason, so the project page says why nothing was indexed.
 */
export async function indexRegisteredProject(projectId: string): Promise<void> {
  const access = await checkRemoteAccess(projectId)
  if (access.ok) {
    if (access.branch) db.prepare('UPDATE projects SET default_branch = ? WHERE id = ?').run(access.branch, projectId)
    requestIndexing(projectId, access.branch ?? 'main', { triggeredBy: 'auto-register' })
    return
  }

  const project = db.prepare('SELECT git_repo_url, git_username FROM projects WHERE id = ?').get(projectId) as
    { git_repo_url: string; git_username: string | null } | undefined
  if (!project) return
  const ref = parseRepoUrl(project.git_repo_url)
  const where = ref ? `${ref.host}/${ref.path}` : project.git_repo_url
  const host = ref?.host ?? 'the git host'
  const account = project.git_username || ref?.owner || 'this account'
  const error =
    `The token saved for ${account} cannot read ${where}. A fine-grained token only reads the ` +
    `repositories it lists: add this one to it on ${host}, or save a token that can read it in this project's ` +
    `Git settings, then index again. (git: ${access.error.slice(0, 200)})`
  db.prepare(
    `INSERT INTO index_jobs (id, project_id, branch, status, progress, error, triggered_by, created_at, completed_at)
     VALUES (?, ?, NULL, 'error', 0, ?, 'auto-register', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
  ).run(`idx-${randomUUID().slice(0, 12)}`, projectId, error)
  logger.warn(`Auto-registered ${projectId} is not readable with its token: ${access.error.slice(0, 200)}`)
}
