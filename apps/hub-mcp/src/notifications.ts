import type { Env } from './types.js'

/**
 * Conductor notification fetcher and formatter.
 *
 * Used in two places:
 *   1. Injected automatically into every MCP tool response (index.ts response wrapper)
 *   2. Called explicitly by cortex_task_notifications tool
 */

interface ConductorTask {
  id: string
  title: string
  description: string | null
  assigned_to: string
  created_by: string
  status: string
  priority: string
  notify_on_complete: string
  notified_agents: string
  result: string | null
  completed_by: string | null
  created_at: string
  completed_at: string | null
}

interface NotificationResponse {
  assignedTasks: ConductorTask[]
  completedTasks: ConductorTask[]
}

/**
 * Fetch pending notifications for an agent from the Dashboard API.
 * Returns a formatted CONDUCTOR block string, or null if there are none.
 */
export async function fetchNotifications(env: Env, agentId: string): Promise<string | null> {
  try {
    const response = await fetch(
      `${env.DASHBOARD_API_URL}/api/tasks/notifications/${encodeURIComponent(agentId)}`,
      { signal: AbortSignal.timeout(5000) }
    )

    if (!response.ok) return null

    const data = await response.json() as NotificationResponse
    const block = formatConductorBlock(data.assignedTasks, data.completedTasks)

    // Acknowledge completed task notifications so they aren't shown again
    if (data.completedTasks.length > 0) {
      acknowledgeNotifications(env, agentId, data.completedTasks.map(t => t.id))
    }

    return block
  } catch {
    // Notification fetch failures are non-fatal — never break tool responses
    return null
  }
}

/**
 * Format assigned and completed tasks into a CONDUCTOR notification block.
 * Returns null if there are no notifications.
 */
export function formatConductorBlock(
  assignedTasks: ConductorTask[],
  completedTasks: ConductorTask[]
): string | null {
  const total = assignedTasks.length + completedTasks.length
  if (total === 0) return null

  const lines: string[] = [
    '',
    '---',
    `CONDUCTOR: You have ${total} pending notification(s):`,
    '',
  ]

  for (const task of assignedTasks) {
    lines.push(`NEW TASK ASSIGNED [${task.id}] Priority: ${task.priority.toUpperCase()}`)
    lines.push(`   Title: ${task.title}`)
    lines.push(`   From: ${task.created_by}`)
    if (task.description) {
      lines.push(`   Details: ${task.description}`)
    }
    lines.push(`   Call cortex_task_accept(taskId: "${task.id}") to begin.`)
    lines.push('')
  }

  for (const task of completedTasks) {
    lines.push(`TASK COMPLETED [${task.id}]`)
    lines.push(`   Title: ${task.title}`)
    lines.push(`   By: ${task.completed_by ?? task.assigned_to}`)
    if (task.result) {
      lines.push(`   Result: ${task.result}`)
    }
    lines.push('   Your dependent tasks may now proceed.')
    lines.push('')
  }

  lines.push('---')
  return lines.join('\n')
}

/**
 * Fire-and-forget acknowledgement of completed task notifications.
 * This prevents the same completion notification from being shown repeatedly.
 */
function acknowledgeNotifications(env: Env, agentId: string, taskIds: string[]): void {
  // Intentionally not awaited — non-blocking background ack
  fetch(`${env.DASHBOARD_API_URL}/api/tasks/notifications/${encodeURIComponent(agentId)}/ack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskIds }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {
    // Swallow errors — ack failures are non-fatal
  })
}
