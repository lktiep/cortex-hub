import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HubDetection } from './mcp-config.js'
import {
  DEFAULT_HUB_WS_URL,
  conductorConnectUrl,
  detectHub,
  entryEndpoint,
  mcpSources,
  resolveApiKey,
  resolveHubUrl,
  toConductorWsUrl,
} from './mcp-config.js'

const files = (map: Record<string, unknown | string>) => (path: string): string | undefined => {
  const v = map[path]
  if (v === undefined) return undefined
  return typeof v === 'string' ? v : JSON.stringify(v)
}

const http = (url: string, key?: string) => ({
  type: 'http',
  url,
  ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}),
})

describe('toConductorWsUrl', () => {
  it.each([
    ['https://mcp.example.com/mcp', 'wss://mcp.example.com/ws/conductor'],
    ['http://localhost:8318/mcp', 'ws://localhost:8318/ws/conductor'],
    ['https://example.com/hub/mcp/', 'wss://example.com/hub/ws/conductor'],
    ['wss://mcp.example.com', 'wss://mcp.example.com/ws/conductor'],
    ['ws://localhost:8318/ws/conductor', 'ws://localhost:8318/ws/conductor'],
    ['https://mcp.example.com/mcp?x=1#y', 'wss://mcp.example.com/ws/conductor'],
  ])('%s', (input, expected) => {
    expect(toConductorWsUrl(input)).toBe(expected)
  })

  it('rejects non-URLs and other schemes', () => {
    expect(toConductorWsUrl('not a url')).toBeUndefined()
    expect(toConductorWsUrl('ftp://x/mcp')).toBeUndefined()
  })

  it('default fallback is a conductor URL', () => {
    expect(DEFAULT_HUB_WS_URL.endsWith('/ws/conductor')).toBe(true)
  })
})

describe('entryEndpoint', () => {
  const U = 'https://mcp.example.com/mcp'

  it('http form', () => {
    expect(entryEndpoint(http(U, 'k1'))).toEqual({ url: U, apiKey: 'k1' })
  })
  it('lower-case header', () => {
    expect(entryEndpoint({ url: U, headers: { authorization: 'Bearer k1' } }).apiKey).toBe('k1')
  })
  it('mcp-remote with AUTH_HEADER env', () => {
    const e = {
      command: 'npx',
      args: ['-y', 'mcp-remote', U, '--header', 'Authorization:${AUTH_HEADER}'],
      env: { AUTH_HEADER: 'Bearer k2' },
    }
    expect(entryEndpoint(e)).toEqual({ url: U, apiKey: 'k2' })
  })
  it('mcp-remote literal header', () => {
    const e = { args: ['mcp-remote', U, '--header', 'Authorization: Bearer k3'] }
    expect(entryEndpoint(e).apiKey).toBe('k3')
  })
  it('env var key inside the header', () => {
    const e = {
      args: [U, '--header', 'Authorization: Bearer ${HUB_API_KEY}'],
      env: { HUB_API_KEY: 'k4' },
    }
    expect(entryEndpoint(e).apiKey).toBe('k4')
  })
  it('expands from the process env when the entry lacks the var', () => {
    const e = { url: U, headers: { Authorization: 'Bearer ${MY_KEY}' } }
    expect(entryEndpoint(e, { MY_KEY: 'k6' }).apiKey).toBe('k6')
  })
  it('windsurf serverUrl and gemini httpUrl', () => {
    expect(entryEndpoint({ serverUrl: U }).url).toBe(U)
    expect(entryEndpoint({ httpUrl: U }).url).toBe(U)
  })
  it('no auth falls back to env key', () => {
    expect(entryEndpoint({ args: [U], env: { HUB_API_KEY: 'k5' } }).apiKey).toBe('k5')
  })
})

