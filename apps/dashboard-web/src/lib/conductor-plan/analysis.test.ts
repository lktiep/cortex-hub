import { describe, expect, it } from 'vitest'
import { computeDepths } from './layout'
import { toPlanTasks } from './model'
import type { PlanTask } from './model'
import { criticalPath, fileConflicts, pathsOverlap } from './analysis'
import { row } from './test-fixtures'

const root = row({ id: 'root', kind: 'group' })

function tasks(...specs: Array<Parameters<typeof row>[0]>): PlanTask[] {
  return toPlanTasks(root, [root, ...specs.map((s) => row({ parent_task_id: 'root', ...s }))])
}

const deps = (...ids: string[]): string => JSON.stringify(ids)
const files = (...f: string[]): string => JSON.stringify(f)
const est = (n: number): string => JSON.stringify({ estimate: n })

function conflicts(ts: PlanTask[]) {
  return fileConflicts(ts, computeDepths(ts).depth)
}

function path(ts: PlanTask[]) {
  return criticalPath(ts, computeDepths(ts).cyclic)
}

describe('pathsOverlap', () => {
  it('follows the trailing-slash prefix rule', () => {
    expect(pathsOverlap('src/a.ts', 'src/a.ts')).toBe(true)
    expect(pathsOverlap('src/a/', 'src/a/b.ts')).toBe(true)
    expect(pathsOverlap('src/a/b.ts', 'src/a/')).toBe(true)
    expect(pathsOverlap('src/a/', 'src/a/')).toBe(true)
    expect(pathsOverlap('src/a', 'src/ab.ts')).toBe(false)
    expect(pathsOverlap('src/a/', 'src/ab/x.ts')).toBe(false)
    expect(pathsOverlap('src/a', 'src/a/b.ts')).toBe(false)
  })
})

describe('fileConflicts', () => {
  it('chains tasks on one path instead of linking every pair', () => {
    // depths 0, 2, 4: the tasks share x.ts but no direct dependency joins them
    const p = tasks(
      { id: 'a', files: files('x.ts') },
      { id: 'm', depends_on: deps('a') },
      { id: 'b', files: files('x.ts'), depends_on: deps('m') },
      { id: 'n', depends_on: deps('b') },
      { id: 'c', files: files('x.ts'), depends_on: deps('n') },
    )
    expect(conflicts(p).map((c) => `${c.from}>${c.to}`)).toEqual(['a>b', 'b>c'])
  })

  it('skips a pair already joined by a dependency in either direction', () => {
    expect(conflicts(tasks(
      { id: 'a', files: files('x.ts') }, { id: 'b', files: files('x.ts'), depends_on: deps('a') },
    ))).toEqual([])
  })

  it('emits one conflict per pair with the smallest shared key', () => {
    const r = conflicts(tasks(
      { id: 'a', files: files('src/z.ts', 'lib/') }, { id: 'b', files: files('src/z.ts', 'lib/q.ts') },
    ))
    expect(r).toEqual([{ from: 'a', to: 'b', file: 'lib/' }])
  })

  it('orders from/to by depth then key, and counts done tasks', () => {
    const r = conflicts(tasks(
      { id: 'late', task_key: 'k1', files: files('x.ts'), depends_on: deps('first') },
      { id: 'first', task_key: 'k9', status: 'completed' },
      { id: 'other', task_key: 'k0', files: files('x.ts'), status: 'completed' },
    ))
    expect(r).toEqual([{ from: 'other', to: 'late', file: 'x.ts' }])
  })

  it('tasks with no files never conflict', () => {
    expect(conflicts(tasks({ id: 'a', files: '[]' }, { id: 'b', files: '[]' }))).toEqual([])
    expect(conflicts(tasks({ id: 'a', files: 'not json' }, { id: 'b', files: 'not json' }))).toEqual([])
  })

  it('leaves out stopped tasks and groups', () => {
    expect(conflicts(tasks(
      { id: 'a', files: files('x.ts') }, { id: 'b', files: files('x.ts'), status: 'failed' },
    ))).toEqual([])
  })
})

describe('criticalPath', () => {
  it('picks the heavier branch of a diamond by estimate', () => {
    const r = path(tasks(
      { id: 'A', context: est(1) },
      { id: 'B', context: est(3), depends_on: deps('A') },
      { id: 'C', context: est(1), depends_on: deps('A') },
      { id: 'D', context: est(1), depends_on: deps('B', 'C') },
    ))
    expect(r.ids).toEqual(['A', 'B', 'D'])
    expect(r.days).toBe(5)
    expect(r.edges).toEqual(new Set(['A>B', 'B>D']))
  })

  it('defaults a missing estimate to 1', () => {
    const r = path(tasks({ id: 'A' }, { id: 'B', depends_on: deps('A') }))
    expect(r.days).toBe(2)
  })

  it('skips done and stopped tasks', () => {
    const r = path(tasks(
      { id: 'A', status: 'completed' },
      { id: 'B', depends_on: deps('A') },
      { id: 'C', depends_on: deps('B') },
      { id: 'S', status: 'failed', depends_on: deps('C') },
    ))
    expect(r.ids).toEqual(['B', 'C'])
    expect(r.edges).toEqual(new Set(['B>C']))
  })

  it('returns empty for nothing remaining', () => {
    expect(path([])).toEqual({ ids: [], edges: new Set(), days: 0 })
    expect(path(tasks({ id: 'A', status: 'completed' }))).toEqual({ ids: [], edges: new Set(), days: 0 })
  })

  it('ignores edges into a cycle and still returns', () => {
    const r = path(tasks(
      { id: 'A', depends_on: deps('B') }, { id: 'B', depends_on: deps('A') }, { id: 'C', depends_on: deps('A') },
    ))
    expect(r.ids.length).toBeGreaterThan(0)
    expect(r.edges.has('B>A')).toBe(false)
    expect(r.edges.has('A>B')).toBe(false)
  })

  it('breaks ties by key regardless of input order', () => {
    const specs = [
      { id: 'A' }, { id: 'X', task_key: 'x', depends_on: deps('A') }, { id: 'Y', task_key: 'y', depends_on: deps('A') },
      { id: 'J', depends_on: deps('X', 'Y') },
      { id: 'P', task_key: 'p' }, { id: 'Q', task_key: 'q' },
    ]
    const fwd = path(tasks(...specs))
    const rev = path(tasks(...[...specs].reverse()))
    expect(fwd.ids).toEqual(['A', 'X', 'J'])
    expect(rev.ids).toEqual(fwd.ids)
    // end-node tie: two independent single tasks of equal weight
    const ends = (s: typeof specs) => path(tasks(...s)).ids
    const two = [{ id: 'P', task_key: 'p' }, { id: 'Q', task_key: 'q' }]
    expect(ends(two)).toEqual(['P'])
    expect(ends([...two].reverse())).toEqual(['P'])
  })
})
