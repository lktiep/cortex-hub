// Plan task actions: which actions a task offers, the reroute form <-> request body mapping,
// and error text. Pure module — no React, no DOM.
import type { Executor, RouteBody } from '../api'
import type { PlanTask } from './model'

export interface RouteForm { executor: Executor | ''; model: string; effort: string; pinnedAgent: string }

export function availableActions(task: PlanTask): { review: boolean; clearEscalation: boolean; route: boolean } {
  return {
    review: task.state === 'review' || task.state === 'needs_user',
    clearEscalation: task.state === 'escalated',
    route: task.kind === 'work' && task.state !== 'done' && task.state !== 'stopped',
  }
}

export function routeFormFrom(task: PlanTask): RouteForm {
  return {
    executor: task.primary?.executor ?? '',
    model: task.primary?.model ?? '',
    effort: task.primary?.effort ?? '',
    pinnedAgent: task.row.pinned_agent ?? '',
  }
}

export function routeBodyFromForm(form: RouteForm, task: PlanTask): RouteBody {
  const from = routeFormFrom(task)
  const body: RouteBody = {}
  if (form.executor !== from.executor) body.executor = form.executor === '' ? null : form.executor
  if (form.model.trim() !== from.model) body.model = form.model.trim() || null
  if (form.effort.trim() !== from.effort) body.effort = form.effort.trim() || null
  if (form.pinnedAgent.trim() !== from.pinnedAgent) body.pinnedAgent = form.pinnedAgent.trim() || null
  return body
}

// ApiError is not exported from api.ts, so its shape is duck-typed.
export function actionErrorMessage(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const e = err as { status?: unknown; message?: unknown; data?: unknown }
    if (e.status === 409) return 'This task changed state on the hub — the view has been refreshed.'
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
