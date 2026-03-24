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
  return apiFetch<{ status: string; services?: Record<string, unknown>; uptime?: number; commit?: string; version?: string; buildDate?: string; image?: string }>('/health')
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

// ── Quality Logs (legacy) ──
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

export async function getQualityLogs(opts?: { limit?: number; page?: number }) {
  const params = new URLSearchParams()
  if (opts?.limit) params.set('limit', String(opts.limit))
  if (opts?.page) params.set('page', String(opts.page))
  return apiFetch<{ logs: QueryLog[]; total: number; page: number; limit: number; totalPages: number }>(`/api/quality/logs?${params}`)
}

// ── Quality Reports (4-dimension scoring) ──
export interface QualityReportRow {
  id: string
  project_id: string | null
  agent_id: string
  session_id: string | null
  gate_name: string
  score_build: number
  score_regression: number
  score_standards: number
  score_traceability: number
  score_total: number
  grade: string
  passed: number
  details: string | null
  api_key_name: string | null
  created_at: string
}

export interface QualityTrendData {
  date: string
  avg_score: number
  avg_build: number
  avg_regression: number
  avg_standards: number
  avg_traceability: number
  report_count: number
  worst_grade: string
  best_grade: string
}

export interface QualitySummary {
  total_reports: number
  avg_score: number | null
  avg_build: number | null
  avg_regression: number | null
  avg_standards: number | null
  avg_traceability: number | null
  passed_count: number
  failed_count: number
  grade_a: number
  grade_b: number
  grade_c: number
  grade_d: number
  grade_f: number
}

export async function getQualityReports(opts?: { limit?: number; page?: number; projectId?: string; agentId?: string; grade?: string }) {
  const params = new URLSearchParams()
  if (opts?.limit) params.set('limit', String(opts.limit))
  if (opts?.page) params.set('page', String(opts.page))
  if (opts?.projectId) params.set('project_id', opts.projectId)
  if (opts?.agentId) params.set('agent_id', opts.agentId)
  if (opts?.grade) params.set('grade', opts.grade)
  return apiFetch<{ reports: QualityReportRow[]; total: number; page: number; limit: number; totalPages: number }>(`/api/quality/reports?${params}`)
}

export async function getLatestQualityReport(projectId?: string) {
  const params = projectId ? `?project_id=${projectId}` : ''
  return apiFetch<{ report: QualityReportRow | null }>(`/api/quality/reports/latest${params}`)
}

export async function getQualityTrends(days = 30, projectId?: string) {
  const params = new URLSearchParams({ days: String(days) })
  if (projectId) params.set('project_id', projectId)
  return apiFetch<{ trends: QualityTrendData[]; days: number }>(`/api/quality/trends?${params}`)
}

export async function getQualitySummary() {
  return apiFetch<{ summary: QualitySummary; latest: QualityReportRow | null }>('/api/quality/summary')
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
  api_key_name: string | null
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
  git_username?: string | null
  git_token?: string | null
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
  gitUsername?: string
  gitToken?: string
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
  gitUsername?: string
  gitToken?: string
}) {
  return apiFetch<{ success: boolean }>(`/api/projects/${id}`, { method: 'PUT', body: data })
}

export async function deleteProject(id: string) {
  return apiFetch<{ success: boolean }>(`/api/projects/${id}`, { method: 'DELETE' })
}

// ── Dashboard Stats ──
export interface DashboardStats {
  activeKeys: number
  totalAgents: number
  memoryNodes: number
  uptime: number
  totalQueries: number
  totalSessions: number
  organizations: number
  projects: number
  today: { queries: number; tokens: number }
}

export async function getDashboardStats() {
  return apiFetch<DashboardStats>('/api/metrics/overview')
}

// ── Dashboard Overview (enriched v2) ──
export interface ProjectSummary {
  id: string
  name: string
  slug: string
  gitProvider: string | null
  gitRepoUrl: string | null
  gitnexus: {
    status: string
    symbols: number
    files: number
    branch: string | null
    completedAt: string | null
  }
  mem9: {
    status: string
    chunks: number
  }
  weeklyQueries: number
  activeSessions: number
  createdAt: string
}

export interface DashboardOverview {
  activeKeys: number
  totalAgents: number
  memoryNodes: number
  uptime: number
  totalQueries: number
  totalSessions: number
  organizations: number
  today: { queries: number; tokens: number }
  projects: ProjectSummary[]
  quality: {
    lastGrade: string
    lastScore: number
    reportsToday: number
    averageScore: number
  }
  knowledge: {
    totalDocs: number
    totalChunks: number
    totalHits: number
  }
}

export async function getDashboardOverview() {
  return apiFetch<DashboardOverview>('/api/metrics/overview-v2')
}

