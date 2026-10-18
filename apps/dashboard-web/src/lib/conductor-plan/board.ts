// Plan board: machine lanes holding one chip per task, the way the plan crosses machines.
// Pure module — no React, no DOM; the board only renders what this returns.
import type { ConductorWorker } from '../api'
import { assignLanes, computeDepths, type PhaseSelection } from './layout'
import { compareText, nodeNote, routeLabel } from './model'
import type { PlanState, PlanTask } from './model'
import { prLabel, taskOutcome } from './outcome'

export interface BoardChip {
  id: string
  key: string
  title: string
  state: PlanState
  kind: 'work' | 'gate'
  /** The dispatch attempt, once the task has been handed to a worker. */
  attempt: number | null
  route: string | null
  note: string | null
  /** "PR #12" when the task opened a pull request; gates have none of their own. */
  pr: string | null
  ghost: 'input' | 'output' | null
  /** Waiting on a person: the chip keeps blinking until someone acts. */
  attention: boolean
  /** The agent running the task; null unless it is running. */
  agent: string | null
}

export interface BoardLane {
  id: string
  label: string
  sub: string
  online: boolean
  queue: boolean
  /** A task in this lane is running. */
  busy: boolean
  engines: string[]
  chips: BoardChip[]
}

const ATTENTION = new Set<PlanState>(['needs_user', 'escalated'])

/** One task as the board and the graph draw it. */
export function toChip(task: PlanTask, ghost: BoardChip['ghost'], now: Date): BoardChip {
  const attempt = task.row.attempt ?? null
  const gate = task.kind === 'gate'
  return {
    id: task.id,
    key: task.key,
    title: task.title,
    state: task.state,
    kind: gate ? 'gate' : 'work',
    attempt: attempt && attempt > 0 ? attempt : null,
    route: gate ? `gate · approver ${task.approver ?? 'user'}` : routeLabel(task.route ?? task.primary),
    note: gate ? null : nodeNote(task, now),
    pr: gate ? null : prLabel(taskOutcome(task.row)),
    ghost,
    attention: ATTENTION.has(task.state),
    agent: task.state === 'running' ? task.agent : null,
  }
}

/** Tasks whose state differs from the previous poll; tasks new to the plan do not count. */
export function changedStates(before: ReadonlyMap<string, PlanState>, tasks: PlanTask[]): string[] {
  return tasks.filter((t) => before.has(t.id) && before.get(t.id) !== t.state).map((t) => t.id)
}

/**
 * One lane per machine in use (online hosts, then offline agents, then the queue), each with its
 * chips in plan order: dependency depth, then priority, then key. A phase shows its own tasks plus
 * the ones it reads from and unlocks, marked as ghosts.
 */
export function boardLanes(
  tasks: PlanTask[],
  workers: ConductorWorker[],
  opts: { phase?: PhaseSelection; now: Date },
): BoardLane[] {
  const { phase, now } = opts
  const { lanes, laneOf } = assignLanes(tasks, workers)
  const { depth } = computeDepths(tasks)
  const ghostOf = (id: string): BoardChip['ghost'] => {
    if (!phase) return null
    if (phase.inputs.has(id)) return 'input'
    if (phase.outputs.has(id)) return 'output'
    return null
  }
  const shown = tasks.filter((t) => {
    if (t.kind === 'group') return false
    return !phase || phase.members.has(t.id) || phase.inputs.has(t.id) || phase.outputs.has(t.id)
  })
  shown.sort((a, b) =>
    (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0) || a.priority - b.priority || compareText(a.key, b.key))

  const chipsOf = new Map<string, BoardChip[]>()
  for (const t of shown) {
    const lane = laneOf.get(t.id) as string
    const list = chipsOf.get(lane)
    const chip = toChip(t, ghostOf(t.id), now)
    if (list) list.push(chip)
    else chipsOf.set(lane, [chip])
  }

  const result: BoardLane[] = []
  for (const lane of lanes) {
    const chips = chipsOf.get(lane.id)
    if (!chips) continue
    const engines = new Set<string>()
    for (const w of workers) {
      if (lane.agentIds.includes(w.agentId)) for (const e of w.engines) engines.add(e.executor)
    }
    result.push({
      id: lane.id,
      label: lane.label,
      sub: lane.sub,
      online: lane.online,
      queue: lane.id === 'queue',
      busy: chips.some((c) => c.state === 'running'),
      engines: [...engines].sort(compareText),
      chips,
    })
  }
  return result
}
