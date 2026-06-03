// Resolve external URLs dynamically to support Tailscale, localhost, and custom domains
export const getExternalUrl = (type: 'dashboard' | 'api' | 'mcp' | 'cliproxy' | 'qdrant'): string => {
  if (typeof window === 'undefined') {
    if (type === 'mcp') return 'https://cortex-mcp.jackle.dev'
    if (type === 'cliproxy') return 'https://cortex-llm.jackle.dev'
    if (type === 'qdrant') return 'https://qdrant.hub.jackle.dev'
    return ''
  }

  const { protocol, hostname, port } = window.location
  const isJackle = hostname.includes('jackle.dev')

  if (isJackle) {
    if (type === 'dashboard') return 'https://hub.jackle.dev'
    if (type === 'api') return 'https://cortex-api.jackle.dev'
    if (type === 'mcp') return 'https://cortex-mcp.jackle.dev'
    if (type === 'cliproxy') return 'https://cortex-llm.jackle.dev'
    if (type === 'qdrant') return 'https://qdrant.hub.jackle.dev'
    return ''
  }

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