// ── Activity Feed ──
export interface ActivityEvent {
  type: 'query' | 'session'
  agent_id: string
  detail: string
  status: string
  latency_ms: number | null
  created_at: string
}

export async function getActivityFeed(limit = 30) {
  return apiFetch<{ activity: ActivityEvent[] }>(`/api/metrics/activity?limit=${limit}`)
}

// ── Budget ──
export interface BudgetData {
  daily_limit: number
  monthly_limit: number
  alert_threshold: number
  dailyUsed: number
  monthlyUsed: number
  dailyAlert: boolean
  monthlyAlert: boolean
}

export async function getBudget() {
  return apiFetch<BudgetData>('/api/metrics/budget')
}

export async function setBudget(data: { dailyLimit: number; monthlyLimit: number; alertThreshold?: number }) {
  return apiFetch<{ success: boolean }>('/api/metrics/budget', { method: 'POST', body: data })
}

// ── Usage (LLM Gateway) ──
export interface UsageSummary {
  totalRequests: number
  totalTokens: number
  promptTokens: number
  completionTokens: number
  todayRequests: number
  todayTokens: number
  estimatedCost: number
}

export interface UsageByModel {
  models: Array<{ model: string; requests: number; total_tokens: number; prompt_tokens: number; completion_tokens: number }>
}

export interface UsageByAgent {
  agents: Array<{ agent_id: string; requests: number; total_tokens: number; last_active: string }>
}

export interface UsageHistory {
  history: Array<{ day: string; requests: number; tokens: number }>
}

export async function getUsageSummary() {
  return apiFetch<UsageSummary>('/api/usage/summary')
}

export async function getUsageByModel() {
  return apiFetch<UsageByModel>('/api/usage/by-model')
}

export async function getUsageByAgent() {
  return apiFetch<UsageByAgent>('/api/usage/by-agent')
}

export async function getUsageHistory(days = 7) {
  return apiFetch<UsageHistory>(`/api/usage/history?days=${days}`)
}

// ── Admin ──
export async function restartService(service: string) {
  return apiFetch<{ success: boolean; message: string }>(`/api/metrics/admin/restart/${service}`, { method: 'POST' })
}

// ── Per-Project Analytics ──
export interface ProjectAnalytics {
  projectId: string
  queries: number
  sessions: number
  apiKeys: number
  totalTokens: number
  avgLatency: number
  errorRate: number
  trend: { day: string; count: number }[]
}

export async function getProjectAnalytics(projectId: string) {
  return apiFetch<ProjectAnalytics>(`/api/metrics/projects/${projectId}/analytics`)
}

// ── Indexing ──
export interface IndexStatus {
  jobId?: string
  branch?: string
  status: string
  progress?: number
  totalFiles?: number
  symbolsFound?: number
  error?: string | null
  log?: string | null
  startedAt?: string | null
  completedAt?: string | null
  createdAt?: string
  message?: string
}

export interface IndexJobSummary {
  id: string
  branch: string
  status: string
  progress: number
  total_files: number
  symbols_found: number
  error: string | null
  commit_hash: string | null
  commit_message: string | null
  triggered_by: string | null
  started_at: string | null
  completed_at: string | null
  created_at: string
}

export async function startIndexing(projectId: string, branch?: string) {
  return apiFetch<{ jobId: string; status: string; branch: string }>(
    `/api/projects/${projectId}/index`,
    { method: 'POST', body: { branch } }
  )
}

export async function getIndexStatus(projectId: string) {
  return apiFetch<IndexStatus>(`/api/projects/${projectId}/index/status`)
}

export async function getIndexHistory(projectId: string, page = 1, limit = 10) {
  return apiFetch<{ jobs: IndexJobSummary[]; total: number; page: number; totalPages: number }>(
    `/api/projects/${projectId}/index/history?page=${page}&limit=${limit}`
  )
}

export async function cancelIndexing(projectId: string) {
  return apiFetch<{ success: boolean; jobId: string }>(
    `/api/projects/${projectId}/index/cancel`,
    { method: 'POST' }
  )
}

// ── Branches ──
export async function listBranches(projectId: string) {
  return apiFetch<{ branches: string[]; error?: string }>(`/api/projects/${projectId}/branches`)
}

export async function testGitConnection(projectId: string) {
  return apiFetch<{ success: boolean; message?: string; error?: string; branchCount?: number; defaultBranch?: string }>(
    `/api/projects/${projectId}/git/test`,
    { method: 'POST' }
  )
}

export async function buildDocsKnowledge(projectId: string) {
  return apiFetch<{ success: boolean; docsFound?: number; docsProcessed?: number; chunksCreated?: number; error?: string; errors?: string[] }>(
    `/api/projects/${projectId}/knowledge/build-from-docs`,
    { method: 'POST', signal: AbortSignal.timeout(120000) }
  )
}

