import { join } from 'node:path'

/** Pure MCP-config detection. All file access is injected; nothing here touches fs or vscode. */

export const DEFAULT_HUB_WS_URL = 'ws://localhost:8318/ws/conductor'

/** Returns the file text, or undefined when the file is missing or unreadable. */
export type ReadText = (path: string) => string | undefined
export interface McpEntry { [k: string]: unknown }
export interface HubDetection { mcpUrl: string; wsUrl: string; apiKey: string | null; source: string }

type Env = Record<string, string | undefined>

const CONDUCTOR_PATH = '/ws/conductor'
const KEY_ENV_NAMES = ['HUB_API_KEY', 'CORTEX_HUB_API_KEY', 'CORTEX_API_KEY']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Map any hub or MCP URL to its conductor WebSocket URL, or undefined when it is not one. */
export function toConductorWsUrl(raw: string): string | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  const scheme: Record<string, string> = { 'http:': 'ws:', 'https:': 'wss:', 'ws:': 'ws:', 'wss:': 'wss:' }
  const protocol = scheme[url.protocol]
  if (!protocol) return undefined

  let path = url.pathname.replace(/\/+$/, '')
  if (path.endsWith(CONDUCTOR_PATH)) {
    // already a conductor URL
  } else if (path.endsWith('/mcp')) {
    path = `${path.slice(0, -'/mcp'.length)}${CONDUCTOR_PATH}`
  } else {
    path = `${path}${CONDUCTOR_PATH}`
  }
  return `${protocol}//${url.host}${path}`
}

/** Config files that may hold the cortex entry, in the order scripts/install.sh resolves them. */
export function mcpSources(home: string, workspace?: string): Array<{ path: string; project?: string }> {
  const out: Array<{ path: string; project?: string }> = []
  if (workspace) out.push({ path: join(workspace, '.mcp.json') })
  if (workspace) out.push({ path: join(home, '.claude.json'), project: workspace })
  out.push({ path: join(home, '.claude.json') })
  out.push({ path: join(home, '.claude', 'claude_mcp_config.json') })
  if (workspace) out.push({ path: join(workspace, '.gemini', 'settings.json') })
  out.push({ path: join(home, '.gemini', 'settings.json') })
  out.push({ path: join(home, '.gemini', 'antigravity', 'mcp_config.json') })
  out.push({ path: join(home, '.cursor', 'mcp.json') })
  out.push({ path: join(home, '.codeium', 'windsurf', 'mcp_config.json') })
  if (workspace) out.push({ path: join(workspace, '.vscode', 'mcp.json') })
  return out
}

/** The `cortex-hub` server, else the first server whose name contains "cortex". */
export function findCortexEntry(doc: unknown, project?: string): McpEntry | undefined {
  if (!isRecord(doc)) return undefined
  let servers: unknown
  if (project !== undefined) {
    const projects = doc['projects']
    const scoped = isRecord(projects) ? projects[project] : undefined
    servers = isRecord(scoped) ? scoped['mcpServers'] : undefined
  } else {
    servers = isRecord(doc['mcpServers']) ? doc['mcpServers'] : doc['servers']
  }
  if (!isRecord(servers)) return undefined
  const exact = servers['cortex-hub']
  if (isRecord(exact)) return exact
  const name = Object.keys(servers).find((k) => k.toLowerCase().includes('cortex') && isRecord(servers[k]))
  return name === undefined ? undefined : (servers[name] as McpEntry)
}

