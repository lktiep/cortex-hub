import { isPublicOrigin } from '@cortex/shared-types'
import { db } from '../db/client.js'

/**
 * The MCP gateway's public address, learned from agent traffic.
 *
 * Behind a domain the dashboard cannot work out where MCP is served: the two sit on separate
 * tunnel hostnames. The gateway knows, because agents dial it, and passes the https origin it saw
 * on each key check (X-Cortex-Public-Origin). EXTERNAL_MCP_URL, when set, still wins.
 */
const KEY = 'mcp.detected'

export interface DetectedMcpOrigin {
  url: string
  agentId: string | null
  at: string | null
}

/** Stores the origin an agent used, when it is a public https origin and differs from the last. */
export function recordMcpOrigin(origin: string | undefined, agentId: string | null): void {
  if (!isPublicOrigin(origin)) return
  if (detectedMcpOrigin()?.url === origin) return
  db.prepare(
    "INSERT OR REPLACE INTO hub_config (key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))",
  ).run(KEY, JSON.stringify({ url: origin, agentId }))
}

export function detectedMcpOrigin(): DetectedMcpOrigin | null {
  const row = db.prepare('SELECT value, updated_at FROM hub_config WHERE key = ?').get(KEY) as
    | { value: string; updated_at: string | null }
    | undefined
  if (!row) return null
  try {
    const parsed = JSON.parse(row.value) as { url?: unknown; agentId?: unknown }
    if (!isPublicOrigin(parsed.url)) return null
    return { url: parsed.url, agentId: typeof parsed.agentId === 'string' ? parsed.agentId : null, at: row.updated_at }
  } catch {
    return null
  }
}