export interface BranchDiff {
  branch: string
  base: string
  diff: { status: string; file: string }[]
  summary: { added: number; modified: number; deleted: number; total: number }
  message?: string
  error?: string
}

export async function getBranchDiff(projectId: string, branch: string, base = 'main') {
  return apiFetch<BranchDiff>(
    `/api/projects/${projectId}/branches/diff?branch=${encodeURIComponent(branch)}&base=${encodeURIComponent(base)}`
  )
}

export interface BranchIndexStatus {
  branch: string
  status: string
  progress: number
  total_files: number
  symbols_found: number
  mem9_status: string | null
  mem9_chunks: number
  docs_knowledge_status: string | null
  docs_knowledge_count: number
  completed_at: string | null
  created_at: string
}

export async function getBranchIndexSummary(projectId: string) {
  return apiFetch<{ branches: BranchIndexStatus[] }>(`/api/projects/${projectId}/index/branches`)
}

// ── Mem9 Pipeline ──
export interface Mem9PipelineStatus {
  jobId?: string
  branch?: string
  gitnexus: { status: string; symbols?: number; files?: number; completedAt?: string }
  mem9: { status: string; chunks?: number }
}

export async function getMemNineStatus(projectId: string) {
  return apiFetch<Mem9PipelineStatus>(`/api/projects/${projectId}/index/mem9/status`)
}

export async function startMemNineEmbedding(projectId: string, branch?: string) {
  const url = branch
    ? `/api/projects/${projectId}/index/mem9?branch=${encodeURIComponent(branch)}`
    : `/api/projects/${projectId}/index/mem9`
  return apiFetch<{ success: boolean; jobId: string; branch: string; status: string }>(
    url,
    { method: 'POST' }
  )
}

// ── System Metrics ──
export interface SystemMetrics {
  timestamp: string
  hostname: string
  platform: string
  arch: string
  uptime: number
  ip: string
  cpu: {
    percent: number
    cores: number
    model: string
    loadAvg: number[]
  }
  memory: {
    total: number
    used: number
    free: number
    percent: number
    totalHuman: string
    usedHuman: string
    freeHuman: string
  }
  disk: Array<{
    filesystem: string
    size: string
    used: string
    available: string
    usedPercent: number
    mountpoint: string
  }>
  containers: Array<{
    name: string
    status: string
    cpu: string
    memory: string
    memoryRaw: number
    memoryLimit: number
    memoryPercent: number
    uptime: string
    image: string
  }>
}

export async function getSystemMetrics() {
  return apiFetch<SystemMetrics>('/api/system/metrics')
}

// ── Knowledge Base ──
export interface KnowledgeDocument {
  id: string
  title: string
  source: string
  source_agent_id: string | null
  project_id: string | null
  tags: string
  status: string
  hit_count: number
  chunk_count: number
  content_preview: string | null
  created_at: string
  updated_at: string
}

export interface KnowledgeStats {
  totalDocs: number
  totalChunks: number
  totalHits: number
}

export async function getKnowledgeDocuments(params?: { tag?: string; projectId?: string }) {
  const qs = new URLSearchParams()
  if (params?.tag) qs.set('tag', params.tag)
  if (params?.projectId) qs.set('projectId', params.projectId)
  const query = qs.toString()
  return apiFetch<{ documents: KnowledgeDocument[]; total: number; stats: KnowledgeStats }>(
    `/api/knowledge${query ? '?' + query : ''}`
  )
}

export async function createKnowledgeDocument(data: {
  title: string
  content: string
  tags?: string[]
  projectId?: string
}) {
  return apiFetch<KnowledgeDocument>('/api/knowledge', { method: 'POST', body: data })
}

export async function getKnowledgeDocument(id: string) {
  return apiFetch<KnowledgeDocument & { chunks: Array<{ id: string; content: string; chunk_index: number; char_count: number }> }>(
    `/api/knowledge/${id}`
  )
}

export async function deleteKnowledgeDocument(id: string) {
  return apiFetch<{ success: boolean }>(`/api/knowledge/${id}`, { method: 'DELETE' })
}

export async function searchKnowledge(query: string, opts?: { tags?: string[]; projectId?: string; limit?: number }) {
  return apiFetch<{ query: string; results: Array<{ score: number; content: unknown; title: unknown; documentId: string; document?: KnowledgeDocument }> }>(
    '/api/knowledge/search',
    { method: 'POST', body: { query, ...opts } }
  )
}

export async function getKnowledgeTags() {
  return apiFetch<{ tags: string[] }>('/api/knowledge/tags')
}

