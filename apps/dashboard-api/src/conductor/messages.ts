// Hub → worker assignment messages (spec §6.5) and the branch name a task is
// given at its first dispatch (spec §6.1, `conductor.branchTemplate`).
import type { AssignedTask, Executor, RouteSpec, TaskAssignedMsg, TaskHandoff, TaskReview } from '@cortex/shared-types'
import { parseJson, stringList, taskContext, type TaskRow } from './rows.js'

const SLUG_MAX = 40
const ID_KEY_LENGTH = 8

/** Lowercase ASCII (accents dropped), runs of other characters → '-', trimmed, at most 40 characters. */
export function slugify(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '')
}

/**
 * `task_key` reduced to `[A-Za-z0-9._-]` and made safe as a git ref component:
 * no `..`, no trailing `.lock` or `.`, no leading `.` or `-`. Else the id
 * without its `task_` prefix, first 8 characters.
 */
function branchKey(task: TaskRow): string {
  const key = (task.task_key ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/(?:\.lock|[.-])+$/, '')
    .replace(/^[.-]+/, '')
  return key !== '' ? key : task.id.replace(/^task_/, '').slice(0, ID_KEY_LENGTH)
}

/** Fills `{key}` and `{slug}` in the branch template. */
export function branchFor(task: TaskRow, template: string): string {
  const key = branchKey(task)
  const slug = slugify(task.title)
  return template.replace(/\{key\}/g, () => key).replace(/\{slug\}/g, () => slug)
}

/** The route of the current dispatch, else the task's primary route. */
function routeOf(task: TaskRow): RouteSpec {
  const stored = parseJson<Partial<RouteSpec> | null>(task.current_route, null)
  if (stored !== null && typeof stored === 'object' && !Array.isArray(stored)) {
    return { executor: stored.executor ?? null, model: stored.model ?? null, effort: stored.effort ?? null }
  }
  // The column only ever holds values validated on write; an unknown one matches no engine.
  return { executor: task.executor as Executor | null, model: task.model, effort: task.effort }
}

export function toAssignedTask(task: TaskRow, baseBranch: string): AssignedTask {
  const context = taskContext(task)
  const handoff = context.handoff
  return {
    id: task.id,
    key: task.task_key,
    title: task.title,
    description: task.description,
    context,
    files: stringList(task.files),
    branch: task.branch ?? '',
    baseBranch,
    route: routeOf(task),
    attempt: task.attempt,
    leaseExpiresAt: task.lease_expires_at ?? '',
    reviews: Array.isArray(context.reviews) ? (context.reviews as TaskReview[]) : [],
    handoff: handoff !== null && typeof handoff === 'object' ? (handoff as TaskHandoff) : null,
    testCommand: typeof context.testCommand === 'string' ? context.testCommand : null,
  }
}

export function assignedMsg(task: TaskRow, baseBranch: string, type: 'task.assigned' | 'task.resumed'): TaskAssignedMsg {
  return {
    type,
    task: toAssignedTask(task, baseBranch),
    taskId: task.id,
    title: task.title,
    description: task.description,
  }
}
