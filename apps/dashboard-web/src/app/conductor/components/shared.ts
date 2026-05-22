import type { ConductorTask, ConductorTaskLog } from '@/lib/api'
import {
  ClipboardList, Target, GitBranch, Hand, Zap, CheckCircle,
  Search, Unlock, ArrowUpFromLine, XCircle, AlertTriangle, CircleDot,
  type LucideIcon,
} from '@/lib/icons'

// ── Types ──
export type StatusFilter = 'all' | 'pending' | 'assigned' | 'accepted' | 'in_progress' | 'review' | 'completed' | 'failed' | 'cancelled'
export interface TaskTreeNode {
  task: ConductorTask
  children: TaskTreeNode[]
  depth: number
}

/** Strategy proposed by lead agent after task analysis */
export interface TaskStrategy {
  summary: string
  roles: StrategyRole[]
  subtasks: StrategySubtask[]
  estimatedEffort?: string
}

export interface StrategyRole {
  role: string
  label: string
  agent: string
  rationale: string
  capabilities?: string[]
}

export interface StrategySubtask {
  title: string
  description?: string
  role: string
  dependsOn?: string[]
  priority?: number
}

/** Structured finding from agent research/analysis */
export interface StructuredFinding {
  id: string
  title: string
  description: string
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  category: string
  evidence: string[]
  proposal: string
  effort: 'trivial' | 'small' | 'medium' | 'large'
}

/** Structured task result with findings */
export interface StructuredTaskResult {
  summary: string
  findings: StructuredFinding[]
}

/** Task briefing acceptance criteria item */
export interface AcceptanceCriterion {
  id: string
  text: string
  completed: boolean
}

/** Image attachment */
export interface ImageAttachment {
  data: string
  name: string
}

import { parseDateSafe, formatTimeAgo as baseFormatTimeAgo } from '@/lib/date'

// ── Helpers ──
export function formatTimeAgo(dateStr: string): string {
  return baseFormatTimeAgo(dateStr)
}

export function formatJson(value: string | null): string {
  if (!value) return ''
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

/** Parse result JSON into a structured display */
export type ParsedResult =
  | { type: 'empty' }
  | { type: 'string'; text: string }
  | { type: 'subtasks'; items: { title?: string; status?: string; message?: string; agent?: string; [k: string]: unknown }[] }
  | { type: 'object'; summary: { key: string; value: string }[]; raw: string }

export function parseResult(value: string | null): ParsedResult {
  if (!value) return { type: 'empty' }
  try {
    const parsed = JSON.parse(value)
    if (typeof parsed === 'string') return { type: 'string', text: parsed }
    if (Array.isArray(parsed)) {
      return { type: 'subtasks', items: parsed }
    }
    if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed.subtaskResults)) {
        return { type: 'subtasks', items: parsed.subtaskResults }
      }
      const summary: { key: string; value: string }[] = []
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          summary.push({ key: k, value: String(v) })
        } else if (v === null) {
          summary.push({ key: k, value: '—' })
        }
      }
      return { type: 'object', summary, raw: JSON.stringify(parsed, null, 2) }
    }
    return { type: 'string', text: String(parsed) }
  } catch {
    return { type: 'string', text: value }
  }
}

