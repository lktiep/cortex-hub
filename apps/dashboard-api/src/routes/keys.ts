import { Hono } from 'hono'
import { db } from '../db/client.js'
import { randomBytes, createHash } from 'crypto'
import { recordMcpOrigin } from '../lib/mcp-origin.js'
import { lookupApiKey } from '../lib/api-auth.js'
import {
  grantOfKey, keyBindingMode, keyOrgIds, setKeyOrgs, unknownOrgIds, warnUnbound,
  NO_ORG_KEY_ERROR, UNBOUND_KEY_ERROR,
} from '../lib/key-grant.js'

export const keysRouter = new Hono()

async function invalidateMcpCache() {
  const secret = process.env.INTERNAL_API_SECRET
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (secret) {
    headers['X-Internal-Secret'] = secret
  }
  const urls = ['http://cortex-mcp:8317/auth/cache/invalidate', 'http://localhost:8318/auth/cache/invalidate']
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(1000)
      })
      if (res.ok) {
        break
      }
    } catch {
      // Ignore error and try fallback URL
    }
  }
}

/** `orgs` from a request body: undefined when absent, else a list of ids or an error. */
function orgsFromBody(raw: unknown): string[] | undefined | { error: string } {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string')) return { error: 'orgs must be a list of organization ids' }
  const ids = [...new Set(raw as string[])]
  const unknown = unknownOrgIds(ids)
  if (unknown.length > 0) return { error: `Unknown organization: ${unknown.join(', ')}` }
  return ids
}

function generateApiKey(): { key: string; hash: string } {
  const prefix = 'sk_ctx_'
  const buffer = randomBytes(32)
  const key = prefix + buffer.toString('hex')
  const hash = createHash('sha256').update(key).digest('hex')
  return { key, hash }
}

keysRouter.get('/', (c) => {
  const stmt = db.prepare('SELECT id, name, scope, permissions, created_at as createdAt, expires_at as expiresAt, last_used_at as lastUsed FROM api_keys ORDER BY created_at DESC')
  const keys = (stmt.all() as Array<Record<string, unknown> & { id: string; permissions: string | null }>).map((k) => ({
    ...k,
    prefix: 'sk_ctx_',
    permissions: k.permissions ? JSON.parse(k.permissions) : [],
    // Empty: the key is unbound and reaches every organization.
    orgs: keyOrgIds(k.id),
  }))
  return c.json({ keys, binding: keyBindingMode() })
})

keysRouter.post('/', async (c) => {
  try {
    const body = await c.req.json()
    const { name, scope, permissions = [], expiresInDays } = body
    
    if (!name || !scope) {
      return c.json({ error: 'Name and scope are required' }, 400)
    }
    const orgs = orgsFromBody(body.orgs)
    if (orgs && 'error' in orgs) return c.json({ error: orgs.error }, 400)

    const { key, hash } = generateApiKey()
    // ID for reference (not the actual secret key)
    const id = 'key_' + randomBytes(8).toString('hex')
    const prefix = 'sk_ctx_'

    let expiresAt = null
    if (expiresInDays) {
      const date = new Date()
      date.setDate(date.getDate() + expiresInDays)
      expiresAt = date.toISOString()
    }

    const stmt = db.prepare('INSERT INTO api_keys (id, name, key_hash, scope, permissions, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, strftime(\'%Y-%m-%dT%H:%M:%SZ\', \'now\'))')
    stmt.run(id, name, hash, scope, JSON.stringify(permissions), expiresAt)
    if (orgs) setKeyOrgs(id, orgs)

    // Update and delete already do this; without it here a brand new key is
    // rejected by hub-mcp until its cached key set happens to expire.
    invalidateMcpCache().catch(() => {})

    return c.json({ 
      id,
      name,
      scope,
      prefix,
      key: key,
      permissions,
      orgs: orgs ?? [],
    }, 201)
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

keysRouter.delete('/:id', (c) => {
  const id = c.req.param('id')
  try {
    const stmt = db.prepare('DELETE FROM api_keys WHERE id = ?')
    const result = stmt.run(id)
    if (result.changes === 0) {
      return c.json({ error: 'Key not found' }, 404)
    }
    setKeyOrgs(id, [])
    invalidateMcpCache().catch(() => {})
    return c.json({ success: true })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

keysRouter.put('/:id', async (c) => {
  const id = c.req.param('id')
  try {
    const body = await c.req.json()
    const { name, scope, permissions = [] } = body
    
    if (!name || !scope) {
      return c.json({ error: 'Name and scope are required' }, 400)
    }
    // Left out, the key keeps the organizations it has.
    const orgs = orgsFromBody(body.orgs)
    if (orgs && 'error' in orgs) return c.json({ error: orgs.error }, 400)

    const stmt = db.prepare('UPDATE api_keys SET name = ?, scope = ?, permissions = ? WHERE id = ?')
    const result = stmt.run(name, scope, JSON.stringify(permissions), id)

    if (result.changes === 0) {
      return c.json({ error: 'Key not found' }, 404)
    }
    if (orgs) setKeyOrgs(id, orgs)

    invalidateMcpCache().catch(() => {})
    return c.json({ success: true, id, name, scope, permissions, orgs: keyOrgIds(id) })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

keysRouter.post('/verify', async (c) => {
  try {
    const body = await c.req.json()
    const { token } = body
    
    if (!token) {
      return c.json({ valid: false, error: 'Token is required' }, 400)
    }
 
    const found = lookupApiKey(token)
    if ('error' in found) {
      return c.json({ valid: false, error: found.error }, 401)
    }
    const keyRecord = found.key

    const grant = grantOfKey(keyRecord.id)
    if (grant && !grant.orgs) {
      const mode = keyBindingMode()
      if (mode === 'required') return c.json({ valid: false, error: UNBOUND_KEY_ERROR }, 401)
      if (mode === 'warn') warnUnbound(keyRecord.id, keyRecord.name)
    }
    if (grant?.orgs && grant.orgs.size === 0) return c.json({ valid: false, error: NO_ORG_KEY_ERROR }, 401)

    // Update last_used_at
    const updateStmt = db.prepare('UPDATE api_keys SET last_used_at = strftime(\'%Y-%m-%dT%H:%M:%SZ\', \'now\') WHERE id = ?')
    updateStmt.run(keyRecord.id)

    // The gateway passes the https address the agent dialled; the dashboard shows it as the MCP
    // URL. Remembering it must never fail a valid key.
    try {
      recordMcpOrigin(c.req.header('x-cortex-public-origin'), keyRecord.name)
    } catch (err) {
      console.error('[keys] could not record the MCP origin:', err)
    }

    return c.json({
      valid: true,
      agentId: keyRecord.name,
      keyId: keyRecord.id,
      // Empty: unbound, every organization.
      orgs: grant?.orgs ? [...grant.orgs] : [],
      scope: keyRecord.scope,
      permissions: keyRecord.permissions ? JSON.parse(keyRecord.permissions) : []
    }, 200)

  } catch (error) {
    return c.json({ valid: false, error: String(error) }, 500)
  }
})
