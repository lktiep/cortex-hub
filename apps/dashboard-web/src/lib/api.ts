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

// ── OAuth Flow ──
export async function startOAuth(provider: string) {
  return apiFetch<{
    success: boolean
    provider: string
    oauthUrl: string
    state: string
    originalOauthUrl?: string
  }>(`/api/setup/oauth/start/${provider}`)
}

export async function pollOAuthStatus(state: string) {
  return apiFetch<{
    status: 'wait' | 'ok' | 'error'
    error?: string
  }>(`/api/setup/oauth/status?state=${encodeURIComponent(state)}`)
}

// ── API Key Configuration ──
export async function configureProvider(data: { provider: string; apiKey: string }) {
  return apiFetch<{
    success: boolean
    provider: string
    authFile: string
    modelsDetected: number
  }>('/api/setup/configure-provider', { method: 'POST', body: data })
}

// ── Quality Logs ──
export interface QueryLog {
  id: number
  agent_id: string
  tool: string
  params: string | null
  latency_ms: number | null
  status: string
  error: string | null
  created_at: string
}

export async function getQualityLogs(limit = 50) {
  return apiFetch<{ logs: QueryLog[] }>(`/api/quality/logs?limit=${limit}`)
}

// ── Sessions ──
export interface SessionHandoff {
  id: string
  from_agent: string
  to_agent: string | null
  project: string
  task_summary: string
  context: string
  priority: number
  status: string
  claimed_by: string | null
  created_at: string
  expires_at: string | null
}

export async function getSessions(limit = 50) {
  return apiFetch<{ sessions: SessionHandoff[] }>(`/api/sessions/all?limit=${limit}`)
}

// ── Settings ──
export interface SettingsData {
  environment: string
  services: Record<string, string>
  database: string
  version: string
}

export async function getSettings() {
  return apiFetch<SettingsData>('/api/setup/settings')
}

export { ApiError }

// ── Organizations ──
export type Organization = {
  id: string
  name: string
  slug: string
  description: string | null
  project_count: number
  created_at: string
  updated_at: string
}

export type Project = {
  id: string
  org_id: string
  name: string
  slug: string
  description: string | null
  git_repo_url: string | null
  git_provider: string | null
  indexed_at: string | null
  indexed_symbols: number
  org_name?: string
  org_slug?: string
  created_at: string
  updated_at: string
  stats?: { apiKeys: number; queryLogs: number; sessions: number }
}

export async function getOrganizations() {
  return apiFetch<{ organizations: Organization[] }>('/api/orgs')
}

export async function createOrganization(data: { name: string; description?: string }) {
  return apiFetch<Organization>('/api/orgs', { method: 'POST', body: data })
}

export async function deleteOrganization(id: string) {
  return apiFetch<{ success: boolean }>(`/api/orgs/${id}`, { method: 'DELETE' })
}

export async function getProjectsForOrg(orgId: string) {
  return apiFetch<{ projects: Project[] }>(`/api/orgs/${orgId}/projects`)
}

export async function getAllProjects() {
  return apiFetch<{ projects: Project[] }>('/api/projects')
}

export async function createProject(orgId: string, data: {
  name: string
  description?: string
  gitRepoUrl?: string
  gitProvider?: string
}) {
  return apiFetch<Project>(`/api/orgs/${orgId}/projects`, { method: 'POST', body: data })
}

export async function getProject(id: string) {
  return apiFetch<Project & { stats: { apiKeys: number; queryLogs: number; sessions: number } }>(
    `/api/projects/${id}`
  )
}

export async function updateProject(id: string, data: {
  name?: string
  description?: string
  gitRepoUrl?: string
  gitProvider?: string
}) {
  return apiFetch<{ success: boolean }>(`/api/projects/${id}`, { method: 'PUT', body: data })
}

export async function deleteProject(id: string) {
  return apiFetch<{ success: boolean }>(`/api/projects/${id}`, { method: 'DELETE' })
}

