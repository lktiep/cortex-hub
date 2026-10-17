import { describe, expect, it } from 'vitest'
import type { HubDetection } from './mcp-config.js'
import { DEFAULT_CAPABILITIES, maskKey, normaliseAgentId, resolveIdentity } from './identity.js'

const found: HubDetection = {
  mcpUrl: 'https://d.example.com/mcp',
  wsUrl: 'wss://d.example.com/ws/conductor',
  apiKey: 'kd',
  source: '/h/.claude.json',
}
const detect = (): HubDetection | undefined => found
const none = (): HubDetection | undefined => undefined
const noSettings = { agentId: '', capabilities: undefined, apiKey: '' }

describe('resolveIdentity', () => {
  it('this window beats the settings, env and MCP configs', () => {
    const id = resolveIdentity(
      { agentId: 'win-a', capabilities: ['frontend'], apiKey: 'kw' },
      { agentId: 'Anti-01', capabilities: ['code-edit'], apiKey: 'ks' },
      'mac-antigravity',
      { CORTEX_API_KEY: 'ke' },
      detect,
    )
    expect(id).toEqual({ agentId: 'win-a', capabilities: ['frontend'], apiKey: 'kw', keySource: 'window' })
  })

  it('falls back to the settings, then the default name and capabilities', () => {
    expect(resolveIdentity({}, { agentId: 'Anti-01', capabilities: ['x'], apiKey: 'ks' }, 'mac-antigravity', {}, none))
      .toEqual({ agentId: 'Anti-01', capabilities: ['x'], apiKey: 'ks', keySource: 'setting' })
    expect(resolveIdentity({}, noSettings, 'mac-antigravity', {}, none))
      .toEqual({ agentId: 'mac-antigravity', capabilities: DEFAULT_CAPABILITIES, apiKey: '', keySource: 'none' })
  })

  it('blank window values do not count as a choice', () => {
    const id = resolveIdentity({ agentId: '  ', apiKey: ' ' }, { ...noSettings, agentId: 'Anti-01' }, 'd', {}, detect)
    expect(id.agentId).toBe('Anti-01')
    expect(id).toMatchObject({ apiKey: 'kd', keySource: found.source })
  })

  it('an empty capability list chosen for this window is kept', () => {
    expect(resolveIdentity({ capabilities: [] }, { ...noSettings, capabilities: ['x'] }, 'd', {}, none).capabilities).toEqual([])
  })

  it('labels env and MCP keys by where they came from', () => {
    expect(resolveIdentity({}, noSettings, 'd', { HUB_API_KEY: 'k2' }, detect)).toMatchObject({ apiKey: 'k2', keySource: 'env:HUB_API_KEY' })
    expect(resolveIdentity({}, noSettings, 'd', {}, detect)).toMatchObject({ apiKey: 'kd', keySource: '/h/.claude.json' })
  })

  it('does not read MCP configs when this window has a key', () => {
    let calls = 0
    resolveIdentity({ apiKey: 'kw' }, noSettings, 'd', {}, () => { calls++; return found })
    expect(calls).toBe(0)
  })
})

describe('normaliseAgentId', () => {
  it('trims and accepts ordinary names', () => {
    expect(normaliseAgentId('  win-a ')).toBe('win-a')
    expect(normaliseAgentId('Mac Antigravity 2')).toBe('Mac Antigravity 2')
  })
  it('rejects empty, too long and control characters', () => {
    expect(normaliseAgentId('   ')).toBeNull()
    expect(normaliseAgentId('a'.repeat(65))).toBeNull()
    expect(normaliseAgentId('a\nb')).toBeNull()
  })
})

describe('maskKey', () => {
  it('shows only the last 8 characters of a long key', () => {
    const key = 'x'.repeat(24) + 'tail5678'
    expect(maskKey(key)).toBe('***tail5678')
  })
  it('shows nothing of a short key', () => {
    expect(maskKey('k1')).toBe('***')
    expect(maskKey('')).toBe('')
  })
})