/** Get a short one-liner summary from task result JSON */
export function getResultSummary(result: string | null, maxLen = 120): string {
  if (!result) return ''
  try {
    const parsed = JSON.parse(result)
    if (typeof parsed === 'string') return parsed.slice(0, maxLen)

    // Structured findings result
    if (Array.isArray(parsed.findings)) {
      const count = parsed.findings.length
      const critical = parsed.findings.filter((f: { severity?: string }) => f.severity === 'critical').length
      const high = parsed.findings.filter((f: { severity?: string }) => f.severity === 'high').length
      const severityInfo = [critical > 0 && `${critical} critical`, high > 0 && `${high} high`].filter(Boolean).join(', ')
      const prefix = severityInfo ? `${count} findings (${severityInfo})` : `${count} findings`
      return parsed.summary ? `${prefix}: ${String(parsed.summary).slice(0, maxLen - prefix.length - 2)}` : prefix
    }

    // Auto-completed parent: "All N subtasks completed"
    if (parsed.autoCompleted && Array.isArray(parsed.subtaskResults)) {
      const count = parsed.subtaskResults.length
      const titles = parsed.subtaskResults
        .slice(0, 3)
        .map((s: { title?: string }) => s.title ?? 'untitled')
        .join(', ')
      const suffix = count > 3 ? ` +${count - 3} more` : ''
      return `✓ ${count} subtasks: ${titles}${suffix}`
    }

    // Array of subtask results
    if (Array.isArray(parsed)) {
      return `${parsed.length} results returned`
    }

    // Object with a message/summary key
    if (parsed.message) return String(parsed.message).slice(0, maxLen)
    if (parsed.summary) return String(parsed.summary).slice(0, maxLen)

    // Generic object: show top-level keys
    const keys = Object.keys(parsed).filter(k => k !== 'subtaskResults')
    if (keys.length > 0) {
      const preview = keys.slice(0, 4).map(k => {
        const v = parsed[k]
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return `${k}: ${v}`
        return k
      }).join(', ')
      return preview.slice(0, maxLen)
    }

    return ''
  } catch {
    return result.slice(0, maxLen)
  }
}

