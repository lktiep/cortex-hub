// Who may call /api. Nothing here used to check: anyone who could reach the port could read
// and change everything, and name any caller in X-API-Key-Owner. With API_AUTH=required a
// request is let through only when it comes
//   - from this host's own loopback (the API calling itself, scripts in the container),
//   - from hub-mcp, carrying INTERNAL_API_SECRET in X-Internal-Secret,
//   - through Cloudflare Access, whose signed Cf-Access-Jwt-Assertion is checked here, or
//   - with a valid API key as a Bearer token (the editor extension, scripts).
// X-API-Key-Owner is believed only from the first two; any other caller naming an owner is
// refused, since the owner decides whose sessions and projects a request acts on. The same
// holds for X-Cortex-Key-Id, the key hub-mcp calls for, which decides the organizations a
// request may reach (lib/key-scope.ts): a Bearer request is its own key's, and no other.
import { createHash, createPublicKey, timingSafeEqual, verify, type JsonWebKey, type KeyObject } from 'crypto'
import type { Context, MiddlewareHandler } from 'hono'
import { createLogger } from '@cortex/shared-utils'
import { db } from '../db/client.js'

const logger = createLogger('api-auth')

const CERTS_TTL = 60 * 60_000
/** A token signed by a key not in the cached set refetches the set, but not more often than this. */
const CERTS_REFETCH = 60_000

export interface AccessConfig {
  /** `<team>.cloudflareaccess.com`, with or without https:// */
  teamDomain: string
  /** The Application Audience (AUD) tag of the Access application in front of the dashboard. */
  aud: string
}

export interface ApiAuthOptions {
  required: boolean
  internalSecret?: string
  access?: AccessConfig
  /** The peer address of the request; the Node server's socket by default. */
  remoteAddress?: (c: Context) => string | undefined
  fetchImpl?: typeof fetch
}

export interface ApiKeyRecord {
  id: string
  name: string
  scope: string
  permissions: string
  expires_at: string | null
}

/** The key a token is, or why it is not one. Does not touch last_used_at. */
export function lookupApiKey(token: string): { key: ApiKeyRecord } | { error: string } {
  const hash = createHash('sha256').update(token).digest('hex')
  const key = db.prepare('SELECT id, name, scope, permissions, expires_at FROM api_keys WHERE key_hash = ?').get(hash) as ApiKeyRecord | undefined
  if (!key) return { error: 'Invalid API key' }
  // An expiry date that nothing checks is not an expiry date: keys created
  // with expiresInDays kept working forever.
  if (key.expires_at && Date.parse(key.expires_at) <= Date.now()) return { error: 'API key expired' }
  return { key }
}

export function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

const requestKeys = new WeakMap<Request, string>()

/** The id of the API key a request presented as its Bearer token, once apiAuth has checked it. */
export function authenticatedKeyId(c: Context): string | undefined {
  return requestKeys.get(c.req.raw)
}

function sameSecret(given: string | undefined, secret: string): boolean {
  if (!given) return false
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(secret).digest()
  return timingSafeEqual(a, b)
}

