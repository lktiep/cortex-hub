import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import type { TreePlan } from './conductor-lead.js'
import { checkPlan } from './plan-shape.js'
import { PLAN_GUIDE } from './plan-guide.js'

type Task = TreePlan['tasks'][number]

const desc = `## Goal\n${'Change the export so the worker knows what to do. '.repeat(5)}\n\n## Done when\n- the export test passes`
const work = (key: string, files: string[], extra: Partial<Task> = {}): Task =>
  ({ key, title: `Change ${key}`, parentKey: 'root', files, description: desc, ...extra })
const root: Task = { key: 'root', kind: 'group', title: 'Plan' }
const lines = (tasks: Task[], parentId?: string): string[] => checkPlan({ parentId, tasks }).text.split('\n')

describe('checkPlan', () => {
  it('passes a diamond: contract and an independent task, two dependents, a gate', () => {
    const res = checkPlan({
      tasks: [
        root,
        work('contract', ['types.ts']),
        work('win', ['win.ts']),
        work('api', ['api.ts'], { dependsOn: ['contract'] }),
        work('ui', ['ui.ts'], { dependsOn: ['contract'] }),
        { key: 'verify', parentKey: 'root', kind: 'gate', title: 'Verify', dependsOn: ['api', 'ui', 'win'] },
      ],
    })
    expect(res).toEqual({ text: '**Plan check** — 4 work task(s), 1 gate(s) · longest chain 2 · widest level 2. No problems found.', problems: 0 })
  })

  it('flags a chain longer than half the work tasks', () => {
    const out = lines([root, work('a', ['a.ts']), work('b', ['b.ts'], { dependsOn: ['a'] }), work('c', ['c.ts'], { dependsOn: ['b'] }), work('d', ['d.ts'], { dependsOn: ['c'] })])
    expect(out[0]).toBe('**Plan check** — 4 work task(s), 0 gate(s) · longest chain 4 · widest level 1')
    expect(out.slice(1)).toEqual([expect.stringMatching(/^- Chain: 4 of the 4 work tasks wait on each other/)])
  })

  it('counts work through a gate, which adds none of its own', () => {
    const out = lines([root, work('a', ['a.ts']), { key: 'g', parentKey: 'root', kind: 'gate', title: 'Accept', dependsOn: ['a'] }, work('b', ['b.ts'], { dependsOn: ['g'] }), work('c', ['c.ts'])])
    expect(out[0]).toBe('**Plan check** — 3 work task(s), 1 gate(s) · longest chain 2 · widest level 2. No problems found.')
  })

  it('says two tasks are not worth a tree, unless they extend one', () => {
    const tasks = [root, work('a', ['a.ts']), work('b', ['b.ts'])]
    expect(lines(tasks)[1]).toMatch(/^- Only 2 work task\(s\): not worth a tree/)
    expect(lines(tasks.slice(1).map((t) => ({ ...t, parentKey: undefined })), 'stored-parent')).toEqual([
      '**Plan check** — 2 work task(s), 0 gate(s) · longest chain 1 · widest level 2. No problems found.',
    ])
  })

  it('asks for one root group', () => {
    const tasks = ['a', 'b', 'c'].map((k) => work(k, [`${k}.ts`], { parentKey: undefined }))
    expect(lines(tasks).slice(1)).toEqual([expect.stringMatching(/^- 3 top-level tasks \(a, b, c\): put them under one root/)])
  })

  it('names work tasks without files, with thin descriptions, or without a done check', () => {
    const out = lines([
      root,
      work('a', ['a.ts']),
      work('b', []),
      work('c', ['c.ts'], { description: 'Do it.' }),
      work('d', ['d.ts'], { description: 'x'.repeat(250) }),
    ])
    expect(out.slice(1)).toEqual([
      expect.stringMatching(/^- No files on b:/),
      expect.stringMatching(/^- Thin description on c:/),
      expect.stringMatching(/^- No "Done when" on d:/),
    ])
  })

  it('catches references to steps the worker cannot see, and test or review tasks', () => {
    const out = lines([
      root,
      work('a', ['a.ts'], { description: `${desc}\nUse the helper as above.` }),
      work('b', ['b.ts'], { description: `${desc}\nStart from task 2.` }),
      work('c', ['c.ts'], { title: 'Write unit tests for the export' }),
      work('d', ['d.ts'], { title: 'Review the export PR' }),
      work('e', ['e.ts'], { title: 'Testing harness: run on Windows' }),
    ])
    expect(out.slice(1)).toEqual([
      expect.stringMatching(/^- a, b point at other steps/),
      expect.stringMatching(/^- c, d look like test or review tasks/),
    ])
  })

  it('reports files shared by tasks that can run at once, including a directory and a file in it', () => {
    const tasks = [root, work('a', ['src/x/']), work('b', ['src/x/y.ts']), work('c', ['c.ts'])]
    expect(lines(tasks).slice(1)).toEqual([expect.stringMatching(/^- Parallel tasks share files, so they will wait on each other's lock: a and b \(src\/x\/\)\./)])
    tasks[2] = work('b', ['src/x/y.ts'], { dependsOn: ['a'] })
    expect(lines(tasks)[0]).toMatch(/No problems found\.$/)
  })

  it("orders every task under a group by the group's dependsOn", () => {
    const res = checkPlan({
      tasks: [
        root,
        { key: 'one', parentKey: 'root', kind: 'group', title: 'Phase one' },
        { key: 'two', parentKey: 'root', kind: 'group', title: 'Phase two', dependsOn: ['one'] },
        work('a', ['shared.ts'], { parentKey: 'one' }),
        work('b', ['b.ts'], { parentKey: 'one' }),
        work('c', ['shared.ts'], { parentKey: 'two' }),
        work('d', ['d.ts'], { parentKey: 'two' }),
      ],
    })
    expect(res.text).toBe('**Plan check** — 4 work task(s), 0 gate(s) · longest chain 2 · widest level 2. No problems found.')
  })

  it('stops at a cycle', () => {
    const res = checkPlan({ tasks: [root, work('a', ['a.ts'], { dependsOn: ['b'] }), work('b', ['b.ts'], { dependsOn: ['a'] })] })
    expect(res).toEqual({ text: '**Plan check** — the dependencies form a cycle; the hub will refuse this plan.', problems: 1 })
  })
})

describe('PLAN_GUIDE', () => {
  it('is the body of templates/skills/plan/SKILL.md (run node scripts/sync-plan-guide.mjs)', () => {
    // A Windows checkout (core.autocrlf) turns the file's line endings into CRLF.
    const skill = readFileSync(new URL('../../../../templates/skills/plan/SKILL.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    expect(PLAN_GUIDE).toBe(skill.replace(/^---\n[\s\S]*?\n---\n+/, ''))
  })
})
