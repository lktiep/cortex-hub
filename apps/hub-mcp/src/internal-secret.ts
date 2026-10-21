// dashboard-api answers /api only to callers it can trust when API_AUTH=required (see
// apps/dashboard-api/src/lib/api-auth.ts); this gateway is one by carrying INTERNAL_API_SECRET.
// fetch is wrapped once at startup so every call to the API carries it, including the ones
// written later, instead of each call site having to remember.

/** fetch that adds X-Internal-Secret to requests for `base` and passes everything else through. */
export function withInternalSecret(fetchImpl: typeof fetch, base: string, secret: string | undefined): typeof fetch {
  const root = base.replace(/\/+$/, '')
  if (!secret) return fetchImpl
  const wrapped = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url !== root && !url.startsWith(`${root}/`)) return fetchImpl(input, init)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    if (!headers.has('X-Internal-Secret')) headers.set('X-Internal-Secret', secret)
    return fetchImpl(input, { ...init, headers })
  }
  return wrapped as typeof fetch
}
