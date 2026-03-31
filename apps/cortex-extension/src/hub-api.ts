import type { CortexConfig } from './config.js'

/** Fetch JSON from Hub API with auth */
async function hubFetch<T>(config: CortexConfig, path: string): Promise<T | null> {
  const baseUrl = config.hubUrl
    .replace('wss://', 'https://')
    .replace('ws://', 'http://')
    .replace('/ws/conductor', '')

  try {
    // Use global fetch (Node 18+)
    const res = await fetch(`${baseUrl}${path}`, {
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    return await res.json() as T
  } catch {
    return null
  }
}

export interface HubOverview {
  activeKeys: number
  totalAgents: number
  memoryNodes: number
  totalQueries: number
  totalSessions: number
  organizations: number
  today: { queries: number; tokens: number }
  quality: { lastGrade: string; lastScore: number; reportsToday: number; averageScore: number }
  knowledge: { totalDocs: number; totalChunks: number; totalHits: number }
  tokenSavings: { totalTokensSaved: number; totalToolCalls: number }
}

export interface TaskSummary {
  id: string
  title: string
  status: string
  priority: number
  assigned_to_agent: string | null
  created_by_agent: string | null
  completed_by: string | null
  parent_task_id: string | null
  created_at: string
  completed_at: string | null
}

export interface SessionInfo {
  id: string
  from_agent: string
  project: string
  task_summary: string
  status: string
  created_at: string
}

/** Fetch dashboard overview stats */
export async function fetchOverview(config: CortexConfig): Promise<HubOverview | null> {
  return hubFetch<HubOverview>(config, '/api/metrics/overview-v2')
}

/** Fetch recent conductor tasks */
export async function fetchTasks(config: CortexConfig, limit = 20): Promise<TaskSummary[]> {
  const data = await hubFetch<{ tasks: TaskSummary[] }>(config, `/api/conductor?limit=${limit}`)
  return data?.tasks ?? []
}

/** Fetch recent sessions */
export async function fetchSessions(config: CortexConfig, limit = 10): Promise<SessionInfo[]> {
  const data = await hubFetch<{ sessions: SessionInfo[] }>(config, `/api/sessions/all?limit=${limit}`)
  return data?.sessions ?? []
}

/** Fetch all data for webview */
export async function fetchAllForWebview(config: CortexConfig) {
  const [overview, tasks, sessions] = await Promise.all([
    fetchOverview(config),
    fetchTasks(config),
    fetchSessions(config),
  ])
  return { overview, tasks, sessions }
}
