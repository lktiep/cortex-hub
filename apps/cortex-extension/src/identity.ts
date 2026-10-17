import { resolveApiKey } from './mcp-config.js'
import type { Env, HubDetection } from './mcp-config.js'

/**
 * What one window chose for itself in the Agent Panel. The extension keeps the name and
 * capabilities in workspaceState and the key in SecretStorage, so two windows can run two agents
 * with two keys, and nothing lands in a settings.json that might be committed.
 */
export interface WindowAgent {
  agentId?: string
  capabilities?: string[]
  apiKey?: string
}

export interface Identity {
  agentId: string
  capabilities: string[]
  apiKey: string
  /** 'window', 'setting', 'env:<NAME>', a config path or 'none'. Never the key. */
  keySource: string
}

export const DEFAULT_CAPABILITIES = ['code-edit', 'terminal', 'file-read']

/**
 * Who this window connects as: its own choice, then the `cortexHub.*` settings, then env and MCP
 * configs (key only), then the defaults. Blank strings do not count as a choice; an empty
 * capability list does. `detect` runs only when nothing earlier supplies a key.
 */
export function resolveIdentity(
  window: WindowAgent,
  settings: { agentId: string; capabilities: string[] | undefined; apiKey: string },
  defaultAgentId: string,
  env: Env,
  detect: () => HubDetection | undefined,
): Identity {
  const windowKey = window.apiKey?.trim()
  const key = windowKey ? { key: windowKey, source: 'window' } : resolveApiKey(settings.apiKey, env, detect)
  return {
    agentId: window.agentId?.trim() || settings.agentId.trim() || defaultAgentId,
    capabilities: window.capabilities ?? settings.capabilities ?? DEFAULT_CAPABILITIES,
    apiKey: key.key,
    keySource: key.source,
  }
}

/** A name the hub will show: trimmed, 1 to 64 characters, no control characters. Else null. */
export function normaliseAgentId(raw: string): string | null {
  const id = raw.trim()
  if (id.length === 0 || id.length > 64 || /[\u0000-\u001f\u007f]/.test(id)) return null
  return id
}

/** `***` and the last 8 characters, for logs and the panel. A short key shows nothing of itself. */
export function maskKey(key: string): string {
  if (!key) return ''
  return key.length >= 16 ? `***${key.slice(-8)}` : '***'
}
