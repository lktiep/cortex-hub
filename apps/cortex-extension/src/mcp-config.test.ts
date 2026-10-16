import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HUB_WS_URL,
  detectHub,
  entryEndpoint,
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

  it('per-project entry beats top level', () => {
    const read = files({
      '/h/.claude.json': {
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
      '/w/.mcp.json': { mcpServers: { 'cortex-hub': http(A, 'ka') } },
      '/h/.claude.json': { mcpServers: { 'cortex-hub': http(B, 'kb') } },
    })
    expect(detectHub(read, home, ws, {})?.mcpUrl).toBe(A)
  })

  it('takes the key from the same entry only', () => {
    const read = files({
      '/h/.claude.json': { mcpServers: { 'cortex-hub': http(A) } },
      '/h/.gemini/antigravity/mcp_config.json': { mcpServers: { 'cortex-hub': http(B, 'kb') } },
    })
    const got = detectHub(read, home, ws, {})
    expect(got?.mcpUrl).toBe(A)
    expect(got?.apiKey).toBeNull()
  })

  it('prefers the cortex-hub key, else any cortex key', () => {
    const both = files({
      '/h/.claude.json': {
        mcpServers: { 'cortex-dev': http(A, 'ka'), 'cortex-hub': http(B, 'kb') },
      },
    })
    expect(detectHub(both, home, ws, {})?.mcpUrl).toBe(B)
    const only = files({ '/h/.claude.json': { mcpServers: { 'Cortex-X': http(A, 'ka') } } })
    expect(detectHub(only, home, ws, {})?.mcpUrl).toBe(A)
  })

  it('reads VS Code servers', () => {
    const read = files({ '/w/.vscode/mcp.json': { servers: { 'cortex-hub': http(A) } } })
    expect(detectHub(read, home, ws, {})?.mcpUrl).toBe(A)
  })

  it('skips invalid and missing files', () => {
    const read = files({
      '/w/.mcp.json': '{not json',
      '/h/.cursor/mcp.json': { mcpServers: { 'cortex-hub': http(A, 'ka') } },
    })
    expect(detectHub(read, home, ws, {})?.mcpUrl).toBe(A)
  })

  it('skips workspace sources without a workspace', () => {
    const read = files({ '/w/.mcp.json': { mcpServers: { 'cortex-hub': http(A) } } })
    expect(detectHub(read, home, undefined, {})).toBeUndefined()
  })

  it('returns undefined when nothing is found', () => {
    expect(detectHub(() => undefined, home, ws, {})).toBeUndefined()
  })

  it('derives wsUrl and honours the CORTEX_HUB_WS_URL override', () => {
    const plain = files({ '/h/.claude.json': { mcpServers: { 'cortex-hub': http(A, 'ka') } } })
    expect(detectHub(plain, home, ws, {})?.wsUrl).toBe('wss://a.example.com/ws/conductor')
    const over = files({
      '/h/.claude.json': {
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
})
