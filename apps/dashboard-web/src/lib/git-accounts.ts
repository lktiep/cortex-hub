import type { GitAccount } from './api'

/**
 * Which saved git account a repository URL and username point at. The hub
 * copies that account's token server-side when asked to reuse it, so the
 * dashboard only has to know whether one exists — it never sees the token.
 */

/** The lowercased host of an https, `ssh://` or `git@host:owner/name` remote, or null. */
export function repoHost(url: string): string | null {
  const raw = url.trim()
  const scpHost = /^[\w.-]+@([^:/\s]+):(?!\/)/.exec(raw)?.[1]
  if (scpHost) return scpHost.toLowerCase()
  try {
    return new URL(raw).hostname.toLowerCase() || null
  } catch {
    return null
  }
}

/** The saved account for this username on the URL's host, matched case-insensitively. */
export function savedAccountFor(accounts: GitAccount[], repoUrl: string, username: string): GitAccount | null {
  const host = repoHost(repoUrl)
  const user = username.trim().toLowerCase()
  if (!host || !user) return null
  return accounts.find((a) => a.host === host && a.username.toLowerCase() === user) ?? null
}

/** Usernames to suggest, one per account name, newest first. */
export function savedUsernames(accounts: GitAccount[]): string[] {
  return [...new Set(accounts.map((a) => a.username))]
}
