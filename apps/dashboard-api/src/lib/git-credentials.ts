import { db } from '../db/client.js'

/**
 * Git credentials are stored per project, so "the token I already gave the
 * hub" lives on whichever project it was typed into. These helpers find it
 * again by host and username, so a new project of the same account can reuse
 * it instead of asking for a PAT the user no longer has.
 *
 * Nothing here returns a token to a caller that sends it over HTTP: the
 * listing carries usernames and project names only, and `savedTokenFor` is
 * for server-side copies.
 */

export interface RepoRef {
  /** Lowercased hostname, no port. */
  host: string
  /** First path segment: the user or organization that owns the repository. */
  owner: string
  /** Last path segment without `.git`. */
  name: string
  /** Full path without `.git`, e.g. `group/sub/name` on GitLab. */
  path: string
}

export interface GitAccount {
  host: string
  /** As typed on the most recently updated project that uses it. */
  username: string
  projects: Array<{ id: string; name: string }>
  updatedAt: string
}

export interface SavedToken {
  username: string
  token: string
  /** The project the token was copied from. */
  projectId: string
}

/** Host, owner and name from an https, `ssh://` or `git@host:owner/name` remote. Null for anything else. */
export function parseRepoUrl(url: string): RepoRef | null {
  const raw = url.trim()
  let host: string
  let rawPath: string

  const scp = /^[\w.-]+@([^:/\s]+):(?!\/)(\S+)$/.exec(raw)
  if (scp) {
    host = scp[1]!
    rawPath = scp[2]!
  } else {
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      return null
    }
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol) || !parsed.hostname) return null
    host = parsed.hostname
    rawPath = parsed.pathname
  }

  const segments = rawPath.replace(/\.git\/?$/, '').split('/').filter(Boolean)
  if (segments.length < 2) return null
  return {
    host: host.toLowerCase(),
    owner: segments[0]!,
    name: segments[segments.length - 1]!,
    path: segments.join('/'),
  }
}

/** The `git_provider` value the dashboard uses for a hosted provider, or null for a self-hosted one. */
export function gitProviderForHost(host: string): string | null {
  const h = host.toLowerCase()
  if (h === 'github.com') return 'github'
  if (h === 'gitlab.com') return 'gitlab'
  if (h === 'bitbucket.org') return 'bitbucket'
  if (h === 'dev.azure.com' || h.endsWith('.visualstudio.com')) return 'azure'
  return null
}

/** The https clone URL for a repository: the only form a stored token can authenticate. */
export function httpsRepoUrl(ref: RepoRef): string {
  return `https://${ref.host}/${ref.path}.git`
}

interface CredentialRow {
  id: string
  name: string
  git_repo_url: string
  git_username: string
  git_token: string
  updated_at: string
}

/** Projects that hold a username and a token, newest first. */
function credentialRows(): CredentialRow[] {
  return db.prepare(
    `SELECT id, name, git_repo_url, git_username, git_token, updated_at FROM projects
     WHERE git_repo_url IS NOT NULL AND git_username IS NOT NULL AND git_username != ''
       AND git_token IS NOT NULL AND git_token != ''
     ORDER BY updated_at DESC, created_at DESC`,
  ).all() as CredentialRow[]
}

/** Saved git accounts, one per host and username (case-insensitive), newest first. Never includes a token. */
export function listGitAccounts(host?: string): GitAccount[] {
  const wanted = host?.trim().toLowerCase() || null
  const accounts = new Map<string, GitAccount>()
  for (const row of credentialRows()) {
    const ref = parseRepoUrl(row.git_repo_url)
    if (!ref || (wanted && ref.host !== wanted)) continue
    const key = `${ref.host}\n${row.git_username.toLowerCase()}`
    const account = accounts.get(key)
    if (account) {
      account.projects.push({ id: row.id, name: row.name })
    } else {
      accounts.set(key, {
        host: ref.host,
        username: row.git_username,
        projects: [{ id: row.id, name: row.name }],
        updatedAt: row.updated_at,
      })
    }
  }
  return [...accounts.values()]
}

/** The most recently saved token for `username` on `host`, matched case-insensitively. Server-side only. */
export function savedTokenFor(host: string, username: string): SavedToken | null {
  const h = host.trim().toLowerCase()
  const u = username.trim().toLowerCase()
  if (!h || !u) return null
  for (const row of credentialRows()) {
    if (row.git_username.toLowerCase() !== u) continue
    if (parseRepoUrl(row.git_repo_url)?.host !== h) continue
    return { username: row.git_username, token: row.git_token, projectId: row.id }
  }
  return null
}
