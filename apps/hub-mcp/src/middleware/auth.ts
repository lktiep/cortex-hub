import type { Env } from '../types.js'

interface CachedAuth {
  valid: boolean;
  agentId?: string;
  scope?: string;
  permissions?: string[];
  error?: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedAuth>();
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes in milliseconds

/**
 * API key authentication middleware for MCP requests.
 *
 * Verifies the Bearer token by pinging the Dashboard API
 * which validates the hashed token against the SQLite database.
 * Caches the result in memory to prevent database roundtrips on every tool call.
 */
export async function validateApiKey(
  request: Request,
  env: Env
): Promise<{ valid: boolean; error?: string; agentId?: string; scope?: string; permissions?: string[] }> {
  // Allow health checks without auth
  const url = new URL(request.url)
  if (url.pathname === '/health') {
    return { valid: true }
  }

  const authHeader = request.headers.get('Authorization')

  if (!authHeader) {
    return { valid: false, error: 'Missing Authorization header' }
  }

  const [scheme, token] = authHeader.split(' ')

  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return { valid: false, error: 'Invalid Authorization format. Use: Bearer <API_KEY>' }
  }

  // 1. Check cache first
  const now = Date.now()
  const cached = tokenCache.get(token)
  if (cached && cached.expiresAt > now) {
    if (cached.valid) {
      return { valid: true, agentId: cached.agentId, scope: cached.scope, permissions: cached.permissions }
    } else {
      return { valid: false, error: cached.error }
    }
  }

  // Periodic eviction of expired items to prevent leaks
  if (tokenCache.size > 1000) {
    for (const [key, val] of tokenCache.entries()) {
      if (val.expiresAt < now) {
        tokenCache.delete(key)
      }
    }
  }

  // 2. Fetch verification from API
  try {
    const apiUrl = env.DASHBOARD_API_URL || 'http://localhost:4000'
    const res = await fetch(`${apiUrl}/api/keys/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(3000), // Fail fast (3s) instead of hanging
    })

    if (!res.ok) {
      if (res.status === 401) {
        const errorMsg = 'Invalid API key'
        // Cache authentication failure briefly (15s) to prevent hammering
        tokenCache.set(token, { valid: false, error: errorMsg, expiresAt: now + 15 * 1000 })
        return { valid: false, error: errorMsg }
      }
      return { valid: false, error: `Authentication service returned ${res.status}` }
    }

    const data = await res.json() as { valid: boolean; agentId?: string; scope?: string; permissions?: string[]; error?: string }

    if (data.valid) {
      const result = { valid: true, agentId: data.agentId, scope: data.scope, permissions: data.permissions }
      // Cache valid key for 2 minutes
      tokenCache.set(token, { ...result, expiresAt: now + CACHE_TTL_MS })
      return result
    } else {
      const errorMsg = data.error || 'Authentication failed'
      // Cache authentication failure briefly (15s)
      tokenCache.set(token, { valid: false, error: errorMsg, expiresAt: now + 15 * 1000 })
      return { valid: false, error: errorMsg }
    }
  } catch (err) {
    return { valid: false, error: `Failed to contact authentication service: ${String(err)}` }
  }
}

/**
 * Invalidates the token cache.
 * If token is provided, evicts that specific token; otherwise clears all.
 */
export function invalidateTokenCache(token?: string): void {
  if (token) {
    tokenCache.delete(token)
  } else {
    tokenCache.clear()
  }
}

