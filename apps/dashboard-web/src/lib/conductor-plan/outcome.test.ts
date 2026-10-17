import { describe, expect, it } from 'vitest'
import type { ConductorTask } from '../api'
import { toPlanTasks } from './model'
import type { PlanTask } from './model'
import { approveContext, artifactLine, isLongSummary, listKeys, prLabel, safeUrl, taskOutcome } from './outcome'
import { row } from './test-fixtures'

const REPO = 'https://github.com/acme/app'
const result = (r: unknown) => JSON.stringify(r)
const outcomeOf = (p: Partial<ConductorTask>) => taskOutcome(row({ id: 't', ...p }))

describe('taskOutcome', () => {
  it('is null without a result', () => {
    expect(outcomeOf({ result: null })).toBeNull()
    expect(outcomeOf({ result: '' })).toBeNull()
    expect(outcomeOf({ result: '   ' })).toBeNull()
  })

  it('reads a worker result: PR number, checks page, branch and commit links, passed tests', () => {
    const o = outcomeOf({
      status: 'review',
      result: result({
        summary: 'Added the login form',
        prUrl: `${REPO}/pull/42`,
        branch: 'cortex/b3-login',
        commit: '0123456789abcdef0123456789abcdef01234567',
        testOutput: '12 passed',
      }),
    })
    expect(o).toMatchObject({
      summary: 'Added the login form',
      pr: { url: `${REPO}/pull/42`, number: 42, checksUrl: `${REPO}/pull/42/checks` },
      compareUrl: null,
      branch: { name: 'cortex/b3-login', url: `${REPO}/tree/cortex/b3-login` },
      commit: { short: '0123456', url: `${REPO}/commit/0123456789abcdef0123456789abcdef01234567` },
      tests: 'passed',
      testOutput: '12 passed',
      error: null,
    })
  })

  it('builds the checks link from the bare PR path, whatever follows it', () => {
    const o = outcomeOf({ result: result({ summary: 's', prUrl: `${REPO}/pull/7/files?diff=split#top` }) })
    expect(o?.pr).toMatchObject({ number: 7, checksUrl: `${REPO}/pull/7/checks` })
  })

  it('encodes each branch segment but keeps the slashes', () => {
    const o = outcomeOf({ result: result({ summary: 's', prUrl: `${REPO}/pull/1`, branch: 'feat/a#b' }) })
    expect(o?.branch?.url).toBe(`${REPO}/tree/feat/a%23b`)
  })

  it('takes the compare link from a summary without a PR (gh unavailable) and derives the repo from it', () => {
    const compare = `${REPO}/compare/master...cortex/b3?expand=1`
    const o = outcomeOf({
      result: result({
        summary: `Did the work\n\nNo pull request was opened (gh unavailable). Compare: ${compare}`,
        branch: 'cortex/b3',
        commit: 'abcdef1234',
      }),
    })
    expect(o?.pr).toBeNull()
    expect(o?.compareUrl).toBe(compare)
    expect(o?.branch?.url).toBe(`${REPO}/tree/cortex/b3`)
    expect(o?.commit).toMatchObject({ sha: 'abcdef1234', short: 'abcdef1', url: `${REPO}/commit/abcdef1234` })
  })

  it('marks tests failed from the worker error and from a failed task with output and no error', () => {
    const failedRun = outcomeOf({
      status: 'failed',
      result: result({ summary: 's', error: 'tests failed (exit 1)', testOutput: '1 failed' }),
    })
    expect(failedRun?.tests).toBe('failed')
    expect(failedRun?.error).toBe('tests failed (exit 1)')
    const notFirst = outcomeOf({ status: 'failed', result: result({ summary: 's', error: 'engine stopped\ntests failed (exit 2)' }) })
    expect(notFirst?.tests).toBe('failed')
    expect(outcomeOf({ status: 'failed', result: result({ summary: 's', testOutput: 'boom' }) })?.tests).toBe('failed')
  })

  it('keeps tests passed when a task failed after them, and none without output', () => {
    const pushFailed = outcomeOf({
      status: 'failed',
      result: result({ summary: 's', error: 'the commit abc was not pushed', testOutput: 'ok' }),
    })
    expect(pushFailed?.tests).toBe('passed')
    expect(outcomeOf({ status: 'completed', result: result({ summary: 's' }) })?.tests).toBe('none')
  })

  it('drops links that are not https (localhost http aside), carry credentials or do not parse', () => {
    const bad = ['javascript:alert(1)', 'http://example.com/acme/app/pull/1', 'data:text/html,x', 'not a url',
      'https://user:pw@example.com/a/b/pull/1', 'ftp://example.com/a', '']
    for (const prUrl of bad) {
      const o = outcomeOf({ result: result({ summary: 's', prUrl, compareUrl: prUrl }) })
      expect(o?.pr, prUrl).toBeNull()
      expect(o?.compareUrl, prUrl).toBeNull()
    }
    expect(safeUrl('http://localhost:3000/acme/app/pull/3')?.href).toBe('http://localhost:3000/acme/app/pull/3')
    expect(safeUrl(42)).toBeNull()
  })

  it('keeps a non-GitHub pull request URL without a number, checks page or repo base', () => {
    const o = outcomeOf({
      result: result({ summary: 's', prUrl: 'https://gitlab.example.com/acme/app/-/merge_requests/9', branch: 'b', commit: 'abcdef1' }),
    })
    expect(o?.pr).toEqual({ url: 'https://gitlab.example.com/acme/app/-/merge_requests/9', number: null, checksUrl: null })
    expect(o?.branch).toEqual({ name: 'b', url: null })
    expect(o?.commit?.url).toBeNull()
  })

  it('shows a commit that is not a hex sha as plain text', () => {
    const o = outcomeOf({ result: result({ summary: 's', prUrl: `${REPO}/pull/1`, commit: 'HEAD~1' }) })
    expect(o?.commit).toEqual({ sha: 'HEAD~1', short: 'HEAD~1', url: null })
  })

  it('treats plain text, a JSON string and a number as the summary, and finds a PR URL in prose', () => {
    expect(outcomeOf({ result: 'Just text' })).toMatchObject({ summary: 'Just text', pr: null, tests: 'none' })
    expect(outcomeOf({ result: '"quoted"' })?.summary).toBe('quoted')
    expect(outcomeOf({ result: '42' })?.summary).toBe('42')
    const prose = outcomeOf({ result: `Opened ${REPO}/pull/15 for review.` })
    expect(prose?.pr?.number).toBe(15)
  })

  it('reads MCP results with snake_case keys or a message in place of a summary', () => {
    const o = outcomeOf({ result: result({ message: 'done', pr_url: `${REPO}/pull/3`, test_output: 'ok' }) })
    expect(o).toMatchObject({ summary: 'done', pr: { number: 3 }, tests: 'passed' })
  })

  it('is null for structured results with their own view: lists and objects with nothing of the above', () => {
    expect(outcomeOf({ result: result([{ title: 'a' }]) })).toBeNull()
    expect(outcomeOf({ result: result({ findings: [{ id: 'f1' }] }) })).toBeNull()
    expect(outcomeOf({ result: result({}) })).toBeNull()
  })

  it('ignores non-string fields', () => {
    const o = outcomeOf({ result: result({ summary: 5, prUrl: { url: 'x' }, branch: ['b'], error: 'oops' }) })
    expect(o).toMatchObject({ summary: '', pr: null, branch: null, error: 'oops' })
  })
})

