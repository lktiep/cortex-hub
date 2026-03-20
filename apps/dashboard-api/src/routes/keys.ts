import { Hono } from 'hono'
import { db } from '../db/client.js'
import { randomBytes, createHash } from 'crypto'

export const keysRouter = new Hono()

function generateApiKey(): { key: string; hash: string } {
  const prefix = 'sk_ctx_'
  const buffer = randomBytes(32)
  const key = prefix + buffer.toString('hex')
  const hash = createHash('sha256').update(key).digest('hex')
  return { key, hash }
}

keysRouter.get('/', (c) => {
  const stmt = db.prepare('SELECT id, name, scope, permissions, created_at as createdAt, expires_at as expiresAt, last_used_at as lastUsed FROM api_keys ORDER BY created_at DESC')
  const keys = stmt.all().map((k: any) => ({
    ...k,
    prefix: 'sk_ctx_',
    permissions: k.permissions ? JSON.parse(k.permissions) : [],
  }))
  return c.json({ keys })
})

keysRouter.post('/', async (c) => {
  try {
    const body = await c.req.json()
    const { name, scope, permissions = [], expiresInDays } = body
    
    if (!name || !scope) {
      return c.json({ error: 'Name and scope are required' }, 400)
    }

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

    const stmt = db.prepare('INSERT INTO api_keys (id, name, key_hash, scope, permissions, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    stmt.run(id, name, hash, scope, JSON.stringify(permissions), expiresAt)

    return c.json({ 
      id,
      name,
      scope,
      prefix,
      key: key,
      permissions
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
    return c.json({ success: true })
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

    const hash = createHash('sha256').update(token).digest('hex')
    const stmt = db.prepare('SELECT id, name, scope, permissions, key_hash FROM api_keys WHERE key_hash = ?')
    const keyRecord = stmt.get(hash) as { id: string; name: string; scope: string; permissions: string; key_hash: string } | undefined

    if (!keyRecord) {
      return c.json({ valid: false, error: 'Invalid API key' }, 401)
    }

    // Update last_used_at
    const updateStmt = db.prepare('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?')
    updateStmt.run(keyRecord.id)

    return c.json({
      valid: true,
      agentId: keyRecord.name,
      scope: keyRecord.scope,
      permissions: keyRecord.permissions ? JSON.parse(keyRecord.permissions) : []
    }, 200)

  } catch (error) {
    return c.json({ valid: false, error: String(error) }, 500)
  }
})
