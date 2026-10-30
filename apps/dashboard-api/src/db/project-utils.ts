import { db } from './client.js'
import { grantOrgFilter } from '../lib/key-grant.js'

export function normalizeProjectId(projectId: string | null | undefined): string | null {
  if (!projectId) return null
  try {
    // Resolve project ID, slug, name, or git URL to the canonical UUID, among the projects
    // the request's API key may use: two organizations may each have a "server".
    const granted = grantOrgFilter('org_id')
    const project = db.prepare(
      `SELECT id FROM projects
       WHERE (id = ?
          OR slug = ? COLLATE NOCASE
          OR name = ? COLLATE NOCASE)${granted.sql}`
    ).get(projectId, projectId, projectId, ...granted.params) as { id: string } | undefined

    if (project?.id) {
      return project.id
    }
  } catch (error) {
    console.warn(`normalizeProjectId failed: ${error}`)
  }
  return projectId
}

export function normalizeMemoryUserId(userId: string): string {
  if (!userId) return userId
  if (userId.startsWith('project-')) {
    const branchIndex = userId.indexOf(':branch-')
    if (branchIndex !== -1) {
      const projectIdRaw = userId.slice('project-'.length, branchIndex)
      const branchPart = userId.slice(branchIndex)
      const normalizedId = normalizeProjectId(projectIdRaw)
      return `project-${normalizedId}${branchPart}`
    } else {
      const projectIdRaw = userId.slice('project-'.length)
      const normalizedId = normalizeProjectId(projectIdRaw)
      return `project-${normalizedId}`
    }
  }
  return userId
}