describe('outcome helpers', () => {
  it('isLongSummary folds after eight lines, counting wrapped prose', () => {
    expect(isLongSummary(Array(8).fill('line').join('\n'))).toBe(false)
    expect(isLongSummary(Array(9).fill('line').join('\n'))).toBe(true)
    expect(isLongSummary('x'.repeat(90 * 8))).toBe(false)
    expect(isLongSummary('x'.repeat(90 * 8 + 1))).toBe(true)
  })

  it('prLabel names the number when there is one', () => {
    expect(prLabel(outcomeOf({ result: result({ summary: 's', prUrl: `${REPO}/pull/9` }) }))).toBe('PR #9')
    expect(prLabel(outcomeOf({ result: result({ summary: 's', prUrl: 'https://example.com/mr/9' }) }))).toBe('PR')
    expect(prLabel(outcomeOf({ result: 'text' }))).toBeNull()
    expect(prLabel(null)).toBeNull()
  })

  it('listKeys joins with commas and a final and', () => {
    expect(listKeys([])).toBe('')
    expect(listKeys(['A'])).toBe('A')
    expect(listKeys(['A', 'B'])).toBe('A and B')
    expect(listKeys(['A', 'B', 'C'])).toBe('A, B and C')
  })
})

const root = row({ id: 'root', kind: 'group' })

