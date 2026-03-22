import type { Env } from './types.js'

/**
 * Make an API call to dashboard-api.
 *
 * hub-mcp runs as a separate service, so this always uses
 * HTTP fetch to reach dashboard-api via DASHBOARD_API_URL.
 */
export async function apiCall(
  env: Env,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const baseUrl = env.DASHBOARD_API_URL || 'http://localhost:4000'
  return fetch(`${baseUrl}${path}`, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(10000),
  })
}
