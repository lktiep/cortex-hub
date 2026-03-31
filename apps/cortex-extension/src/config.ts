import * as vscode from 'vscode'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hostname } from 'node:os'

export interface CortexConfig {
  apiKey: string
  hubUrl: string
  agentId: string
  ide: string
  platform: string
  capabilities: string[]
  autoConnect: boolean
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

/** Read API key from workspace settings, env, or MCP config files */
function resolveApiKey(settings: vscode.WorkspaceConfiguration): string {
  // 1. VS Code workspace setting (cortexHub.apiKey)
  const settingsKey = settings.get<string>('apiKey', '')
  if (settingsKey) return settingsKey

  // 2. Environment variable
  const envKey = process.env['CORTEX_HUB_API_KEY'] || process.env['HUB_API_KEY']
  if (envKey) return envKey

  // 3. Auto-detect from MCP config files
  const key = readMcpEnvVar('HUB_API_KEY') ?? readMcpEnvVar('CORTEX_HUB_API_KEY') ?? readMcpEnvVar('CORTEX_API_KEY')
  if (key) return key

  // 4. Extract from --header arg in MCP config (Bearer token in args)
  const fromArgs = readMcpBearerFromArgs()
  if (fromArgs) return fromArgs

  return ''
}

/** Resolve hub URL from settings, env, or ~/.claude.json MCP config */
function resolveHubUrl(settings: vscode.WorkspaceConfiguration): string {
  // 1. VS Code workspace setting (cortexHub.hubUrl)
  const settingsUrl = settings.get<string>('hubUrl', '')
  if (settingsUrl) return settingsUrl

  // 2. Environment variable
  const envUrl = process.env['CORTEX_HUB_WS_URL']
  if (envUrl) return envUrl

  // 3. Auto-detect from MCP config (env var or args URL)
  const mcpUrl = readMcpEnvVar('CORTEX_HUB_WS_URL') ?? readMcpEnvVar('CORTEX_HUB_URL')
  if (mcpUrl) return mcpUrl

  // 4. Derive WS URL from MCP endpoint in args
  const mcpEndpoint = readMcpArgsUrl()
  if (mcpEndpoint) {
    try {
      const u = new URL(mcpEndpoint)
      const proto = u.protocol === 'https:' ? 'wss:' : 'ws:'
      return `${proto}//${u.host}/ws/conductor`
    } catch { /* ignore */ }
  }

  return 'wss://cortex-mcp.jackle.dev'
}

function homedir(): string {
  return process.env['HOME'] || process.env['USERPROFILE'] || ''
}

/** Read an env var value from MCP server configs in ~/.claude.json and IDE-specific MCP configs */
function readMcpEnvVar(varName: string): string | undefined {
  const mcpPaths = [
    join(homedir(), '.claude.json'),
    join(homedir(), '.claude', 'claude_mcp_config.json'),
    join(homedir(), '.cursor', 'mcp.json'),
    join(homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
    join(homedir(), '.gemini', 'antigravity', 'mcp_config.json'),
  ]

  for (const mcpPath of mcpPaths) {
    try {
      const raw = readFileSync(mcpPath, 'utf-8')
      const config = JSON.parse(raw)
      const servers = config.mcpServers ?? config.servers ?? {}
      for (const server of Object.values(servers) as Record<string, unknown>[]) {
        const env = (server['env'] ?? {}) as Record<string, string>
        if (env[varName]) return env[varName]
        // Check AUTH_HEADER which stores "Bearer <key>"
        if (varName.includes('API_KEY') && env['AUTH_HEADER']) {
          const val = env['AUTH_HEADER']
          return val.startsWith('Bearer ') ? val.slice(7) : val
        }
      }
    } catch {
      // File not found or invalid — skip
    }
  }

  return undefined
}

/** Read Bearer token from cortex-hub MCP args (--header "Authorization: Bearer xxx") */
function readMcpBearerFromArgs(): string | undefined {
  const mcpPaths = [
    join(homedir(), '.gemini', 'antigravity', 'mcp_config.json'),
    join(homedir(), '.claude.json'),
    join(homedir(), '.claude', 'claude_mcp_config.json'),
    join(homedir(), '.cursor', 'mcp.json'),
    join(homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
  ]

  for (const mcpPath of mcpPaths) {
    try {
      const raw = readFileSync(mcpPath, 'utf-8')
      const config = JSON.parse(raw)
      const servers = config.mcpServers ?? config.servers ?? {}
      const srv = servers['cortex-hub'] as Record<string, unknown> | undefined
      if (!srv) continue
      const args = srv['args'] as string[] | undefined
      if (!args) continue
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--header' && args[i + 1]) {
          const header = args[i + 1]
          if (header.startsWith('Authorization: Bearer ') || header.startsWith('Authorization:Bearer ')) {
            return header.replace(/^Authorization:\s*Bearer\s+/, '')
          }
        }
      }
    } catch {
      // skip
    }
  }
  return undefined
}

/** Read the MCP endpoint URL from cortex-hub server args (e.g. mcp-remote <url>) */
function readMcpArgsUrl(): string | undefined {
  const mcpPaths = [
    join(homedir(), '.claude.json'),
    join(homedir(), '.claude', 'claude_mcp_config.json'),
    join(homedir(), '.cursor', 'mcp.json'),
    join(homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
    join(homedir(), '.gemini', 'antigravity', 'mcp_config.json'),
  ]

  for (const mcpPath of mcpPaths) {
    try {
      const raw = readFileSync(mcpPath, 'utf-8')
      const config = JSON.parse(raw)
      const servers = config.mcpServers ?? config.servers ?? {}
      const srv = servers['cortex-hub'] as Record<string, unknown> | undefined
      if (!srv) continue
      const args = srv['args'] as string[] | undefined
      if (!args) continue
      // Find URL in args (after "mcp-remote")
      for (let i = 0; i < args.length; i++) {
        if (args[i]?.startsWith('http://') || args[i]?.startsWith('https://')) {
          return args[i]
        }
      }
    } catch {
      // skip
    }
  }
  return undefined
}

export function getConfig(): CortexConfig {
  const settings = vscode.workspace.getConfiguration('cortexHub')
  const ide = detectIde()
  const agentId = settings.get<string>('agentId', '') || `${hostname()}-${ide}`

  return {
    apiKey: resolveApiKey(settings),
    hubUrl: resolveHubUrl(settings),
    agentId,
    ide,
    platform: friendlyPlatform(),
    capabilities: settings.get<string[]>('capabilities', ['code-edit', 'terminal', 'file-read']),
    autoConnect: settings.get<boolean>('autoConnect', true),
  }
}