function plan(rows: Array<Partial<ConductorTask> & { id: string }>): Map<string, PlanTask> {
  const tasks = toPlanTasks(root, [root, ...rows.map((r) => row({ parent_task_id: 'root', task_key: r.id.toUpperCase(), ...r }))])
  return new Map(tasks.map((t) => [t.id, t]))
}

const deps = (...ids: string[]) => JSON.stringify(ids)
const get = (byId: Map<string, PlanTask>, id: string) => byId.get(id) as PlanTask
const pr = (n: number, extra: Record<string, unknown> = {}) => result({ summary: 's', prUrl: `${REPO}/pull/${n}`, ...extra })

describe('approveContext on work in review', () => {
  const byId = plan([
    { id: 'a', status: 'completed' },
    { id: 'x', status: 'pending' },
    { id: 'b3', status: 'review', depends_on: deps('a'), result: pr(42, { testOutput: 'ok' }) },
    { id: 'c1', status: 'blocked', depends_on: deps('b3', 'a') },
    { id: 'c2', status: 'blocked', depends_on: deps('b3', 'x') },
    { id: 'c3', status: 'pending', depends_on: deps('b3') },
    { id: 'c4', status: 'blocked', depends_on: deps('b3', 'elsewhere') },
  ])

  it('marks it done, names what it unblocks and that the PR stays open', () => {
    const ctx = approveContext(get(byId, 'b3'), byId)
    expect(ctx.label).toBe('Approve B3')
    expect(ctx.unblocks).toEqual(['C1'])
    expect(ctx.line).toBe('Marks B3 done · unblocks C1 · the PR is not merged by this')
    expect(ctx.disabled).toBeNull()
    expect(ctx.deps).toEqual([])
  })

  it('names the branch when there is no PR, and says nothing of merging without either', () => {
    const solo = plan([
      { id: 'b', status: 'review', result: result({ summary: 's', branch: 'cortex/b' }) },
      { id: 'n', status: 'review', result: 'plain text' },
    ])
    expect(approveContext(get(solo, 'b'), solo).line).toBe('Marks B done · branch cortex/b is not merged by this')
    expect(approveContext(get(solo, 'n'), solo).line).toBe('Marks N done')
  })

  it('a rejection sends the task back, and warns when it is the second', () => {
    const first = approveContext(get(byId, 'b3'), byId).reject
    expect(first.returns).toEqual(['B3'])
    expect(first.placeholder).toContain('Why B3 goes back')
    expect(first.placeholder).not.toContain('escalates')
    expect(first.disabled).toBeNull()
    const again = plan([{ id: 'b', status: 'review', reject_count: 1 }])
    expect(approveContext(get(again, 'b'), again).reject.placeholder).toContain('It was rejected before, so this escalates it.')
  })
})

