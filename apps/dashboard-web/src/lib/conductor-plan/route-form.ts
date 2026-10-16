// Route form: the reroute form's fields, its diff against a baseline, and the option lists.
// Pure module — no React, no DOM.
import type { ConductorWorker, Executor, RouteBody } from '../api'
import type { PlanTask } from './model'

export interface RouteForm { executor: Executor | ''; model: string; effort: string; pinnedAgent: string }

export function routeFormFrom(task: PlanTask): RouteForm {
  return {
    executor: task.primary?.executor ?? '',
    model: task.primary?.model ?? '',
    effort: task.primary?.effort ?? '',
    pinnedAgent: task.row.pinned_agent ?? '',
  }
}

/** Request body holding only the fields that differ from `from` (the form as it was when it opened). */
export function routeBodyFromForm(form: RouteForm, from: RouteForm): RouteBody {
  const body: RouteBody = {}
  if (form.executor !== from.executor) body.executor = form.executor === '' ? null : form.executor
  if (form.model.trim() !== from.model) body.model = form.model.trim() || null
  if (form.effort.trim() !== from.effort) body.effort = form.effort.trim() || null
  if (form.pinnedAgent.trim() !== from.pinnedAgent) body.pinnedAgent = form.pinnedAgent.trim() || null
  return body
}

/** Models the online workers offer for an executor (the '*' wildcard is not a model name). */
export function modelOptions(workers: ConductorWorker[], executor: Executor | ''): string[] {
  return Array.from(new Set(
    workers.flatMap((w) => w.engines.filter((e) => e.executor === executor).flatMap((e) => e.models)),
  )).filter((m) => m !== '*')
}

/** "any" is added by the caller; an offline pinned agent stays listed so the pin is visible. */
export function pinOptions(workers: ConductorWorker[], pinned: string): { value: string; label: string }[] {
  const out = workers.map((w) => ({ value: w.agentId, label: w.agentId }))
  if (pinned !== '' && !out.some((o) => o.value === pinned)) out.push({ value: pinned, label: `${pinned} (offline)` })
  return out
}
