import { Hono } from 'hono'
import { db } from '../db/client.js'
import { randomUUID } from 'crypto'

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
        'UPDATE organizations SET name = ?, slug = ?, description = ?, updated_at = datetime("now") WHERE id = ?'
      ).run(name.trim(), slug, description ?? null, id)
    } else {
      db.prepare(
        'UPDATE organizations SET description = ?, updated_at = datetime("now") WHERE id = ?'
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
    const { name, description, gitRepoUrl, gitProvider } = body as {
      name: string
      description?: string
      gitRepoUrl?: string
      gitProvider?: string
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
      `INSERT INTO projects (id, org_id, name, slug, description, git_repo_url, git_provider)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(projectId, orgId, name.trim(), slug, description ?? null, gitRepoUrl ?? null, gitProvider ?? null)

    return c.json({
      id: projectId,
      orgId,
      name: name.trim(),
      slug,
      description: description ?? null,
      gitRepoUrl: gitRepoUrl ?? null,
      gitProvider: gitProvider ?? null,
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
      .get(id)
    if (!project) return c.json({ error: 'Project not found' }, 404)

    // Get stats
    const stats = {
      apiKeys: (db.prepare('SELECT COUNT(*) as c FROM api_keys WHERE project_id = ?').get(id) as { c: number })?.c ?? 0,
      queryLogs: (db.prepare('SELECT COUNT(*) as c FROM query_logs WHERE project_id = ?').get(id) as { c: number })?.c ?? 0,
      sessions: (db.prepare('SELECT COUNT(*) as c FROM session_handoffs WHERE project_id = ?').get(id) as { c: number })?.c ?? 0,
    }

    return c.json({ ...project as Record<string, unknown>, stats })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Update Project ──
projectsRouter.put('/:id', async (c) => {
  const { id } = c.req.param()
  try {
    const body = await c.req.json()
    const { name, description, gitRepoUrl, gitProvider } = body as {
      name?: string
      description?: string
      gitRepoUrl?: string
      gitProvider?: string
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
        updated_at = datetime('now')
       WHERE id = ?`
    ).run(name ?? null, slug, description ?? null, gitRepoUrl ?? null, gitProvider ?? null, id)

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
