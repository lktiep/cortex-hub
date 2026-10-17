// Plan summaries: progress counts, Needs you, Awaiting lead, fallback tally and worker rows.
// Pure folds over PlanTask[] — no React, no DOM; anything time-dependent takes `now`.
import type { ConductorSession, ConductorWorker } from '../api'
import { compareText, nodeNote, routeLabel } from './model'
import type { PlanTask } from './model'
import { artifactLine } from './outcome'

export type ProgressBucket = 'done' | 'review' | 'running' | 'ready' | 'waiting' | 'blocked'

export type ProgressCounts = Record<ProgressBucket, number> & { total: number; stopped: number }

export interface NeedItem {
  kind: 'escalated' | 'user_gate' | 'no_worker' | 'blocked_by_stopped' | 'review' | 'lead_gate'
  taskId: string
  key: string
  title: string
  detail: string
  tone: 'red' | 'amber' | 'violet'
}

export interface WorkerRow {
  agentId: string
  hostname: string
  os: string | null
  status: 'idle' | 'busy'
  currentTask: { id: string; key: string; title: string | null } | null
  engines: string
  quota: { label: string; until: string }[]
}

const byKey = (a: { key: string }, b: { key: string }) => compareText(a.key, b.key)

export function progressCounts(tasks: PlanTask[]): ProgressCounts {
  const out: ProgressCounts = { done: 0, review: 0, running: 0, ready: 0, waiting: 0, blocked: 0, total: 0, stopped: 0 }
  for (const t of tasks) {
    if (t.kind !== 'work') continue
    switch (t.state) {
      case 'done': case 'review': case 'running': case 'ready': case 'waiting':
        out[t.state]++
        out.total++
        break
      case 'blocked': case 'escalated':
        out.blocked++
        out.total++
        break
      case 'stopped':
        out.stopped++
        break
      default: // needs_user / gate_lead belong to gates, which are not counted
        break
    }
  }
  return out
}

function item(t: PlanTask, kind: NeedItem['kind'], tone: NeedItem['tone'], detail: string): NeedItem {
  return { kind, taskId: t.id, key: t.key, title: t.title, detail, tone }
}

/** What there is to approve first ("PR #12 · tests passed"), then `detail`. */
function withArtifacts(t: PlanTask, byId: Map<string, PlanTask>, detail: string): string {
  const artifacts = artifactLine(t, byId)
  return artifacts ? `${artifacts} · ${detail}` : detail
}

export function needsYou(tasks: PlanTask[], now: Date): NeedItem[] {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const out: NeedItem[] = []
  for (const t of tasks) {
    if (t.state === 'escalated') {
      out.push(item(t, 'escalated', 'red', nodeNote(t, now) as string)) // an escalated task always has a note
    } else if (t.state === 'needs_user') {
      out.push(item(t, 'user_gate', 'amber', withArtifacts(t, byId, nodeNote(t, now) ?? 'awaiting your approval')))
    } else if (t.state === 'waiting' && t.waitReason === 'no_worker') {
      out.push(item(t, 'no_worker', 'amber', nodeNote(t, now) as string)) // a no_worker wait always has a note
    } else if (t.state === 'blocked') {
      const stopped = t.deps
        .map((id) => byId.get(id))
        .filter((d): d is PlanTask => d !== undefined && d.state === 'stopped')
        .sort(byKey)[0]
      if (stopped) out.push(item(t, 'blocked_by_stopped', 'red', `depends on ${stopped.status} ${stopped.key}`))
    }
  }
  const rank = (n: NeedItem) => (n.tone === 'red' ? 0 : 1)
  return out.sort((a, b) => rank(a) - rank(b) || byKey(a, b))
}

export function awaitingLead(tasks: PlanTask[]): NeedItem[] {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const out: NeedItem[] = []
  for (const t of tasks) {
    if (t.state !== 'review' && t.state !== 'gate_lead') continue
    const last = t.reviews[t.reviews.length - 1]
    const fallback = t.state === 'review' ? 'awaiting review' : 'awaiting lead approval'
    const detail = withArtifacts(t, byId, last ? last.feedback : fallback)
    out.push(item(t, t.state === 'review' ? 'review' : 'lead_gate', 'violet', detail))
  }
  return out.sort(byKey)
}

export function routeTally(tasks: PlanTask[]): { label: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const t of tasks) {
    if (t.kind !== 'work' || t.state !== 'done') continue
    const label = routeLabel(t.route) ?? 'unrouted'
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || compareText(a.label, b.label))
}

export function workerRows(workers: ConductorWorker[], tasks: PlanTask[], now: Date): WorkerRow[] {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const nowMs = now.getTime()
  return workers
    .map((w): WorkerRow => {
      const cur = w.currentTaskId === null ? null : byId.get(w.currentTaskId)
      return {
        agentId: w.agentId,
        hostname: w.hostname ?? w.agentId,
        os: w.os,
        status: w.status,
        currentTask: w.currentTaskId === null
          ? null
          : cur
            ? { id: cur.id, key: cur.key, title: cur.title }
            : { id: w.currentTaskId, key: w.currentTaskId, title: null },
        engines: w.engines.map((e) => e.executor).join(', '),
        quota: w.quota
          .filter((q) => Date.parse(q.exhaustedUntil) > nowMs)
          .map((q) => ({ label: routeLabel({ executor: q.executor, model: q.model, effort: null }) ?? q.executor, until: q.exhaustedUntil })),
      }
    })
    .sort((a, b) => compareText(a.hostname, b.hostname) || compareText(a.agentId, b.agentId))
}

/** Whole-number percent of work tasks done. */
export function progressPercent(counts: ProgressCounts): number {
  return counts.total === 0 ? 0 : Math.round((counts.done / counts.total) * 100)
}

/** Days to one decimal place, without a trailing .0. */
export function formatDays(days: number): string {
  return String(Math.round(days * 10) / 10)
}

/** Progress buckets in bar order. */
export const PROGRESS_BUCKETS: ProgressBucket[] = ['done', 'review', 'running', 'ready', 'waiting', 'blocked']

/** One tab per group, in key order: its work-task count and the sum of their estimates (days). */
export function groupTabs(tasks: PlanTask[]): { id: string; label: string; count: number; days: number }[] {
  return tasks
    .filter((t) => t.kind === 'group')
    .sort(byKey)
    .map((g) => {
      const work = tasks.filter((t) => t.kind === 'work' && t.groupId === g.id)
      return { id: g.id, label: g.row.task_key ?? g.title, count: work.length, days: work.reduce((a, t) => a + t.estimate, 0) }
    })
}

/** Workers plus the MCP sessions whose agent is not already a worker; `total` counts unique agent ids. */
export function agentsOnline(
  workers: ConductorWorker[],
  sessions?: ConductorSession[],
): { workers: ConductorWorker[]; sessions: ConductorSession[]; total: number } {
  const workerIds = new Set(workers.map((w) => w.agentId))
  const extra = (sessions ?? []).filter((s) => !workerIds.has(s.agentId))
  const ids = new Set([...workerIds, ...extra.map((s) => s.agentId)])
  return { workers, sessions: extra, total: ids.size }
}
