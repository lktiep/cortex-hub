// Which tasks the Conductor page shows under a status filter. A filter picks pipelines, not rows:
// filtering rows first would cut a subtask from its parent, and it would then show as a pipeline
// of its own.

import type { ConductorTask } from '../api'

/** Every task of each tree that has at least one task matching `matches`, trees kept whole. */
export function pipelineTasks(tasks: ConductorTask[], matches: (task: ConductorTask) => boolean): ConductorTask[] {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const rootOf = (task: ConductorTask): string => {
    let current = task
    const seen = new Set<string>()
    while (current.parent_task_id && byId.has(current.parent_task_id) && !seen.has(current.id)) {
      seen.add(current.id)
      current = byId.get(current.parent_task_id)!
    }
    return current.id
  }
  const roots = new Set(tasks.filter(matches).map(rootOf))
  return tasks.filter((t) => roots.has(rootOf(t)))
}
