import type { Env } from './types.js'

/**
 * Internal fetch function — set by dashboard-api at startup
 * to avoid HTTP self-fetch deadlock when running in same process.
 * Uses Hono's app.request() which processes requests in-memory.
 */
let _internalFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null

/**
 * Configure the internal fetch function.
 * Called by dashboard-api at startup to inject app.request().
 */
export function setInternalFetch(fn: (path: string, init?: RequestInit) => Promise<Response>) {
  _internalFetch = fn
}

/**
 * Make an API call to dashboard-api.
 *
 * When running inside the same process (All-in-One Hub), uses
 * the injected internalFetch (Hono app.request) to avoid HTTP self-fetch deadlock.
 * Falls back to global fetch() for standalone deployments.
 */
export async function apiCall(
  env: Env,
  path: string,
  init?: RequestInit
): Promise<Response> {
  if (_internalFetch) {
    return _internalFetch(path, init)
  }

  const baseUrl = env.DASHBOARD_API_URL || 'http://localhost:4000'
  return fetch(`${baseUrl}${path}`, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(10000),
  })
}
