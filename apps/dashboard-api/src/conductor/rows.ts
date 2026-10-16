import { db } from '../db/client.js'
import type { TaskReview, TaskHandoff, TaskResult } from '@cortex/shared-types'

export interface TaskRow {
  id: string
  title: string
  description: string
  project_id: string | null
  parent_task_id: string | null
  created_by_agent: string | null
  assigned_to_agent: string | null
  assigned_session_id: string | null
  status: string
  priority: number
  required_capabilities: string
  depends_on: string
  notify_on_complete: string
  notified_agents: string
  context: string
  result: string | null
  completed_by: string | null
  created_at: string
  assigned_at: string | null
  accepted_at: string | null
  completed_at: string | null
  api_key_owner: string | null
  task_key: string | null
  kind: string
  approver: string | null
  executor: string | null
  model: string | null
  effort: string | null
  fallback: string | null
  files: string
  branch: string | null
  pinned_agent: string | null
  review_required: number
  attempt: number
  fail_count: number
  reject_count: number
  current_route: string | null
  lease_expires_at: string | null
  wait_reason: string | null
  wait_until: string | null
  escalated_at: string | null
  last_agent: string | null
}

export interface TaskContext {
  reviews?: TaskReview[]
  handoff?: TaskHandoff
  declined?: string[]
  testCommand?: string
  estimate?: number
  allowEmpty?: boolean
  pull?: boolean
  [k: string]: unknown
}

export const ACTIVE_STATUSES = ['assigned', 'accepted', 'in_progress'] as const
export const LOCKING_STATUSES = [...ACTIVE_STATUSES, 'review'] as const

export function getTask(id: string): TaskRow | undefined {
  return db.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(id) as TaskRow | undefined
}

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback
  try { return JSON.parse(raw) as T } catch { return fallback }
}

/** A JSON array column's string entries; anything else reads as empty. */
export function stringList(raw: string | null | undefined): string[] {
  const parsed = parseJson<unknown>(raw, [])
  return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
}

export function taskContext(row: TaskRow): TaskContext {
  const parsed = parseJson<unknown>(row.context, {})
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as TaskContext) : {}
}

/** `YYYY-MM-DDTHH:MM:SSZ`, the shape SQLite's strftime writes (no milliseconds). */
export function isoSeconds(ms: number = Date.now()): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function logTask(taskId: string, agentId: string | null, action: string, message?: string): void {
  db.prepare('INSERT INTO conductor_task_logs (task_id, agent_id, action, message) VALUES (?, ?, ?, ?)')
    .run(taskId, agentId, action, message ?? null)
}

export function taskLabel(row: TaskRow): string {
  return row.task_key ?? row.id
}

/** TaskResult fields read as text downstream; a non-string value is dropped. */
const RESULT_TEXT_FIELDS = ['prUrl', 'branch', 'commit', 'testOutput', 'error'] as const

/**
 * A REST `result` as a TaskResult: an object keeps its fields (non-string text
 * fields dropped) and gets `summary: ''` when it has none; anything else
 * becomes the summary.
 */
export function toTaskResult(result: unknown): TaskResult {
  if (result === undefined || result === null) return { summary: '' }
  if (typeof result !== 'object') return { summary: String(result) }
  if (Array.isArray(result)) return { summary: JSON.stringify(result) }
  const fields: Record<string, unknown> = { ...result }
  for (const f of RESULT_TEXT_FIELDS) {
    if (fields[f] !== undefined && typeof fields[f] !== 'string') delete fields[f]
  }
  const s = fields.summary
  fields.summary = typeof s === 'string' ? s : s === undefined || s === null ? '' : JSON.stringify(s)
  // summary is a string and every text field a string or absent, as TaskResult requires
  return fields as unknown as TaskResult
}
