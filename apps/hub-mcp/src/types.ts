/**
 * Hub MCP Environment configuration.
 *
 * internalFetch: When hub-mcp runs inside dashboard-api (same process),
 * this is set to app.request() to avoid HTTP self-fetch deadlock.
 * Falls back to global fetch for external URLs (e.g. Qdrant).
 */
export interface Env {
  // Backend service URLs
  QDRANT_URL: string
  NEO4J_URL: string
  CLIPROXY_URL: string
  DASHBOARD_API_URL: string

  // MCP Server metadata
  MCP_SERVER_NAME: string
  MCP_SERVER_VERSION: string

  // Auth (comma-separated API keys)
  API_KEYS: string

  // In-memory request handler (avoids self-fetch deadlock)
  internalFetch?: (path: string, init?: RequestInit) => Promise<Response>
}
