import { db } from '../db/client.js'
import { isoSeconds, taskLabel, type TaskRow } from './rows.js'

export type NotificationKind = 'review_ready' | 'escalated' | 'capacity' | 'gate_ready' | 'no_worker'

const DEFAULT_LIMIT = 5
const REASON_MAX = 200

/** Leave a notice for the task's owning API key. Tasks without an owner have nobody to tell. */
export function notifyLead(task: TaskRow, kind: NotificationKind, message: string): void {
  if (task.api_key_owner === null) return
  db.prepare('INSERT INTO conductor_notifications (recipient, task_id, kind, message) VALUES (?, ?, ?, ?)')
    .run(task.api_key_owner, task.id, kind, message)
}

/** Oldest undelivered notices first; selecting and marking happen in one transaction. */
export function takeNotifications(recipient: string, limit: number = DEFAULT_LIMIT): string[] {
  const take = db.transaction((): string[] => {
    const rows = db.prepare(
      'SELECT id, message FROM conductor_notifications WHERE recipient = ? AND delivered_at IS NULL ORDER BY id ASC LIMIT ?',
    ).all(recipient, limit) as { id: number; message: string }[]
    const mark = db.prepare('UPDATE conductor_notifications SET delivered_at = ? WHERE id = ?')
    const at = isoSeconds(Date.now())
    for (const r of rows) mark.run(at, r.id)
    return rows.map(r => r.message)
  })
  return take()
}

/**
 * Detail keys per kind: review_ready {prUrl, branch, testOutput}; escalated {count, of: 'failures'|'rejections', reason};
 * capacity {until}; no_worker {routes}; gate_ready none (reads task.approver).
 */
export function formatNotification(
  kind: NotificationKind,
  task: TaskRow,
  detail: Record<string, string | number | null>,
): string {
  const head = `${taskLabel(task)} "${task.title}"`
  switch (kind) {
    case 'review_ready': {
      const where = detail.prUrl || detail.branch
      return `${head} is ready for review — ${where}${detail.testOutput ? ' (tests attached)' : ''}`
    }
    case 'escalated':
      return `${head} needs you: ${detail.count} ${detail.of} — last: ${String(detail.reason ?? '').slice(0, REASON_MAX)}. Clear with cortex_task_route clearEscalation.`
    case 'capacity':
      return `${head} is waiting for capacity: every route is out of quota until ${detail.until}.`
    case 'no_worker':
      return `${head} has no connected worker that can run it (${detail.routes}).`
    case 'gate_ready':
      return task.approver === 'user'
        ? `${head} is waiting for approval by the user in the dashboard.`
        : `${head} is waiting for your approval (cortex_task_review).`
  }
}
