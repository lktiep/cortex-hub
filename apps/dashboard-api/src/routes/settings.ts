import { Hono } from 'hono'
import { db } from '../db/client.js'
import os from 'node:os'

export const settingsRouter = new Hono()


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
    "UPDATE hub_config SET value = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE key = ?"
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
    "INSERT INTO notification_preferences (key, enabled, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at"
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