describe('detectHub', () => {
  const home = '/h'
  const ws = '/w'
  const A = 'https://a.example.com/mcp'
  const B = 'https://b.example.com/mcp'
  const CLAUDE = join(home, '.claude.json')
  const MCPJSON = join(ws, '.mcp.json')
  const AGY = join(home, '.gemini', 'antigravity', 'mcp_config.json')
  const VSC = join(ws, '.vscode', 'mcp.json')
  const CURSOR = join(home, '.cursor', 'mcp.json')

  it('per-project entry beats top level', () => {
    const read = files({
      [CLAUDE]: {
        projects: { '/w': { mcpServers: { 'cortex-hub': http(A, 'ka') } } },
        mcpServers: { 'cortex-hub': http(B, 'kb') },
      },
    })
    const got = detectHub(read, home, ws, {})
    expect(got?.mcpUrl).toBe(A)
    expect(got?.apiKey).toBe('ka')
    expect(got?.source.endsWith('#projects')).toBe(true)
  })

  it('.mcp.json beats ~/.claude.json', () => {
    const read = files({
      [MCPJSON]: { mcpServers: { 'cortex-hub': http(A, 'ka') } },
      [CLAUDE]: { mcpServers: { 'cortex-hub': http(B, 'kb') } },
    })
    expect(detectHub(read, home, ws, {})?.mcpUrl).toBe(A)
  })

  it('takes the key from the same entry only', () => {
    const read = files({
      [CLAUDE]: { mcpServers: { 'cortex-hub': http(A) } },
      [AGY]: { mcpServers: { 'cortex-hub': http(B, 'kb') } },
    })
    const got = detectHub(read, home, ws, {})
    expect(got?.mcpUrl).toBe(A)
    expect(got?.apiKey).toBeNull()
  })

  it('prefers the cortex-hub key, else any cortex key', () => {
    const both = files({
      [CLAUDE]: {
        mcpServers: { 'cortex-dev': http(A, 'ka'), 'cortex-hub': http(B, 'kb') },
      },
    })
    expect(detectHub(both, home, ws, {})?.mcpUrl).toBe(B)
    const only = files({ [CLAUDE]: { mcpServers: { 'Cortex-X': http(A, 'ka') } } })
    expect(detectHub(only, home, ws, {})?.mcpUrl).toBe(A)
  })

  it('reads VS Code servers', () => {
    const read = files({ [VSC]: { servers: { 'cortex-hub': http(A) } } })
    expect(detectHub(read, home, ws, {})?.mcpUrl).toBe(A)
  })

  it('skips invalid and missing files', () => {
    const read = files({
      [MCPJSON]: '{not json',
      [CURSOR]: { mcpServers: { 'cortex-hub': http(A, 'ka') } },
    })
    expect(detectHub(read, home, ws, {})?.mcpUrl).toBe(A)
  })

  it('skips workspace sources without a workspace', () => {
    const read = files({ [MCPJSON]: { mcpServers: { 'cortex-hub': http(A) } } })
    expect(detectHub(read, home, undefined, {})).toBeUndefined()
  })

  it('returns undefined when nothing is found', () => {
    expect(detectHub(() => undefined, home, ws, {})).toBeUndefined()
  })

  it('derives wsUrl and honours the CORTEX_HUB_WS_URL override', () => {
    const plain = files({ [CLAUDE]: { mcpServers: { 'cortex-hub': http(A, 'ka') } } })
    expect(detectHub(plain, home, ws, {})?.wsUrl).toBe('wss://a.example.com/ws/conductor')
    const over = files({
      [CLAUDE]: {
        mcpServers: {
          'cortex-hub': {
            ...http(A, 'ka'),
            env: { CORTEX_HUB_WS_URL: 'wss://x.example.com/ws/conductor' },
          },
        },
      },
    })
    expect(detectHub(over, home, ws, {})?.wsUrl).toBe('wss://x.example.com/ws/conductor')
  })

  const withOverride = (value: string) =>
    files({
      [CLAUDE]: { mcpServers: { 'cortex-hub': { ...http(A, 'ka'), env: { CORTEX_HUB_WS_URL: value } } } },
    })

  it('normalises a valid override through toConductorWsUrl', () => {
    expect(detectHub(withOverride('https://x.example.com/mcp'), home, ws, {})?.wsUrl).toBe(
      'wss://x.example.com/ws/conductor',
    )
  })

  it('ignores an invalid override and keeps the derived URL', () => {
    expect(detectHub(withOverride('not a url'), home, ws, {})?.wsUrl).toBe('wss://a.example.com/ws/conductor')
  })
})

describe('mcpSources', () => {
  const home = '/h'
  const ws = '/w'

  it('pins the full order with a workspace', () => {
    expect(mcpSources(home, ws)).toEqual([
      { path: join(ws, '.mcp.json') },
      { path: join(home, '.claude.json'), project: ws },
      { path: join(home, '.claude.json') },
      { path: join(home, '.claude', 'claude_mcp_config.json') },
      { path: join(ws, '.gemini', 'settings.json') },
      { path: join(home, '.gemini', 'settings.json') },
      { path: join(home, '.gemini', 'antigravity', 'mcp_config.json') },
      { path: join(home, '.cursor', 'mcp.json') },
      { path: join(home, '.codeium', 'windsurf', 'mcp_config.json') },
      { path: join(ws, '.vscode', 'mcp.json') },
    ])
  })

  it('omits workspace-only sources without a workspace', () => {
    expect(mcpSources(home)).toEqual([
      { path: join(home, '.claude.json') },
      { path: join(home, '.claude', 'claude_mcp_config.json') },
      { path: join(home, '.gemini', 'settings.json') },
      { path: join(home, '.gemini', 'antigravity', 'mcp_config.json') },
      { path: join(home, '.cursor', 'mcp.json') },
      { path: join(home, '.codeium', 'windsurf', 'mcp_config.json') },
    ])
  })
})

