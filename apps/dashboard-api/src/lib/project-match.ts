import { db } from '../db/client.js'

export interface ProjectMatch {
  id: string
  name: string
  orgId: string
  defaultBranch: string | null
}

/** The normalisation cortex_session_start applies: strip a trailing `.git`, then a trailing `/`. */
export function normalizeRepo(repo: string): string {
  return repo.replace(/\.git$/, '').replace(/\/$/, '')
}

/**
 * Resolve a repo URL or name to a project. Order: exact git_repo_url match
 * (with/without `.git` and trailing slash), then slug/name/LIKE on the repo name.
 * Shared by cortex_session_start and worker registration.
 */
export function findProjectByRepo(repo: string): ProjectMatch | null {
  if (!repo) return null
  const normalizedRepo = normalizeRepo(repo)
  // A Windows checkout path names the repo after its last backslash.
  const repoName = normalizedRepo.split(/[/\\]/).pop() ?? normalizedRepo

  let row = db.prepare(
    `SELECT * FROM projects
     WHERE git_repo_url IN (?, ?, ?, ?)`
  ).get(
    normalizedRepo,
    `${normalizedRepo}.git`,
    `${normalizedRepo}/`,
    repo,
  ) as Record<string, unknown> | undefined

  if (!row && repoName) {
    row = db.prepare(
      `SELECT * FROM projects
       WHERE slug = ? COLLATE NOCASE
          OR name = ? COLLATE NOCASE
          OR slug LIKE ? COLLATE NOCASE`
    ).get(repoName, repoName, `%${repoName}%`) as Record<string, unknown> | undefined
  }

  if (!row) return null
  return {
    id: row.id as string,
    name: row.name as string,
    orgId: row.org_id as string,
    defaultBranch: (row.default_branch as string | null) ?? null,
  }
}
