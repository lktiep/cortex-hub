import { Hono } from 'hono'
import { db } from '../db/client.js'
import os from 'node:os'

export const settingsRouter = new Hono()

// ── Restore persisted embedding provider on module load ──
try {
  const saved = db.prepare("SELECT value FROM hub_config WHERE key = 'embedding_provider'").get() as { value: string } | undefined
  if (saved?.value && !process.env['EMBEDDING_PROVIDER']) {
    process.env['EMBEDDING_PROVIDER'] = saved.value
  }
  const savedModel = db.prepare("SELECT value FROM hub_config WHERE key = 'local_embedding_model'").get() as { value: string } | undefined
  if (savedModel?.value && !process.env['LOCAL_EMBEDDING_MODEL']) {
    process.env['LOCAL_EMBEDDING_MODEL'] = savedModel.value
  }
} catch { /* DB not ready yet */ }

// ── Hub Configuration ──

settingsRouter.get('/hub-config', (c) => {
  const rows = db.prepare('SELECT key, value FROM hub_config').all() as { key: string; value: string }[]
  const config: Record<string, string> = {}
  for (const row of rows) {
    config[row.key] = row.value
  }
  return c.json(config)
})

settingsRouter.put('/hub-config', async (c) => {
  const body = await c.req.json() as Record<string, string>
  const allowedKeys = ['hub_name', 'hub_description']

  const update = db.prepare(
    "UPDATE hub_config SET value = ?, updated_at = datetime('now') WHERE key = ?"
  )

  const results: Record<string, string> = {}
  for (const [key, value] of Object.entries(body)) {
    if (!allowedKeys.includes(key)) continue
    if (typeof value !== 'string' || value.length > 500) continue
    update.run(value.trim(), key)
    results[key] = value.trim()
  }

  return c.json({ success: true, updated: results })
})

// ── Embedding Provider ──

settingsRouter.get('/embedding-provider', (c) => {
  const provider = process.env['EMBEDDING_PROVIDER'] || 'local'
  const model = provider === 'local'
    ? (process.env['LOCAL_EMBEDDING_MODEL'] || 'Xenova/all-MiniLM-L6-v2')
    : (process.env['MEM9_EMBEDDING_MODEL'] || 'gemini-embedding-001')
  return c.json({ provider, model })
})

settingsRouter.put('/embedding-provider', async (c) => {
  const body = await c.req.json() as { provider: string; model?: string }
  if (!body.provider || !['local', 'gemini'].includes(body.provider)) {
    return c.json({ error: 'provider must be "local" or "gemini"' }, 400)
  }

  // Update process.env for this running instance
  process.env['EMBEDDING_PROVIDER'] = body.provider
  if (body.provider === 'local' && body.model) {
    process.env['LOCAL_EMBEDDING_MODEL'] = body.model
  }

  // Persist to hub_config so it survives restarts
  db.prepare(
    "INSERT INTO hub_config (key, value, updated_at) VALUES ('embedding_provider', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(body.provider)
  if (body.model) {
    db.prepare(
      "INSERT INTO hub_config (key, value, updated_at) VALUES ('local_embedding_model', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ).run(body.model)
  }

  return c.json({
    success: true,
    provider: body.provider,
    model: body.model ?? (body.provider === 'local' ? 'Xenova/all-MiniLM-L6-v2' : 'gemini-embedding-001'),
    warning: body.provider === 'local'
      ? 'Switching to local embedding (384d). Existing Qdrant vectors (768d) will auto-recreate on next use — re-index affected projects.'
      : undefined,
  })
})

// ── Notification Preferences ──

settingsRouter.get('/notifications', (c) => {
  const rows = db.prepare('SELECT key, enabled FROM notification_preferences').all() as { key: string; enabled: number }[]
  const prefs: Record<string, boolean> = {}
  for (const row of rows) {
    prefs[row.key] = row.enabled === 1
  }
  return c.json(prefs)
})

settingsRouter.put('/notifications', async (c) => {
  const body = await c.req.json() as Record<string, boolean>
  const allowedKeys = ['agent_disconnect', 'quality_gate_failure', 'task_assignment', 'session_handoff']

  const upsert = db.prepare(
    "INSERT INTO notification_preferences (key, enabled, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at"
  )

  const results: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(body)) {
    if (!allowedKeys.includes(key)) continue
    if (typeof value !== 'boolean') continue
    upsert.run(key, value ? 1 : 0)
    results[key] = value
  }

  return c.json({ success: true, updated: results })
})

// ── System Info ──

settingsRouter.get('/system-info', (c) => {
  const totalMem = os.totalmem()
  const freeMem = os.freemem()

  return c.json({
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    uptime: Math.floor(os.uptime()),
    processUptime: Math.floor(process.uptime()),
    memory: {
      total: totalMem,
      free: freeMem,
      used: totalMem - freeMem,
      percent: Math.round(((totalMem - freeMem) / totalMem) * 100),
    },
    cpuCores: os.cpus().length,
    loadAvg: os.loadavg().map(l => Math.round(l * 100) / 100),
  })
})
