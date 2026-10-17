// Resolve external URLs dynamically to support Tailscale, localhost, and custom domains
export const getExternalUrl = (type: 'dashboard' | 'api' | 'mcp' | 'cliproxy' | 'qdrant'): string => {
  if (typeof window === 'undefined') {
    if (type === 'dashboard') return 'http://localhost:3000'
    if (type === 'api') return 'http://localhost:4000'
    if (type === 'mcp') return 'http://localhost:8318'
    if (type === 'cliproxy') return 'http://localhost:8317'
    if (type === 'qdrant') return 'http://localhost:6333'
    return ''
  }

  const { protocol, hostname, port } = window.location

  // Self-hosted / Tailscale / Local setups
  if (type === 'dashboard' || type === 'api') {
    return `${protocol}//${hostname}${port ? `:${port}` : ''}`
  }
  if (type === 'mcp') {
    return `${protocol}//${hostname}:8318`
  }
  if (type === 'cliproxy') {
    return `${protocol}//${hostname}:8317`
  }
  if (type === 'qdrant') {
    return `${protocol}//${hostname}:6333`
  }
  return ''
}

export type McpEndpoint = {
  url: string | null
  source: 'configured' | 'detected' | 'direct' | 'unconfigured'
  // detected only: the agent whose connection showed the address
  agentId?: string | null
}

export type DetectedMcp = { url: string; agentId: string | null }

// The MCP address agents should put in their config. A configured EXTERNAL_MCP_URL
// always wins. Next comes the https address the gateway saw an agent dial: proven to
// work from outside. Without either, hostname:8318 is only right when the browser
// reaches the host itself (localhost, an IP, a LAN name, an explicit port). Behind a
// domain the dashboard and MCP sit on separate tunnel hostnames (hub.* is behind
// Cloudflare Access), so the address cannot be derived and none is invented.
export const resolveMcpEndpoint = (
  configured: string | null | undefined,
  location: { hostname: string; port: string },
  detected?: DetectedMcp | null,
): McpEndpoint => {
  const withMcp = (base: string) => (base.endsWith('/mcp') ? base : `${base}/mcp`)
  const base = configured?.trim().replace(/\/+$/, '')
  if (base) {
    return { url: withMcp(base), source: 'configured' }
  }
  if (detected?.url) {
    return { url: withMcp(detected.url.replace(/\/+$/, '')), source: 'detected', agentId: detected.agentId }
  }

  const { hostname, port } = location
  const isDirect =
    port !== '' ||
    hostname === 'localhost' ||
    hostname.startsWith('[') ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) ||
    !hostname.includes('.') ||
    hostname.endsWith('.local')
  if (isDirect) {
    // compose publishes 8318 as plain HTTP, whatever scheme the dashboard is on
    return { url: `http://${hostname}:8318/mcp`, source: 'direct' }
  }
  return { url: null, source: 'unconfigured' }
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? ''
const MCP_BASE = process.env.NEXT_PUBLIC_MCP_URL ?? getExternalUrl('mcp')

export const config = {
  api: {
    base: API_BASE,
    health: `${API_BASE}/health`,
    keys: `${API_BASE}/api/keys`,
    setup: `${API_BASE}/api/setup`,
    mcp: {
      endpoint: `${MCP_BASE}/mcp`,
      health: `${MCP_BASE}/health`,
    },
    llmProxy: {
      models: `${process.env.NEXT_PUBLIC_CLIPROXY_URL || getExternalUrl('cliproxy')}/v1/models`,
    }
  },
  mcp: {
    base: MCP_BASE,
    endpoint: `${MCP_BASE}/mcp`,
    health: `${MCP_BASE}/health`,
  },
  services: {
    cliproxy: process.env.NEXT_PUBLIC_CLIPROXY_URL ?? getExternalUrl('cliproxy'),
    qdrant: process.env.NEXT_PUBLIC_QDRANT_URL ?? getExternalUrl('qdrant'),
  },
}