/** Read the endpoint URL and API key out of one MCP server entry. */
export function entryEndpoint(entry: McpEntry, env: Env = {}): { url?: string; apiKey?: string } {
  const entryEnv: Env = {}
  if (isRecord(entry['env'])) {
    for (const [k, v] of Object.entries(entry['env'])) {
      if (typeof v === 'string') entryEnv[k] = v
    }
  }
  const headers = isRecord(entry['headers']) ? entry['headers'] : {}
  const args = Array.isArray(entry['args'])
    ? entry['args'].filter((a): a is string => typeof a === 'string')
    : []

  const url =
    asString(entry['url']) ??
    asString(entry['httpUrl']) ??
    asString(entry['serverUrl']) ??
    asString(entry['serverURL']) ??
    args.find((a) => a.startsWith('http'))

  let auth = asString(headers['Authorization']) ?? asString(headers['authorization'])
  if (auth === undefined) {
    for (let i = 0; i < args.length - 1; i++) {
      const next = args[i + 1]
      if (args[i] === '--header' && next !== undefined && next.toLowerCase().startsWith('authorization:')) {
        auth = next.slice(next.indexOf(':') + 1)
        break
      }
    }
  }

  let apiKey: string | undefined
  if (auth !== undefined) {
    const expanded = auth
      .replace(/\$\{(\w+)\}/g, (_m, name: string) => entryEnv[name] ?? env[name] ?? '')
      .trim()
      .replace(/^bearer\s+/i, '')
      .trim()
    apiKey = expanded === '' ? undefined : expanded
  }
  if (apiKey === undefined) {
    for (const name of KEY_ENV_NAMES) {
      const v = asString(entryEnv[name])
      if (v !== undefined) {
        apiKey = v
        break
      }
    }
  }

  const out: { url?: string; apiKey?: string } = {}
  if (url !== undefined) out.url = url
  if (apiKey !== undefined) out.apiKey = apiKey
  return out
}

/** Find the hub from the first MCP config whose cortex entry has a usable URL. */
export function detectHub(
  read: ReadText,
  home: string,
  workspace?: string,
  env: Env = {},
): HubDetection | undefined {
  for (const source of mcpSources(home, workspace)) {
    const text = read(source.path)
    if (text === undefined) continue
    let doc: unknown
    try {
      doc = JSON.parse(text)
    } catch {
      continue
    }
    const entry = findCortexEntry(doc, source.project)
    if (!entry) continue
    const { url, apiKey } = entryEndpoint(entry, env)
    if (url === undefined) continue
    const derived = toConductorWsUrl(url)
    if (derived === undefined) continue
    const entryEnv = isRecord(entry['env']) ? entry['env'] : {}
    const overrideRaw = asString(entryEnv['CORTEX_HUB_WS_URL'])
    const override = overrideRaw === undefined ? undefined : toConductorWsUrl(overrideRaw)
    return {
      mcpUrl: url,
      wsUrl: override ?? derived,
      apiKey: apiKey ?? null,
      source: source.project !== undefined ? `${source.path}#projects` : source.path,
    }
  }
  return undefined
}

/** Build the conductor connect URL. `wsUrl` already ends in /ws/conductor; the query is URL-encoded. */
export function conductorConnectUrl(
  wsUrl: string,
  p: { apiKey: string; agentId: string; capabilities: string[]; ide: string; platform: string; hostname: string },
): string {
  const url = new URL(wsUrl)
  url.searchParams.set('apiKey', p.apiKey)
  url.searchParams.set('agentId', p.agentId)
  url.searchParams.set('capabilities', JSON.stringify(p.capabilities))
  url.searchParams.set('ide', p.ide)
  url.searchParams.set('platform', p.platform)
  url.searchParams.set('hostname', p.hostname)
  return url.toString()
}

const URL_ENV_NAMES = ['CORTEX_HUB_WS_URL', 'CORTEX_HUB_URL']
const API_KEY_ENV_NAMES = ['CORTEX_HUB_API_KEY', 'HUB_API_KEY', 'CORTEX_API_KEY']

/**
 * Resolve the conductor URL: setting, env, MCP config, default. `source` is a plain label
 * ('setting', 'env:<NAME>', the config path or 'default'); it never carries the key.
 * An invalid setting or env URL falls through. `detect` runs only when needed.
 */
export function resolveHubUrl(
  setting: string,
  env: Env,
  detect: () => HubDetection | undefined,
): { url: string; source: string } {
  const fromSetting = setting ? toConductorWsUrl(setting) : undefined
  if (fromSetting) return { url: fromSetting, source: 'setting' }
  for (const name of URL_ENV_NAMES) {
    const raw = env[name]
    const ws = raw ? toConductorWsUrl(raw) : undefined
    if (ws) return { url: ws, source: `env:${name}` }
  }
  const detected = detect()
  if (detected) return { url: detected.wsUrl, source: detected.source }
  return { url: DEFAULT_HUB_WS_URL, source: 'default' }
}

/** Resolve the API key: setting, env, MCP config, ''. `detect` runs only when needed. */
export function resolveApiKey(setting: string, env: Env, detect: () => HubDetection | undefined): string {
  if (setting) return setting
  for (const name of API_KEY_ENV_NAMES) {
    const v = env[name]
    if (v) return v
  }
  return detect()?.apiKey ?? ''
}
