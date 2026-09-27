import { existsSync, readFileSync } from 'fs'

/**
 * GitNexus eval-server access.
 *
 * eval-server 1.6.12 refuses to bind a non-loopback host without a bearer token,
 * and enforces that token on every request — including `/health`. Since the
 * service runs in its own container, every call from here needs the header.
 *
 * The token comes from GITNEXUS_AUTH_TOKEN when an operator sets one, otherwise
 * from the file the gitnexus entrypoint generates on the shared api-data volume.
 */

const tokenFile = () => process.env.GITNEXUS_AUTH_TOKEN_FILE ?? '/app/data/gitnexus-auth-token'

let cachedToken: string | undefined

export function gitnexusUrl(): string {
  return process.env.GITNEXUS_URL ?? 'http://gitnexus:4848'
}

/**
 * Deliberately caches only on success: gitnexus may still be generating the
 * token file when this process starts, so a miss must stay retryable.
 */
export function gitnexusToken(): string | undefined {
  if (cachedToken) return cachedToken

  const fromEnv = process.env.GITNEXUS_AUTH_TOKEN?.trim()
  if (fromEnv) {
    cachedToken = fromEnv
    return cachedToken
  }

  try {
    const path = tokenFile()
    if (!existsSync(path)) return undefined
    const fromFile = readFileSync(path, 'utf8').trim()
    if (fromFile) {
      cachedToken = fromFile
      return cachedToken
    }
  } catch {
    // Unreadable token file — treat as unauthenticated and let the request 401.
  }

  return undefined
}

/** Merge the bearer header into request headers, omitting it when no token exists. */
export function gitnexusHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = gitnexusToken()
  return token ? { ...extra, Authorization: `Bearer ${token}` } : { ...extra }
}
