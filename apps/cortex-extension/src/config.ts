import * as vscode from 'vscode'
import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { detectHub, resolveApiKey, resolveHubUrl } from './mcp-config.js'
import type { HubDetection } from './mcp-config.js'

export interface CortexConfig {
  apiKey: string
  hubUrl: string
  agentId: string
  ide: string
  platform: string
  capabilities: string[]
  autoConnect: boolean
  /** Where hubUrl came from: 'setting', 'env:<NAME>', a config path or 'default'. Never the key. */
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

export function getConfig(): CortexConfig {
  const settings = vscode.workspace.getConfiguration('cortexHub')
  const ide = detectIde()
  const agentId = settings.get<string>('agentId', '') || `${hostname()}-${ide}`

  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  // Detection reads config files; run it at most once, and only if setting and env leave a gap.
  let detection: { value: HubDetection | undefined } | undefined
  const detect = (): HubDetection | undefined => {
    detection ??= { value: detectHub(readText, homedir(), workspace, process.env) }
    return detection.value
  }
  const hub = resolveHubUrl(settings.get<string>('hubUrl', ''), process.env, detect)

  return {
    apiKey: resolveApiKey(settings.get<string>('apiKey', ''), process.env, detect),
    hubUrl: hub.url,
    agentId,
    ide,
    platform: friendlyPlatform(),
    capabilities: settings.get<string[]>('capabilities', ['code-edit', 'terminal', 'file-read']),
    autoConnect: settings.get<boolean>('autoConnect', true),
    hubSource: hub.source,
  }
}
