/**
 * Hub MCP Environment configuration.
 */
export interface Env {
  // Backend service URLs
  QDRANT_URL: string
  CLIPROXY_URL: string
  DASHBOARD_API_URL: string

  // MCP Server metadata
  MCP_SERVER_NAME: string
  MCP_SERVER_VERSION: string

  // Auth (comma-separated API keys)
  API_KEYS: string

  // Secret token for internal auth (e.g. cache invalidation)
  INTERNAL_API_SECRET?: string

  // Resolved at runtime from API key during auth
  // This is the authoritative identity of the caller (api_keys.name)
  API_KEY_OWNER?: string

  // Resolved at runtime with API_KEY_OWNER: the key's id (api_keys.id), forwarded as
  // X-Cortex-Key-Id so dashboard-api limits the request to the key's organizations
  API_KEY_ID?: string

  // Resolved per request: the origin the caller dialled, for links a tool hands out
  PUBLIC_ORIGIN?: string
}

