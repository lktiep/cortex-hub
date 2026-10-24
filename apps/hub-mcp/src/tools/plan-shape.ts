import type { TreePlan } from './conductor-lead.js'

type PlanTask = TreePlan['tasks'][number]

const MAX_KEYS = 8
/** Shorter than this, a description cannot say goal, scope and done to a worker that starts cold. */
const THIN_DESCRIPTION = 200
const DONE_SECTION = /done when|acceptance|definition of done/i
const BLIND_REFERENCE = /\b(as (described |mentioned )?above|(the )?previous (step|task)|(see|from|after|in) (step|task) [\w-]+|task \d+)\b/i
const ACTIVITY_TITLE = /^((write|add) )?((unit|e2e|integration) )?tests?\b|^(code )?review\b/i

export interface PlanCheck {
  text: string
  problems: number
}

const kindOf = (t: PlanTask): 'work' | 'gate' | 'group' => t.kind ?? 'work'
const keyList = (keys: string[]): string =>
  keys.length > MAX_KEYS ? `${keys.slice(0, MAX_KEYS).join(', ')}, …` : keys.join(', ')

/** Two `files` entries lock each other: the same path, or a directory (ending in /) and a path in it. */
function overlap(a: string, b: string): boolean {
  return a === b || (a.endsWith('/') && b.startsWith(a)) || (b.endsWith('/') && a.startsWith(b))
}

/**
 * What a plan's shape says before it runs: how wide and how long it is, and what a worker would
 * trip on. Plans from models that were never told how Conductor runs come out as a line of two or
 * three tasks, each waiting on the last, with one-line descriptions and no files.
 */