describe('conductorConnectUrl', () => {
  const params = {
    apiKey: 'a+b/c=',
    agentId: 'host-vscode',
    capabilities: ['code-edit', 'terminal'],
    ide: 'vscode',
    platform: 'macOS',
    hostname: 'my host',
  }
  const out = conductorConnectUrl('wss://h.example.com/ws/conductor', params)

  it('has the conductor path exactly once', () => {
    expect(new URL(out).pathname).toBe('/ws/conductor')
  })
  it('round-trips the api key', () => {
    expect(new URL(out).searchParams.get('apiKey')).toBe('a+b/c=')
  })
  it('encodes capabilities as a JSON array', () => {
    const caps = new URL(out).searchParams.get('capabilities')
    expect(JSON.parse(caps ?? '')).toEqual(params.capabilities)
  })
  it('has exactly the six keys', () => {
    expect([...new URL(out).searchParams.keys()].sort()).toEqual(
      ['agentId', 'apiKey', 'capabilities', 'hostname', 'ide', 'platform'],
    )
  })
})

describe('resolveHubUrl / resolveApiKey', () => {
  const found: HubDetection = {
    mcpUrl: 'https://d.example.com/mcp',
    wsUrl: 'wss://d.example.com/ws/conductor',
    apiKey: 'kd',
    source: '/h/.claude.json',
  }
  const none = (): HubDetection | undefined => undefined
  const detect = (): HubDetection | undefined => found

  it('url: setting wins', () => {
    const env = { CORTEX_HUB_WS_URL: 'wss://e.example.com' }
    expect(resolveHubUrl('https://s.example.com/mcp', env, detect)).toEqual({
      url: 'wss://s.example.com/ws/conductor',
      source: 'setting',
    })
  })
  it('url: invalid setting falls through to env', () => {
    const env = { CORTEX_HUB_WS_URL: 'wss://e.example.com' }
    expect(resolveHubUrl('not a url', env, detect)).toEqual({
      url: 'wss://e.example.com/ws/conductor',
      source: 'env:CORTEX_HUB_WS_URL',
    })
  })
  it('url: CORTEX_HUB_WS_URL beats CORTEX_HUB_URL', () => {
    const env = { CORTEX_HUB_WS_URL: 'wss://a.example.com', CORTEX_HUB_URL: 'https://b.example.com' }
    expect(resolveHubUrl('', env, detect).source).toBe('env:CORTEX_HUB_WS_URL')
  })
  it('url: CORTEX_HUB_URL next, invalid WS env skipped', () => {
    const env = { CORTEX_HUB_WS_URL: 'nope', CORTEX_HUB_URL: 'https://b.example.com' }
    expect(resolveHubUrl('', env, detect)).toEqual({
      url: 'wss://b.example.com/ws/conductor',
      source: 'env:CORTEX_HUB_URL',
    })
  })
  it('url: detection, labelled with its source', () => {
    expect(resolveHubUrl('', {}, detect)).toEqual({ url: found.wsUrl, source: found.source })
  })
  it('url: default', () => {
    expect(resolveHubUrl('', {}, none)).toEqual({ url: DEFAULT_HUB_WS_URL, source: 'default' })
  })

  it('key: setting, then env order, then detection, then empty', () => {
    expect(resolveApiKey('ks', { CORTEX_HUB_API_KEY: 'k1' }, detect)).toBe('ks')
    const env = { CORTEX_API_KEY: 'k3', HUB_API_KEY: 'k2', CORTEX_HUB_API_KEY: 'k1' }
    expect(resolveApiKey('', env, detect)).toBe('k1')
    expect(resolveApiKey('', { CORTEX_API_KEY: 'k3', HUB_API_KEY: 'k2' }, detect)).toBe('k2')
    expect(resolveApiKey('', { CORTEX_API_KEY: 'k3' }, detect)).toBe('k3')
    expect(resolveApiKey('', {}, detect)).toBe('kd')
    expect(resolveApiKey('', {}, () => ({ ...found, apiKey: null }))).toBe('')
    expect(resolveApiKey('', {}, none)).toBe('')
  })

  it('does not detect when setting and env supply both', () => {
    let calls = 0
    const counting = () => { calls++; return found }
    const env = { CORTEX_HUB_WS_URL: 'wss://e.example.com', CORTEX_API_KEY: 'k3' }
    resolveHubUrl('', env, counting)
    resolveApiKey('', env, counting)
    expect(calls).toBe(0)
  })
  it('detects once when both resolvers need it (memoised thunk)', () => {
    let calls = 0
    let cached: HubDetection | undefined
    let done = false
    const memo = () => {
      if (!done) { calls++; cached = found; done = true }
      return cached
    }
    resolveHubUrl('', {}, memo)
    resolveApiKey('', {}, memo)
    expect(calls).toBe(1)
  })
})
