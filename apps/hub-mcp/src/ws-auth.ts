import type { IncomingHttpHeaders } from 'node:http'
import { validateApiKey, type AuthResult } from './middleware/auth.js'

/**
 * Checks the API key of a WebSocket upgrade, sent as ?apiKey= or as a Bearer header.
 *
 * It goes through the same check as /mcp, cache included, so a key verified in the last two
 * minutes still passes while the dashboard API restarts after a deploy.
 */
export async function validateWsAuth(
  reqUrl: string,
  headers: IncomingHttpHeaders,
  dashboardApiUrl: string,
): Promise<AuthResult> {
  const url = new URL(reqUrl || '/', `http://${headers.host || 'localhost'}`)
  const forwarded = new Headers()
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) forwarded.set(name, Array.isArray(value) ? (value[0] ?? '') : value)
  }
  const fromQuery = url.searchParams.get('apiKey')
  if (fromQuery) forwarded.set('authorization', `Bearer ${fromQuery}`)
  if (!forwarded.get('authorization')) {
    return { valid: false, error: 'Missing API key. Use ?apiKey=xxx or Authorization: Bearer xxx' }
  }
  return validateApiKey(new Request(url, { headers: forwarded }), { DASHBOARD_API_URL: dashboardApiUrl })
}

/**
 * The status line an upgrade is refused with. A worker that hears 401 stops for good, so an
 * auth service that did not answer gets 503, which it retries.
 */
export function refusalStatus(auth: AuthResult): string {
  return auth.unavailable
    ? 'HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5'
    : 'HTTP/1.1 401 Unauthorized'
}
