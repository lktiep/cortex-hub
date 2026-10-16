import * as vscode from 'vscode'
import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { DEFAULT_HUB_WS_URL, detectHub, toConductorWsUrl } from './mcp-config.js'
import type { HubDetection } from './mcp-config.js'

export interface CortexConfig {
  apiKey: string
  hubUrl: string
  agentId: string
  ide: string
  platform: string
  capabilities: string[]
  autoConnect: boolean
  /** Where the hub was detected from (a config path or "default"). Never the key. */
  hubSource: string
}

/** Detect which IDE we're running in */
function detectIde(): string {
  const appName = vscode.env.appName?.toLowerCase() ?? ''
  if (appName.includes('antigravity')) return 'antigravity'
  if (appName.includes('cursor')) return 'cursor'
  if (appName.includes('windsurf')) return 'windsurf'
  return 'vscode'
}

/** Friendly platform name */
function friendlyPlatform(): string {
  switch (process.platform) {
    case 'darwin': return 'macOS'
    case 'win32': return 'Windows'
    case 'linux': return 'Linux'
    default: return process.platform
  }
}

function homedir(): string {
  return process.env['HOME'] || process.env['USERPROFILE'] || ''
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return undefined
  }
}

/** First env var in `names` that is set and non-empty. */
function firstEnv(names: string[]): string | undefined {
  for (const name of names) {
    const v = process.env[name]
    if (v) return v
  }
  return undefined
}

/** Resolve the conductor WebSocket URL: setting, env, MCP config, default. */
function resolveHubUrl(settings: vscode.WorkspaceConfiguration, detected: HubDetection | undefined): string {
  const settingsUrl = settings.get<string>('hubUrl', '')
  if (settingsUrl) {
    const ws = toConductorWsUrl(settingsUrl)
    if (ws) return ws
  }
  for (const name of ['CORTEX_HUB_WS_URL', 'CORTEX_HUB_URL']) {
    const v = process.env[name]
    const ws = v ? toConductorWsUrl(v) : undefined
    if (ws) return ws
  }
  return detected?.wsUrl ?? DEFAULT_HUB_WS_URL
}

/** Resolve the API key: setting, env, MCP config. */
function resolveApiKey(settings: vscode.WorkspaceConfiguration, detected: HubDetection | undefined): string {
  const settingsKey = settings.get<string>('apiKey', '')
  if (settingsKey) return settingsKey
  return firstEnv(['CORTEX_HUB_API_KEY', 'HUB_API_KEY', 'CORTEX_API_KEY']) ?? detected?.apiKey ?? ''
}

export function getConfig(): CortexConfig {
  const settings = vscode.workspace.getConfiguration('cortexHub')
  const ide = detectIde()
  const agentId = settings.get<string>('agentId', '') || `${hostname()}-${ide}`

  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  const detected = detectHub(readText, homedir(), workspace, process.env)

  return {
    apiKey: resolveApiKey(settings, detected),
    hubUrl: resolveHubUrl(settings, detected),
    agentId,
    ide,
    platform: friendlyPlatform(),
    capabilities: settings.get<string[]>('capabilities', ['code-edit', 'terminal', 'file-read']),
    autoConnect: settings.get<boolean>('autoConnect', true),
    hubSource: detected?.source ?? 'default',
  }
}