describe('approveContext on a gate', () => {
  it('lists the dependencies with their outcomes and what closing the gate unblocks', () => {
    const byId = plan([
      { id: 'b2', status: 'completed', result: pr(12, { testOutput: 'ok' }) },
      { id: 'b1', status: 'completed', result: pr(11, { error: 'tests failed (exit 1)' }) },
      { id: 'g1', kind: 'gate', approver: 'user', status: 'pending', depends_on: deps('b1', 'b2') },
      { id: 'd1', status: 'blocked', depends_on: deps('g1') },
    ])
    const ctx = approveContext(get(byId, 'g1'), byId)
    expect(ctx.label).toBe('Approve gate G1')
    expect(ctx.deps.map((d) => [d.key, d.state, d.done, d.outcome?.pr?.number, d.outcome?.tests])).toEqual([
      ['B1', 'done', true, 11, 'failed'],
      ['B2', 'done', true, 12, 'passed'],
    ])
    expect(ctx.waitingOn).toEqual([])
    expect(ctx.disabled).toBeNull()
    expect(ctx.unblocks).toEqual(['D1'])
    expect(ctx.line).toBe('Closes gate G1 · unblocks D1 · the 2 PRs are not merged by this')
    expect(ctx.reject.returns).toEqual(['B1', 'B2'])
    expect(ctx.reject.placeholder).toContain('Why B1 and B2 go back')
    expect(ctx.reject.placeholder).toContain('G1 waits for them again')
  })

  it('is disabled, with the reason, while a dependency is not completed', () => {
    const byId = plan([
      { id: 'b1', status: 'completed' },
      { id: 'b2', status: 'review' },
      { id: 'g1', kind: 'gate', approver: 'user', status: 'pending', depends_on: deps('b1', 'b2') },
    ])
    const ctx = approveContext(get(byId, 'g1'), byId)
    expect(ctx.waitingOn).toEqual(['B2'])
    expect(ctx.disabled).toBe('B2 is not done yet — every dependency must be completed first')
    expect(ctx.line).toBe(ctx.disabled)
    expect(ctx.reject.returns).toEqual(['B1'])
  })

  it('waits on a group that is still open after its last tasks finished, and cannot send a group back', () => {
    const byId = plan([
      { id: 'p', kind: 'group', status: 'pending' },
      { id: 'p1', parent_task_id: 'p', status: 'completed' },
      { id: 'p2', parent_task_id: 'p', status: 'completed', depends_on: deps('p1') },
      { id: 'g', kind: 'gate', approver: 'user', status: 'pending', depends_on: deps('p') },
    ])
    const ctx = approveContext(get(byId, 'g'), byId)
    expect(ctx.deps.map((d) => d.key)).toEqual(['P2'])
    expect(ctx.waitingOn).toEqual(['P'])
    expect(ctx.disabled).toBe('P is not done yet — every dependency must be completed first')
    expect(ctx.reject).toMatchObject({ returns: [], disabled: 'nothing to return: cancel the gate or reroute its dependencies' })
  })

  it('mentions dependencies outside the plan without blocking on them', () => {
    const byId = plan([
      { id: 'b1', status: 'completed' },
      { id: 'g', kind: 'gate', approver: 'user', status: 'pending', depends_on: deps('b1', 'outside') },
    ])
    const ctx = approveContext(get(byId, 'g'), byId)
    expect(ctx.external).toBe(1)
    expect(ctx.disabled).toBeNull()
    expect(ctx.line).toBe('Closes gate G · also needs 1 task outside this plan')
  })
})

describe('artifactLine', () => {
  it('names the PR and tests of work, and nothing without them', () => {
    const byId = plan([
      { id: 'a', status: 'review', result: pr(4, { testOutput: 'ok' }) },
      { id: 'b', status: 'failed', result: result({ summary: 's', error: 'tests failed (exit 1)' }) },
      { id: 'c', status: 'review', result: 'plain' },
    ])
    expect(artifactLine(get(byId, 'a'), byId)).toBe('PR #4 · tests passed')
    expect(artifactLine(get(byId, 'b'), byId)).toBe('tests failed')
    expect(artifactLine(get(byId, 'c'), byId)).toBeNull()
  })

  it('sums up a gate: PR numbers up to three, then a count; failed keys, or how many passed', () => {
    const byId = plan([
      { id: 'a', status: 'completed', result: pr(1, { testOutput: 'ok' }) },
      { id: 'b', status: 'completed', result: pr(2) },
      { id: 'c', status: 'completed', result: pr(3, { testOutput: 'ok' }) },
      { id: 'd', status: 'completed', result: pr(4, { testOutput: 'ok' }) },
      { id: 'e', status: 'completed', result: result({ summary: 's', prUrl: 'https://example.com/mr/5' }) },
      { id: 'g1', kind: 'gate', approver: 'user', depends_on: deps('a', 'b') },
      { id: 'g2', kind: 'gate', approver: 'user', depends_on: deps('a', 'b', 'c', 'd') },
      { id: 'g3', kind: 'gate', approver: 'user', depends_on: deps('e') },
      { id: 'g4', kind: 'gate', approver: 'user', depends_on: deps('a', 'e') },
      { id: 'g5', kind: 'gate', approver: 'user' },
    ])
    expect(artifactLine(get(byId, 'g1'), byId)).toBe('PRs #1, #2 · tests passed 1/2')
    expect(artifactLine(get(byId, 'g2'), byId)).toBe('4 PRs · tests passed 3/4')
    expect(artifactLine(get(byId, 'g3'), byId)).toBe('PR')
    expect(artifactLine(get(byId, 'g4'), byId)).toBe('2 PRs · tests passed 1/2')
    expect(artifactLine(get(byId, 'g5'), byId)).toBeNull()
  })
})
