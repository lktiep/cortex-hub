/**
 * The public https origin a request came in through, or null.
 *
 * Behind a tunnel or a reverse proxy the MCP gateway sees the hostname the agent dialled in
 * `Host` (or `X-Forwarded-Host`) and the scheme in `X-Forwarded-Proto`. That is the address the
 * dashboard should hand out when no EXTERNAL_MCP_URL is set, so the gateway reports it to the
 * dashboard API. Only an https origin on a domain name counts: a LAN IP, localhost or a `.local`
 * name works only from where the agent sat, and plain http is not what a tunnel serves.
 */
export function publicOrigin(header: (name: string) => string | null | undefined): string | null {
  const first = (name: string): string => (header(name) ?? '').split(',')[0]?.trim().toLowerCase() ?? ''
  if (first('x-forwarded-proto') !== 'https') return null
  const host = first('x-forwarded-host') || first('host')
  return isPublicOrigin(`https://${host}`) ? `https://${host.replace(/:443$/, '')}` : null
}

/** True for `https://<domain>[:port]` with no path, where the domain is not local or an IP. */
export function isPublicOrigin(origin: unknown): origin is string {
  if (typeof origin !== 'string' || origin.length > 300) return false
  const m = /^https:\/\/([a-z0-9.-]+)(:\d{1,5})?$/.exec(origin)
  if (!m) return false
  const name = m[1] as string
  if (!name.includes('.') || name.startsWith('.') || name.endsWith('.') || name.includes('..')) return false
  if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local')) return false
  if (/^[\d.]+$/.test(name)) return false
  return true
}
