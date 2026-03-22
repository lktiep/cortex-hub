/**
 * Hub MCP Environment configuration.
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
}

