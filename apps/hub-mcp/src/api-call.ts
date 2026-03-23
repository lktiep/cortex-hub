import type { Env } from './types.js'

/**
 * Make an API call to dashboard-api.
 *
 * hub-mcp runs as a separate service, so this always uses
 * HTTP fetch to reach dashboard-api via DASHBOARD_API_URL.
 *
 * When env.API_KEY_OWNER is set (resolved during auth), it's
 * forwarded as X-API-Key-Owner header so dashboard-api can
 * use the authoritative identity from the API key.
 */
export async function apiCall(
  env: Env,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const baseUrl = env.DASHBOARD_API_URL || 'http://localhost:4000'

  // Merge X-API-Key-Owner header when identity is resolved
  const headers = new Headers(init?.headers)
  if (env.API_KEY_OWNER && !headers.has('X-API-Key-Owner')) {
    headers.set('X-API-Key-Owner', env.API_KEY_OWNER)
  }

  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
    signal: init?.signal ?? AbortSignal.timeout(30000),
  })
}