/** Get human-readable duration between task timestamps */
export function getTaskDuration(task: { created_at: string; accepted_at?: string | null; completed_at?: string | null }): string {
  const start = task.accepted_at ?? task.created_at
  const end = task.completed_at
  if (!end) return ''
  const diffMs = parseDateSafe(end).getTime() - parseDateSafe(start).getTime()
  if (diffMs < 0) return ''
  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainMins = minutes % 60
  return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`
}

/** Map log action types to human-readable labels */
export function getLogActionLabel(action: string): { label: string; icon: LucideIcon; color: string } {
  switch (action) {
    case 'created': return { label: 'Created', icon: ClipboardList, color: 'var(--text-secondary)' }
    case 'auto_assigned': return { label: 'Auto-assigned', icon: Target, color: 'var(--status-info)' }
    case 'delegated': return { label: 'Delegated', icon: GitBranch, color: 'var(--status-info)' }
    case 'picked_up': return { label: 'Picked up', icon: Hand, color: 'var(--status-info)' }
    case 'progress': return { label: 'Progress', icon: Zap, color: 'var(--text-tertiary)' }
    case 'completed': return { label: 'Completed', icon: CheckCircle, color: 'var(--status-success)' }
    case 'auto_completed': return { label: 'Auto-completed', icon: CheckCircle, color: 'var(--status-success)' }
    case 'auto_review': return { label: 'Review created', icon: Search, color: 'var(--status-warning)' }
    case 'unblocked': return { label: 'Unblocked', icon: Unlock, color: 'var(--status-info)' }
    case 'submitted_for_review': return { label: 'Submitted for review', icon: ArrowUpFromLine, color: 'var(--status-warning)' }
    case 'rejected': return { label: 'Rejected', icon: XCircle, color: 'var(--status-error)' }
    case 'subtask_failed': return { label: 'Subtask failed', icon: AlertTriangle, color: 'var(--status-error)' }
    default: return { label: action.replace(/_/g, ' '), icon: CircleDot, color: 'var(--text-tertiary)' }
  }
}

/** Build a tree from flat task list using parent_task_id */
export function buildTaskTree(tasks: ConductorTask[]): TaskTreeNode[] {
  const taskMap = new Map<string, TaskTreeNode>()
  const roots: TaskTreeNode[] = []

  for (const task of tasks) {
    taskMap.set(task.id, { task, children: [], depth: 0 })
  }

  for (const task of tasks) {
    const node = taskMap.get(task.id)!
    if (task.parent_task_id && taskMap.has(task.parent_task_id)) {
      const parent = taskMap.get(task.parent_task_id)!
      node.depth = parent.depth + 1
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }

  function sortChildren(nodes: TaskTreeNode[]) {
    nodes.sort((a, b) => a.task.priority - b.task.priority || a.task.created_at.localeCompare(b.task.created_at))
    for (const node of nodes) sortChildren(node.children)
  }
  sortChildren(roots)
  // Root pipelines: newest first
  roots.sort((a, b) => b.task.created_at.localeCompare(a.task.created_at))
  return roots
}

/** Flatten tree into ordered list with depth info for rendering */
export function flattenTree(nodes: TaskTreeNode[]): TaskTreeNode[] {
  const result: TaskTreeNode[] = []
  function walk(list: TaskTreeNode[]) {
    for (const node of list) {
      result.push(node)
      walk(node.children)
    }
  }
  walk(nodes)
  return result
}

/** Get status icon symbol */
export function getStatusIcon(status: string): string {
  switch (status) {
    case 'completed': return '✓'
    case 'in_progress': return '●'
    case 'review': return '◎'
    case 'failed': return '✗'
    case 'pending': return '○'
    case 'assigned': return '◐'
    case 'accepted': return '◑'
    case 'analyzing': return '◉'
    case 'approved': return '✓'
    default: return '○'
  }
}

/** Get IDE display info */
export function getIdeInfo(ide?: string): { icon: string; label: string; colorClass: string } {
  switch (ide) {
    case 'claude-code': return { icon: 'C', label: 'Claude Code', colorClass: 'ideBlue' }
    case 'codex': return { icon: 'X', label: 'OpenAI Codex', colorClass: 'ideGreen' }
    case 'antigravity': return { icon: 'G', label: 'Antigravity (Gemini)', colorClass: 'idePurple' }
    case 'cursor': return { icon: 'Cu', label: 'Cursor', colorClass: 'ideOrange' }
    default: return { icon: 'A', label: ide ?? 'Unknown', colorClass: '' }
  }
}

/** Get capability badge color class name */
export function getCapColor(cap: string): string {
  if (['backend', 'frontend', 'database', 'server'].includes(cap)) return 'capCode'
  if (['review', 'testing'].includes(cap)) return 'capReview'
  if (['devops', 'docker', 'deploy'].includes(cap)) return 'capDeploy'
  if (['design'].includes(cap)) return 'capDesign'
  if (['security'].includes(cap)) return 'capSecurity'
  return ''
}

/** Get all unique participating agents in a pipeline tree */
export function getParticipatingAgents(node: TaskTreeNode): { agentId: string; role: 'creator' | 'assignee' | 'completer' }[] {
  const seen = new Map<string, 'creator' | 'assignee' | 'completer'>()
  function walk(n: TaskTreeNode) {
    if (n.task.created_by_agent && !seen.has(n.task.created_by_agent)) {
      seen.set(n.task.created_by_agent, 'creator')
    }
    if (n.task.assigned_to_agent) {
      seen.set(n.task.assigned_to_agent, 'assignee')
    }
    if (n.task.completed_by) {
      seen.set(n.task.completed_by, 'completer')
    }
    for (const child of n.children) walk(child)
  }
  walk(node)
  return Array.from(seen.entries()).map(([agentId, role]) => ({ agentId, role }))
}

/** Find the currently active (in_progress) subtask with its agent */
export function getActiveSubtask(node: TaskTreeNode): { title: string; agent: string | null } | null {
  function walk(n: TaskTreeNode): { title: string; agent: string | null } | null {
    if (n.task.status === 'in_progress' || n.task.status === 'analyzing' || n.task.status === 'accepted') {
      return { title: n.task.title, agent: n.task.assigned_to_agent ?? null }
    }
    for (const child of n.children) {
      const found = walk(child)
      if (found) return found
    }
    return null
  }
  // Check children first, then root
  for (const child of node.children) {
    const found = walk(child)
    if (found) return found
  }
  if (node.task.status === 'in_progress' || node.task.status === 'analyzing' || node.task.status === 'accepted') {
    return { title: node.task.title, agent: node.task.assigned_to_agent ?? null }
  }
  return null
}

/** Calculate pipeline completion progress */
export function getPipelineProgress(node: TaskTreeNode): { completed: number; total: number; percent: number; failed: number } {
  let completed = 0
  let total = 0
  let failed = 0
  function walk(n: TaskTreeNode) {
    // Only count non-root tasks as subtasks
    if (n.depth > 0) {
      total++
      if (n.task.status === 'completed') completed++
      if (n.task.status === 'failed') failed++
    }
    for (const child of n.children) walk(child)
  }
  walk(node)
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0
  return { completed, total, percent, failed }
}

// Re-export for convenient imports
export type { ConductorTask, ConductorTaskLog }
