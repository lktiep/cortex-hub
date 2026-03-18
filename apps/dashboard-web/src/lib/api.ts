import { config } from './config'

interface ApiOptions {
  method?: string
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
}

class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public data?: unknown
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function apiFetch<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const { method = 'GET', body, headers = {}, signal } = options

  const res = await fetch(`${config.api.base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  })

  if (!res.ok) {
    const data = await res.json().catch(() => null)
    throw new ApiError(
      data?.error ?? `API error: ${res.status}`,
      res.status,
      data
    )
  }

  return res.json() as Promise<T>
}

// ── Health ──
export async function checkHealth() {
  return apiFetch<{ status: string; services?: Record<string, unknown>; uptime?: number }>('/health')
}

// ── API Keys ──
export interface ApiKey {
  id: string
  name: string
  prefix: string
  scope: string
  permissions: string[]
  createdAt: string
  expiresAt: string | null
  lastUsed: string | null
}

export async function listApiKeys() {
  return apiFetch<{ keys: ApiKey[] }>('/api/keys')
}

export async function createApiKey(data: {
  name: string
  scope: string
  permissions: string[]
  expiresInDays?: number
}) {
  return apiFetch<{ key: string; prefix: string; id: string }>('/api/keys', {
    method: 'POST',
    body: data,
  })
}

export async function revokeApiKey(id: string) {
  return apiFetch<{ success: boolean }>(`/api/keys/${id}`, { method: 'DELETE' })
}

// ── MCP Health ──
export async function checkMcpHealth() {
  const res = await fetch(config.mcp.health, { signal: AbortSignal.timeout(5000) })
  return res.json()
}

// ── Setup ──
export async function getSetupStatus() {
  return apiFetch<{ completed: boolean; step?: string }>('/api/setup/status')
}

export async function completeSetup(data: {
  provider: string
  models: string[]
}) {
  return apiFetch('/api/setup/complete', { method: 'POST', body: data })
}

export interface ModelResponse {
  data: { id: string }[]
}

export async function getModels() {
  const res = await fetch(`${config.api.setup}/models`, { signal: AbortSignal.timeout(10000) })
  if (!res.ok) throw new Error('Failed to fetch models: Connection to CLIProxy failed')
  return res.json() as Promise<ModelResponse>
}

export async function testConnection() {
  const res = await fetch(`${config.api.setup}/test`, { signal: AbortSignal.timeout(10000) })
  return res.json() as Promise<{ cliproxy: boolean; qdrant: boolean; dashboardApi: boolean; allPassed: boolean }>
}

export { ApiError }
