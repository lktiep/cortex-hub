// Plan task actions: which actions a task offers, and error text. Pure module — no React, no DOM.
import type { PlanTask } from './model'

export function availableActions(task: PlanTask): { review: boolean; clearEscalation: boolean; route: boolean } {
  return {
    review: task.state === 'review' || task.state === 'needs_user',
    clearEscalation: task.state === 'escalated',
    route: task.kind === 'work' && task.state !== 'done' && task.state !== 'stopped',
  }
}

// ApiError is not exported from api.ts, so its shape is duck-typed.
export function actionErrorMessage(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const e = err as { status?: unknown; message?: unknown; data?: unknown }
    if (e.status === 409) {
      // api.ts synthesises "API error: <status>" when the hub sent no text; that is not a reason.
      const hub = typeof e.message === 'string' && e.message !== '' && !/^API error: \d+$/.test(e.message) ? e.message : null
      return hub ? `${hub} — the view has been refreshed.` : 'This task changed state on the hub — the view has been refreshed.'
    }
    if (e.status === 400 && typeof e.data === 'object' && e.data !== null) {
      const cycle = (e.data as { cycle?: unknown }).cycle
      if (Array.isArray(cycle) && cycle.length > 0) {
        return `That change would create a cycle: ${cycle.map(String).join(' → ')}`
      }
    }
    if (typeof e.message === 'string' && e.message) return e.message
  }
  return 'Request failed'
}