export function checkPlan(plan: Pick<TreePlan, 'parentId' | 'tasks'>): PlanCheck {
  const { tasks } = plan
  const byKey = new Map(tasks.map((t) => [t.key, t]))
  const children = new Map<string, PlanTask[]>()
  for (const t of tasks) if (t.parentKey) children.set(t.parentKey, [...(children.get(t.parentKey) ?? []), t])

  // Depending on a group is depending on every task under it, and a group's dependsOn reaches them all.
  const under = (key: string, seen: Set<string>): string[] => {
    const t = byKey.get(key)
    if (!t || seen.has(key)) return []
    seen.add(key)
    if (kindOf(t) !== 'group') return [key]
    return (children.get(key) ?? []).flatMap((c) => under(c.key, seen))
  }
  const depsOf = new Map<string, string[]>()
  for (const t of tasks) {
    if (kindOf(t) === 'group') continue
    const named = [...(t.dependsOn ?? [])]
    const climbed = new Set<string>()
    for (let p = t.parentKey; p !== undefined && !climbed.has(p); p = byKey.get(p)?.parentKey) {
      climbed.add(p)
      named.push(...(byKey.get(p)?.dependsOn ?? []))
    }
    depsOf.set(t.key, [...new Set(named.flatMap((k) => under(k, new Set())))])
  }

  const ancestors = new Map<string, Set<string>>()
  const visiting = new Set<string>()
  let cycle = false
  const ancestorsOf = (key: string): Set<string> => {
    const known = ancestors.get(key)
    if (known) return known
    if (visiting.has(key)) {
      cycle = true
      return new Set()
    }
    visiting.add(key)
    const all = new Set<string>()
    for (const d of depsOf.get(key) ?? []) {
      all.add(d)
      for (const a of ancestorsOf(d)) all.add(a)
    }
    visiting.delete(key)
    ancestors.set(key, all)
    return all
  }
  for (const key of depsOf.keys()) ancestorsOf(key)
  if (cycle) return { text: '**Plan check** — the dependencies form a cycle; the hub will refuse this plan.', problems: 1 }

  // Work tasks on the longest path that ends at each task; gates add no work but pass the count on.
  const depth = new Map<string, number>()
  const depthOf = (key: string): number => {
    const known = depth.get(key)
    if (known !== undefined) return known
    const t = byKey.get(key)
    const d = (t && kindOf(t) === 'work' ? 1 : 0) +Math.max(0, ...(depsOf.get(key) ?? []).map(depthOf))
    depth.set(key, d)
    return d
  }
  const work = tasks.filter((t) => kindOf(t) === 'work')
  const gates = tasks.filter((t) => kindOf(t) === 'gate').length
  const perLevel = new Map<number, number>()
  for (const t of work) perLevel.set(depthOf(t.key), (perLevel.get(depthOf(t.key)) ?? 0) + 1)
  const longest = Math.max(0, ...perLevel.keys())
  const widest = Math.max(0, ...perLevel.values())

  const problems: string[] = []
  const n = work.length
  if (n === 0) problems.push('No work tasks: only tasks of kind work are run by workers.')
  else if (n < 3 && !plan.parentId) {
    problems.push(`Only ${n} work task(s): not worth a tree. Make it one task with cortex_task_create, or find the work that can run beside it.`)
  }
  if (n >= 3 && longest > Math.ceil(n / 2)) {
    problems.push(`Chain: ${longest} of the ${n} work tasks wait on each other in a row, so the plan runs about as fast as one agent. Keep a dependency only where the later task needs the earlier one's code or decision; tasks on different files run side by side.`)
  }
  const top = tasks.filter((t) => !t.parentKey)
  if (!plan.parentId && top.length > 1) {
    problems.push(`${top.length} top-level tasks (${keyList(top.map((t) => t.key))}): put them under one root task of kind group, or the dashboard shows ${top.length} plans.`)
  }
  const noFiles = work.filter((t) => !t.files?.length)
  if (noFiles.length) problems.push(`No files on ${keyList(noFiles.map((t) => t.key))}: without them nothing stops two tasks editing the same file at once.`)
  const thin = work.filter((t) => (t.description ?? '').trim().length < THIN_DESCRIPTION)
  if (thin.length) {
    problems.push(`Thin description on ${keyList(thin.map((t) => t.key))}: a worker sees only its own title and description, so say the goal, the context, the scope and when it is done.`)
  }
  const noDone = work.filter((t) => !thin.includes(t) && !DONE_SECTION.test(t.description ?? ''))
  if (noDone.length) problems.push(`No "Done when" on ${keyList(noDone.map((t) => t.key))}: name the test or check that shows the task is finished.`)
  const blind = work.filter((t) => BLIND_REFERENCE.test(t.description ?? ''))
  if (blind.length) {
    problems.push(`${keyList(blind.map((t) => t.key))} point at other steps ("as above", "task 2"): workers can't see them. Paste what they need.`)
  }
  const activity = work.filter((t) => ACTIVITY_TITLE.test(t.title.trim()))
  if (activity.length) {
    problems.push(`${keyList(activity.map((t) => t.key))} look like test or review tasks: tests go in the task that changes the code, and every work task is reviewed already.`)
  }
  const shared: string[] = []
  for (let i = 0; i < work.length; i++) {
    for (let j = i + 1; j < work.length; j++) {
      const a = work[i]!
      const b = work[j]!
      if (ancestorsOf(a.key).has(b.key) || ancestorsOf(b.key).has(a.key)) continue
      const file = (a.files ?? []).find((f) => (b.files ?? []).some((g) => overlap(f, g)))
      if (file !== undefined) shared.push(`${a.key} and ${b.key} (${file})`)
    }
  }
  if (shared.length) {
    problems.push(`Parallel tasks share files, so they will wait on each other's lock: ${keyList(shared)}. Split the files, or make one depend on the other.`)
  }

  const shape = `${n} work task(s), ${gates} gate(s) · longest chain ${longest} · widest level ${widest}`
  const text = problems.length
    ? [`**Plan check** — ${shape}`, ...problems.map((p) => `- ${p}`)].join('\n')
    : `**Plan check** — ${shape}. No problems found.`
  return { text, problems: problems.length }
}
