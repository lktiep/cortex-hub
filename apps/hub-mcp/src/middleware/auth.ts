import type { Env } from '../types.js'
/**
 * API key authentication middleware for MCP requests.
 *
 * Verifies the Bearer token by pinging the Dashboard API
 * which validates the hashed token against the SQLite database.
 */
export async function validateApiKey(
  request: Request,
  env: Env
): Promise<{ valid: boolean; error?: string; agentId?: string; scope?: string }> {
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

  try {
    const res = await fetch(`${env.DASHBOARD_API_URL}/api/keys/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ token }),
    })

    if (!res.ok) {
      if (res.status === 401) {
        return { valid: false, error: 'Invalid API key' }
      }
      return { valid: false, error: `Authentication service returned ${res.status}` }
    }

    const data = await res.json() as { valid: boolean; agentId?: string; scope?: string; error?: string }

    if (data.valid) {
      return { valid: true, agentId: data.agentId, scope: data.scope }
    } else {
      return { valid: false, error: data.error || 'Authentication failed' }
    }
  } catch (err) {
    return { valid: false, error: `Failed to contact authentication service: ${String(err)}` }
  }
}
