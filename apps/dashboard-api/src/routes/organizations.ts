import { Hono } from 'hono'
import { db } from '../db/client.js'
import { randomUUID } from 'crypto'
import { getMem9 } from './mem9-proxy.js'

export const orgsRouter = new Hono()

// ── List Organizations ──
orgsRouter.get('/', (c) => {
  try {
    const orgs = db
      .prepare(
        `SELECT o.*, 
          (SELECT COUNT(*) FROM projects WHERE org_id = o.id) as project_count
         FROM organizations o ORDER BY o.created_at DESC`
      )
      .all()
    return c.json({ organizations: orgs })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Get Organization ──
orgsRouter.get('/:id', (c) => {
  const { id } = c.req.param()
  try {
    const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(id)
    if (!org) return c.json({ error: 'Organization not found' }, 404)
    return c.json(org)
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Create Organization ──
orgsRouter.post('/', async (c) => {
  try {
    const body = await c.req.json()
    const { name, description } = body as { name: string; description?: string }

    if (!name || name.trim().length === 0) {
      return c.json({ error: 'Name is required' }, 400)
    }

    const id = `org-${randomUUID().slice(0, 8)}`
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

    db.prepare(
      'INSERT INTO organizations (id, name, slug, description) VALUES (?, ?, ?, ?)'
    ).run(id, name.trim(), slug, description ?? null)

    return c.json({ id, name: name.trim(), slug, description: description ?? null }, 201)
  } catch (error) {
    if (String(error).includes('UNIQUE constraint')) {
      return c.json({ error: 'Organization with this name already exists' }, 409)
    }
    return c.json({ error: String(error) }, 500)
  }
})

// ── Update Organization ──
orgsRouter.put('/:id', async (c) => {
  const { id } = c.req.param()
  try {
    const body = await c.req.json()
    const { name, description } = body as { name?: string; description?: string }

    const existing = db.prepare('SELECT * FROM organizations WHERE id = ?').get(id)
    if (!existing) return c.json({ error: 'Organization not found' }, 404)

    if (name) {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      db.prepare(
        'UPDATE organizations SET name = ?, slug = ?, description = ?, updated_at = strftime(\'%Y-%m-%dT%H:%M:%SZ\', \'now\') WHERE id = ?'
      ).run(name.trim(), slug, description ?? null, id)
    } else {
      db.prepare(
        'UPDATE organizations SET description = ?, updated_at = strftime(\'%Y-%m-%dT%H:%M:%SZ\', \'now\') WHERE id = ?'
      ).run(description ?? null, id)
    }

    return c.json({ success: true })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Delete Organization (only if no projects) ──
orgsRouter.delete('/:id', (c) => {
  const { id } = c.req.param()
  try {
    if (id === 'org-default') {
      return c.json({ error: 'Cannot delete default organization' }, 403)
    }

    const projectCount = db
      .prepare('SELECT COUNT(*) as count FROM projects WHERE org_id = ?')
      .get(id) as { count: number } | undefined

    if (projectCount && projectCount.count > 0) {
      return c.json({ error: 'Organization has projects. Delete them first.' }, 409)
    }

    db.prepare('DELETE FROM organizations WHERE id = ?').run(id)
    return c.json({ success: true })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── List Projects in Org ──
orgsRouter.get('/:id/projects', (c) => {
  const { id } = c.req.param()
  try {
    const projects = db
      .prepare('SELECT * FROM projects WHERE org_id = ? ORDER BY created_at DESC')
      .all(id)
    return c.json({ projects })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Create Project ──
orgsRouter.post('/:id/projects', async (c) => {
  const { id: orgId } = c.req.param()
  try {
    const body = await c.req.json()
    const { name, description, gitRepoUrl, gitProvider, gitUsername, gitToken } = body as {
      name: string
      description?: string
      gitRepoUrl?: string
      gitProvider?: string
      gitUsername?: string
      gitToken?: string
    }

    if (!name || name.trim().length === 0) {
      return c.json({ error: 'Name is required' }, 400)
    }

    // Check org exists
    const org = db.prepare('SELECT id FROM organizations WHERE id = ?').get(orgId)
    if (!org) return c.json({ error: 'Organization not found' }, 404)

    const projectId = `proj-${randomUUID().slice(0, 8)}`
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

    db.prepare(
      `INSERT INTO projects (id, org_id, name, slug, description, git_repo_url, git_provider, git_username, git_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(projectId, orgId, name.trim(), slug, description ?? null, gitRepoUrl ?? null, gitProvider ?? null, gitUsername ?? null, gitToken ?? null)

    return c.json({
      id: projectId,
      orgId,
      name: name.trim(),
      slug,
      description: description ?? null,
      gitRepoUrl: gitRepoUrl ?? null,
      gitProvider: gitProvider ?? null,
      gitUsername: gitUsername ?? null,
    }, 201)
  } catch (error) {
    if (String(error).includes('UNIQUE constraint')) {
      return c.json({ error: 'Project with this name already exists in this organization' }, 409)
    }
    return c.json({ error: String(error) }, 500)
  }
})

// ── Projects Router (flat) ──
export const projectsRouter = new Hono()

// ── Lookup project by repo URL ──
projectsRouter.get('/lookup', (c) => {
  const repo = c.req.query('repo')
  if (!repo) return c.json({ error: 'repo query param required' }, 400)

  try {
    // Try exact match first, then without .git suffix
    const cleanRepo = repo.replace(/\.git$/, '')
    const project = db
      .prepare(
        `SELECT id, name, git_repo_url, indexed_at, indexed_symbols
         FROM projects
         WHERE git_repo_url = ? OR REPLACE(git_repo_url, '.git', '') = ?
         LIMIT 1`
      )
      .get(repo, cleanRepo) as Record<string, unknown> | undefined

    if (!project) return c.json({ error: 'Project not found' }, 404)
    return c.json(project)
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})


// ── Get Project ──
projectsRouter.get('/:id', (c) => {
  const { id } = c.req.param()
  try {
    const project = db
      .prepare(
        `SELECT p.*, o.name as org_name, o.slug as org_slug
         FROM projects p
         JOIN organizations o ON o.id = p.org_id
         WHERE p.id = ?`
      )
      .get(id) as Record<string, unknown> | undefined
    if (!project) return c.json({ error: 'Project not found' }, 404)

    // Build match patterns for project_id OR repo URL variants
    const repoUrl = (project.git_repo_url as string) ?? ''
    const cleanRepo = repoUrl.replace(/\.git$/, '').replace(/\/$/, '')

    // Stats: match by project_id OR project column containing repo URL
    const apiKeyCount = (db.prepare('SELECT COUNT(*) as c FROM api_keys WHERE project_id = ?').get(id) as { c: number })?.c ?? 0

    // query_logs and session_handoffs store repo URL in 'project' or 'project_id' column
    const queryCount = (db.prepare(
      `SELECT COUNT(*) as c FROM query_logs 
       WHERE project_id = ? OR project_id IN (?, ?, ?)`
    ).get(id, cleanRepo, `${cleanRepo}.git`, repoUrl) as { c: number })?.c ?? 0

    const sessionCount = (db.prepare(
      `SELECT COUNT(*) as c FROM session_handoffs 
       WHERE project_id = ? OR project IN (?, ?, ?)`
    ).get(id, cleanRepo, `${cleanRepo}.git`, repoUrl) as { c: number })?.c ?? 0

    const stats = { apiKeys: apiKeyCount, queryLogs: queryCount, sessions: sessionCount }

    // Recent activity: merge query_logs + session_handoffs
    const recentQueries = db.prepare(
      `SELECT 'query' as type, agent_id, tool as detail, status, latency_ms, created_at
       FROM query_logs 
       WHERE project_id = ? OR project_id IN (?, ?, ?)
       ORDER BY created_at DESC LIMIT 15`
    ).all(id, cleanRepo, `${cleanRepo}.git`, repoUrl) as Array<Record<string, unknown>>

    const recentSessions = db.prepare(
      `SELECT 'session' as type, from_agent as agent_id, task_summary as detail, status, 0 as latency_ms, created_at
       FROM session_handoffs 
       WHERE project_id = ? OR project IN (?, ?, ?)
       ORDER BY created_at DESC LIMIT 15`
    ).all(id, cleanRepo, `${cleanRepo}.git`, repoUrl) as Array<Record<string, unknown>>

    const activity = [...recentQueries, ...recentSessions]
      .sort((a, b) => ((b.created_at as string) || '').localeCompare((a.created_at as string) || ''))
      .slice(0, 15)

    return c.json({ ...(project as Record<string, unknown>), stats, activity })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})


// ── Update Project ──
projectsRouter.put('/:id', async (c) => {
  const { id } = c.req.param()
  try {
    const body = await c.req.json()
    const { name, description, gitRepoUrl, gitProvider, gitUsername, gitToken, enabled } = body as {
      name?: string
      description?: string
      gitRepoUrl?: string
      gitProvider?: string
      gitUsername?: string
      gitToken?: string
      enabled?: boolean | number
    }

    const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(id)
    if (!existing) return c.json({ error: 'Project not found' }, 404)

    const slug = name
      ? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      : (existing as Record<string, string>).slug

    db.prepare(
      `UPDATE projects SET 
        name = COALESCE(?, name),
        slug = ?,
        description = COALESCE(?, description),
        git_repo_url = COALESCE(?, git_repo_url),
        git_provider = COALESCE(?, git_provider),
        git_username = COALESCE(?, git_username),
        git_token = COALESCE(?, git_token),
        enabled = COALESCE(?, enabled),
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = ?`
    ).run(
      name ?? null,
      slug,
      description ?? null,
      gitRepoUrl ?? null,
      gitProvider ?? null,
      gitUsername ?? null,
      gitToken ?? null,
      enabled !== undefined ? (enabled ? 1 : 0) : null,
      id
    )

    return c.json({ success: true })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})


// ── Delete Project ──
projectsRouter.delete('/:id', (c) => {
  const { id } = c.req.param()
  try {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id)
    return c.json({ success: true })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── List all projects (flat) ──
projectsRouter.get('/', (c) => {
  try {
    const projects = db
      .prepare(
        `SELECT p.*, o.name as org_name, o.slug as org_slug
         FROM projects p
         JOIN organizations o ON o.id = p.org_id
         ORDER BY p.created_at DESC`
      )
      .all()
    return c.json({ projects })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Get Project State from Memory ──
projectsRouter.get('/:id/state', async (c) => {
  const { id } = c.req.param()
  try {
    const mem9 = getMem9()
    const result = await mem9.search({
      query: `project ${id} recent session context progress task tracking`,
      userId: `project-${id}`,
      limit: 10,
    })

    const memories = result.memories ?? []
    return c.json({
      memories: memories.map((m: { memory?: string; score?: number }) => ({
        content: m.memory ?? '',
        score: m.score ?? 0,
      })),
      tokensUsed: result.tokensUsed || 0,
    })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

