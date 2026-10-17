#!/usr/bin/env node
// Checks a Conductor plan file before it is sent to the hub, with the same rules the hub's
// tree validator applies, plus two of this sandbox's own: every work task names its files,
// and no title contains "review" (the IDE extension skips such tasks).
//
//   node scripts/check-plan.mjs plan.json [more.json ...]
//   node scripts/check-plan.mjs --body <projectId> plan.json > body.json
//
// With --body, the request body for POST /api/conductor/tree goes to stdout and the summary
// to stderr. Exit code 1 on the first file with a problem.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const EXECUTORS = ['claude', 'codex', 'agy', 'gemini']
const PRIORITIES = { critical: 1, high: 3, medium: 5, low: 8 }
const KINDS = ['work', 'gate', 'group']

/** Every problem in a plan, as text. An empty list means the plan is fine. */
export function problems(plan) {
  const out = []
  if (typeof plan !== 'object' || plan === null || !Array.isArray(plan.tasks)) return ['the file needs a "tasks" list']
  const byKey = new Map()
  for (const t of plan.tasks) {
    if (typeof t !== 'object' || t === null) { out.push('every task must be an object'); continue }
    if (typeof t.key !== 'string' || t.key === '') { out.push('every task needs a non-empty key'); continue }
    if (byKey.has(t.key)) out.push(`duplicate key ${t.key}`)
    byKey.set(t.key, t)
  }
  for (const [key, t] of byKey) {
    const kind = t.kind ?? 'work'
    if (typeof t.title !== 'string' || t.title === '') out.push(`${key}: title must be a non-empty string`)
    else if (/review/i.test(t.title)) out.push(`${key}: the IDE extension skips a title with "review" in it`)
    if (!KINDS.includes(kind)) out.push(`${key}: unknown kind ${kind}`)
    if (t.priority !== undefined && typeof t.priority !== 'number' && !Object.hasOwn(PRIORITIES, t.priority)) {
      out.push(`${key}: unknown priority ${t.priority}`)
    }
    if (t.executor !== undefined && !EXECUTORS.includes(t.executor)) out.push(`${key}: unknown executor ${t.executor}`)
    if (t.fallback !== undefined && t.fallback !== null) {
      if (!Array.isArray(t.fallback)) out.push(`${key}: fallback must be a list`)
      else for (const f of t.fallback) {
        if (typeof f !== 'object' || f === null || Array.isArray(f)) out.push(`${key}: fallback entries must be objects`)
        else if (f.executor !== null && !EXECUTORS.includes(f.executor)) out.push(`${key}: unknown fallback executor ${f.executor}`)
      }
    }
    if (t.approver !== undefined && kind !== 'gate') out.push(`${key}: approver is only for gates`)
    if (t.approver !== undefined && !['user', 'lead'].includes(t.approver)) out.push(`${key}: approver must be user or lead`)
    for (const name of ['dependsOn', 'files', 'requiredCapabilities']) {
      const v = t[name]
      if (v !== undefined && !(Array.isArray(v) && v.every((s) => typeof s === 'string'))) out.push(`${key}: ${name} must be a list of strings`)
    }
    if (kind === 'work' && !(Array.isArray(t.files) && t.files.length > 0)) out.push(`${key}: a work task should name its files`)
    for (const f of Array.isArray(t.files) ? t.files : []) {
      if (/[*?[]/.test(f)) out.push(`${key}: globs are not supported: ${f}`)
      else if (f.startsWith('/') || f.split(/[\\/]/).includes('..') || f.replace(/^\.\//, '') === '') out.push(`${key}: invalid path: ${f}`)
    }
    if (t.parentKey !== undefined && (byKey.get(t.parentKey)?.kind ?? 'work') !== 'group') {
      out.push(`${key}: parentKey ${t.parentKey} is not a group in this file`)
    }
    for (const d of Array.isArray(t.dependsOn) ? t.dependsOn : []) {
      if (!byKey.has(d)) out.push(`${key}: unknown dependency ${d}`)
    }
  }
  const roots = [...byKey.values()].filter((t) => t.parentKey === undefined)
  if (roots.length !== 1 || roots[0].kind !== 'group') out.push('the plan should have exactly one root, and it should be a group')
  const cycle = findCycle(byKey)
  if (cycle !== null) out.push(`dependency cycle: ${cycle.join(' -> ')}`)
  return out
}

/** Edges are dependencies plus group -> child, as on the hub, so depending on your own group is a cycle. */
function findCycle(byKey) {
  const edges = new Map([...byKey.keys()].map((k) => [k, []]))
  for (const [key, t] of byKey) {
    for (const d of Array.isArray(t.dependsOn) ? t.dependsOn : []) if (byKey.has(d)) edges.get(key).push(d)
    if (byKey.has(t.parentKey)) edges.get(t.parentKey).push(key)
  }
  const done = new Set()
  const path = []
  const visit = (node) => {
    if (path.includes(node)) return [...path.slice(path.indexOf(node)), node]
    if (done.has(node)) return null
    path.push(node)
    for (const next of edges.get(node)) {
      const found = visit(next)
      if (found !== null) return found
    }
    path.pop()
    done.add(node)
    return null
  }
  for (const node of edges.keys()) {
    const found = visit(node)
    if (found !== null) return found
  }
  return null
}

/** One line per task, then the files two or more work tasks share (they run one at a time). */
export function summary(plan) {
  const lines = []
  const depth = (t) => (t.parentKey === undefined ? 0 : 1 + depth(plan.tasks.find((p) => p.key === t.parentKey)))
  for (const t of plan.tasks) {
    const kind = t.kind ?? 'work'
    const route = kind !== 'work' ? kind + (t.approver ? `, ${t.approver}` : '')
      : t.executor ? t.executor + (Array.isArray(t.fallback) && t.fallback.length > 0 ? ` -> ${t.fallback.map((f) => f.executor ?? 'any').join(', ')}` : '')
        : t.requiredCapabilities?.length ? `capability ${t.requiredCapabilities.join(', ')}` : 'any agent'
    const after = t.dependsOn?.length ? `  after ${t.dependsOn.join(', ')}` : ''
    lines.push(`${'  '.repeat(depth(t))}${t.key}  ${t.title}  [${route}]${after}`)
  }
  const owners = new Map()
  for (const t of plan.tasks) {
    if ((t.kind ?? 'work') !== 'work') continue
    for (const f of t.files ?? []) owners.set(f, [...(owners.get(f) ?? []), t.key])
  }
  const shared = [...owners].filter(([, keys]) => keys.length > 1)
  for (const [file, keys] of shared) lines.push(`lock: ${file} is shared by ${keys.join(', ')}, which run one at a time`)
  return lines.join('\n')
}

function main(argv) {
  let projectId = null
  const files = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--body') projectId = argv[++i] ?? ''
    else files.push(argv[i])
  }
  if (files.length === 0 || projectId === '' || (projectId !== null && files.length > 1)) {
    console.error('usage: node scripts/check-plan.mjs plan.json [more.json ...]\n       node scripts/check-plan.mjs --body <projectId> plan.json')
    return 2
  }
  const log = projectId === null ? console.log : console.error
  for (const file of files) {
    let plan
    try { plan = JSON.parse(readFileSync(file, 'utf8')) } catch (e) {
      console.error(`${file}: ${e.message}`)
      return 1
    }
    const found = problems(plan)
    if (found.length > 0) {
      console.error(`${file}: ${found.length} problem(s)\n${found.map((p) => `  - ${p}`).join('\n')}`)
      return 1
    }
    log(`${file}: ok, ${plan.tasks.length} tasks\n${summary(plan)}\n`)
    if (projectId !== null) console.log(JSON.stringify({ projectId, tasks: plan.tasks }, null, 2))
  }
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
