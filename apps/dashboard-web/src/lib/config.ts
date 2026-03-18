const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'https://api.hub.jackle.dev'
const MCP_BASE = process.env.NEXT_PUBLIC_MCP_URL ?? 'https://mcp.hub.jackle.dev'

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
      models: `${process.env.NEXT_PUBLIC_CLIPROXY_URL || 'http://localhost:8317'}/v1/models`,
    }
  },
  mcp: {
    base: MCP_BASE,
    endpoint: `${MCP_BASE}/mcp`,
    health: `${MCP_BASE}/health`,
  },
  services: {
    cliproxy: process.env.NEXT_PUBLIC_CLIPROXY_URL ?? 'https://llm.hub.jackle.dev',
    qdrant: process.env.NEXT_PUBLIC_QDRANT_URL ?? 'https://qdrant.hub.jackle.dev',
  },
}
