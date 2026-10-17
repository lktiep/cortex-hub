import { describe, expect, it } from 'vitest'
import { isPublicOrigin, publicOrigin } from '@cortex/shared-types'

const from = (headers: Record<string, string>) => publicOrigin((name) => headers[name])

describe('publicOrigin', () => {
  it('reads the host a tunnel forwarded over https', () => {
    expect(from({ 'x-forwarded-proto': 'https', host: 'mcp.example.com' })).toBe('https://mcp.example.com')
    expect(from({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'mcp.example.com', host: 'cortex-mcp:8317' }))
      .toBe('https://mcp.example.com')
  })

  it('takes the first value of a list and drops :443', () => {
    expect(from({ 'x-forwarded-proto': 'https, http', host: 'MCP.Example.com:443' })).toBe('https://mcp.example.com')
    expect(from({ 'x-forwarded-proto': 'https', host: 'mcp.example.com:8443' })).toBe('https://mcp.example.com:8443')
  })

  it('reports nothing for plain http, a LAN address or a local name', () => {
    expect(from({ host: 'mcp.example.com' })).toBeNull()
    expect(from({ 'x-forwarded-proto': 'http', host: 'mcp.example.com' })).toBeNull()
    for (const host of ['localhost:8318', '192.168.1.20:8318', 'cortex-mcp:8317', 'hub.local', '[::1]:8318', '']) {
      expect(from({ 'x-forwarded-proto': 'https', host })).toBeNull()
    }
  })

  it('refuses a host with a path or odd characters', () => {
    for (const host of ['mcp.example.com/evil', 'mcp.example.com@x.example.org', 'mcp example.com', 'a..example.com']) {
      expect(from({ 'x-forwarded-proto': 'https', host })).toBeNull()
    }
  })
})

describe('isPublicOrigin', () => {
  it('accepts an https domain origin only', () => {
    expect(isPublicOrigin('https://mcp.example.com')).toBe(true)
    expect(isPublicOrigin('https://mcp.example.com:8443')).toBe(true)
    expect(isPublicOrigin('http://mcp.example.com')).toBe(false)
    expect(isPublicOrigin('https://mcp.example.com/mcp')).toBe(false)
    expect(isPublicOrigin('https://10.0.0.5')).toBe(false)
    expect(isPublicOrigin(undefined)).toBe(false)
  })
})
