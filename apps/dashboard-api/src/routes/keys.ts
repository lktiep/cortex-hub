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
  const stmt = db.prepare('SELECT id, name, scope, created_at, expires_at, last_used_at FROM api_keys ORDER BY created_at DESC')
  const keys = stmt.all()
  return c.json({ data: keys })
})

keysRouter.post('/', async (c) => {
  try {
    const body = await c.req.json()
    const { name, scope } = body
    
    if (!name || !scope) {
      return c.json({ error: 'Name and scope are required' }, 400)
    }

    const { key, hash } = generateApiKey()
    const id = key.substring(0, 16) + '...'

    const stmt = db.prepare('INSERT INTO api_keys (id, name, key_hash, scope) VALUES (?, ?, ?, ?)')
    stmt.run(id, name, hash, scope)

    // Only returning the full key once
    return c.json({ 
      data: {
        id,
        name,
        scope,
        key: key 
      }
    }, 201)
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

keysRouter.delete('/:id', (c) => {
  const id = c.req.param('id')
  try {
    const stmt = db.prepare('DELETE FROM api_keys WHERE id = ?')
    stmt.run(id)
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
    const stmt = db.prepare('SELECT id, name, scope, key_hash FROM api_keys WHERE key_hash = ?')
    const keyRecord = stmt.get(hash) as { id: string; name: string; scope: string; key_hash: string } | undefined

    if (!keyRecord) {
      return c.json({ valid: false, error: 'Invalid API key' }, 401)
    }

    // Update last_used_at
    const updateStmt = db.prepare('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?')
    updateStmt.run(keyRecord.id)

    return c.json({
      valid: true,
      agentId: keyRecord.name,
      scope: keyRecord.scope
    }, 200)

  } catch (error) {
    return c.json({ valid: false, error: String(error) }, 500)
  }
})