function base64url(part: string): Buffer {
  return Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

interface CertSet { at: number; keys: Map<string, KeyObject> }

/**
 * Checks Cloudflare Access's JWT against the team's published signing keys: RS256, the
 * team as issuer, the application's AUD, and not expired. Answers the identity it names.
 */
export function accessVerifier(config: AccessConfig, fetchImpl: typeof fetch = fetch) {
  const team = config.teamDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '')
  const issuer = `https://${team}`
  let certs: CertSet | null = null
  let lastFetch = 0

  async function signingKeys(force: boolean): Promise<Map<string, KeyObject>> {
    const fresh = certs !== null && Date.now() - certs.at < CERTS_TTL
    if (fresh && !(force && Date.now() - lastFetch > CERTS_REFETCH)) return certs!.keys
    lastFetch = Date.now()
    const res = await fetchImpl(`${issuer}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`Access certs: HTTP ${res.status}`)
    const body = await res.json() as { keys?: Array<JsonWebKey & { kid?: string }> }
    const keys = new Map<string, KeyObject>()
    for (const jwk of body.keys ?? []) {
      if (typeof jwk.kid === 'string') keys.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }))
    }
    certs = { at: Date.now(), keys }
    return keys
  }

  return async function verifyAccess(token: string): Promise<string | null> {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    let header: { alg?: string; kid?: string }
    let claims: { aud?: string | string[]; iss?: string; exp?: number; nbf?: number; email?: string; sub?: string; common_name?: string }
    try {
      header = JSON.parse(base64url(parts[0]!).toString('utf8'))
      claims = JSON.parse(base64url(parts[1]!).toString('utf8'))
    } catch {
      return null
    }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null
    let key = (await signingKeys(false)).get(header.kid)
    if (!key) key = (await signingKeys(true)).get(header.kid)
    if (!key) return null
    const signed = verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, base64url(parts[2]!))
    if (!signed) return null
    const now = Date.now() / 1000
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (claims.iss !== issuer || !audiences.includes(config.aud)) return null
    if (typeof claims.exp !== 'number' || claims.exp <= now) return null
    if (typeof claims.nbf === 'number' && claims.nbf > now + 60) return null
    // A service token carries common_name instead of an email.
    return claims.email ?? claims.common_name ?? claims.sub ?? 'access'
  }
}

/** The options the environment asks for. */
export function apiAuthFromEnv(env: NodeJS.ProcessEnv = process.env): ApiAuthOptions {
  const teamDomain = env['CF_ACCESS_TEAM_DOMAIN']?.trim()
  const aud = env['CF_ACCESS_AUD']?.trim()
  return {
    required: env['API_AUTH']?.trim().toLowerCase() === 'required',
    internalSecret: env['INTERNAL_API_SECRET'] || undefined,
    access: teamDomain && aud ? { teamDomain, aud } : undefined,
  }
}

/** One line on what the API accepts, for the startup log. */
export function describeApiAuth(opts: ApiAuthOptions): string {
  if (!opts.required) return 'API_AUTH is off: /api answers anyone who can reach this port'
  const ways = ['loopback', 'API keys']
  if (opts.internalSecret) ways.push('hub-mcp (internal secret)')
  if (opts.access) ways.push('Cloudflare Access')
  return `API_AUTH=required: /api accepts ${ways.join(', ')}`
}

function nodeRemoteAddress(c: Context): string | undefined {
  return (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress
}

export function apiAuth(opts: ApiAuthOptions): MiddlewareHandler {
  const remoteAddress = opts.remoteAddress ?? nodeRemoteAddress
  const verifyAccess = opts.access ? accessVerifier(opts.access, opts.fetchImpl) : null

  return async (c, next) => {
    if (!opts.required) return next()

    // Trusted callers may name the owner the request acts for.
    if (isLoopback(remoteAddress(c))) return next()
    if (opts.internalSecret && sameSecret(c.req.header('X-Internal-Secret'), opts.internalSecret)) return next()

    const deny = (status: 401 | 403, error: string) => c.json({ error }, status)
    const owner = c.req.header('X-API-Key-Owner')

    const bearer = c.req.header('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
    if (bearer) {
      const found = lookupApiKey(bearer)
      if ('error' in found) return deny(401, found.error)
      if (owner !== undefined && owner !== found.key.name) return deny(403, 'X-API-Key-Owner does not match the API key')
      const keyId = c.req.header('X-Cortex-Key-Id')
      if (keyId !== undefined && keyId !== found.key.id) return deny(403, 'X-Cortex-Key-Id does not match the API key')
      requestKeys.set(c.req.raw, found.key.id)
      return next()
    }

    const assertion = c.req.header('Cf-Access-Jwt-Assertion')
    if (verifyAccess && assertion) {
      let who: string | null = null
      try {
        who = await verifyAccess(assertion)
      } catch (err) {
        logger.warn(`Cloudflare Access check failed: ${String(err).slice(0, 200)}`)
        return c.json({ error: 'Could not check the Cloudflare Access token' }, 503)
      }
      if (who === null) return deny(401, 'Invalid Cloudflare Access token')
      if (owner !== undefined) return deny(403, 'X-API-Key-Owner is set by the MCP gateway only')
      if (c.req.header('X-Cortex-Key-Id') !== undefined) return deny(403, 'X-Cortex-Key-Id is set by the MCP gateway only')
      return next()
    }

    return deny(401, 'Authentication required: an API key (Authorization: Bearer) or Cloudflare Access')
  }
}
