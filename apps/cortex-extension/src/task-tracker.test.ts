import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TIMINGS, decide, isReviewTask, outcomeFor, pasteShortcut, revokeStopsConversation, sameRun, startTracking,
  taskPrompt, timingsFor, untrackedProgress, untrackedToast, type Decision, type Observation, type TaskTracking,
} from './task-tracker.js'

const MIN = 60_000
const T0 = 1_000_000

const tracked = (): TaskTracking =>
  startTracking({ taskId: 't1', title: 'Fix login', attempt: 2, mode: 'tracked', conversationId: 'c1' }, T0)

/** Runs `polls` of [minutes after start, observation] and returns each decision. */
function run(t: TaskTracking, polls: Array<[number, Observation]>): { last: TaskTracking; decisions: Decision[] } {
  const decisions: Decision[] = []
  let state = t
  for (const [at, seen] of polls) {
    const { next, decision } = decide(state, seen, T0 + at * MIN)
    state = next
    decisions.push(decision)
  }
  return { last: state, decisions }
}

const steps = (count: number): Observation => ({ kind: 'steps', count })

describe('decide: silence is never completion', () => {
  it('reports progress when its own conversation gains steps', () => {
    const { decisions } = run(tracked(), [[0.2, steps(1)], [1.5, steps(9)]])
    expect(decisions[0]).toEqual({ kind: 'progress', message: 'Conversation started (1 steps so far)' })
    expect(decisions[1]).toEqual({ kind: 'progress', message: 'Working: 9 steps in its own conversation' })
  })

  it('throttles progress reports but still counts the steps as activity', () => {
    const { last, decisions } = run(tracked(), [[0.1, steps(1)], [0.3, steps(2)], [0.5, steps(3)]])
    expect(decisions.map((d) => d.kind)).toEqual(['progress', 'wait', 'wait'])
    expect(last.steps).toBe(3)
    expect(last.lastActivityAt).toBe(T0 + 0.5 * MIN)
  })

  it('a conversation that stops moving is reported once as needing attention, not completed', () => {
    const polls: Array<[number, Observation]> = [[0.2, steps(4)], [1, steps(12)]]
    for (let m = 2; m <= 40; m++) polls.push([m, steps(12)])
    const { last, decisions } = run(tracked(), polls)
    const kinds = decisions.map((d) => d.kind)
    expect(kinds).not.toContain('timeout')
    expect(kinds.filter((k) => k === 'attention')).toHaveLength(1)
    // quiet from minute 1, so the notice comes at minute 6
    expect(kinds.indexOf('attention')).toBe(polls.findIndex(([m]) => m === 6))
    const attention = decisions.find((d) => d.kind === 'attention')
    expect(attention).toMatchObject({ message: expect.stringContaining('at 12 steps') })
    expect(attention).toMatchObject({ message: expect.stringContaining('not marked done') })
    expect(last.attentionSent).toBe(true)
  })

  it('new steps after a quiet spell re-arm the notice', () => {
    const { decisions } = run(tracked(), [[0.2, steps(3)], [6, steps(3)], [7, steps(5)], [13, steps(5)]])
    expect(decisions.map((d) => d.kind)).toEqual(['progress', 'attention', 'progress', 'attention'])
  })

  it('an old conversation with many steps elsewhere changes nothing: only its own id counts', () => {
    // the bug this replaces watched "the latest session" (an old chat at ~1094 steps) and called
    // the task done after 15 s of no change. Here the task's conversation is missing from the list.
    const { decisions } = run(tracked(), [[0.25, { kind: 'missing' }], [0.5, { kind: 'missing' }], [5, { kind: 'missing' }]])
    expect(decisions.map((d) => d.kind)).toEqual(['wait', 'wait', 'attention'])
    expect(decisions[2]).toMatchObject({ message: expect.stringContaining('conversation c1 is not in the IDE') })
  })

  it('times out as failed, with a clear message, even while the agent is still moving', () => {
    const polls: Array<[number, Observation]> = []
    for (let m = 1; m <= 60; m++) polls.push([m, steps(m)])
    const { decisions } = run(tracked(), polls)
    expect(decisions.slice(0, -1).map((d) => d.kind)).not.toContain('timeout')
    expect(decisions.at(-1)).toMatchObject({ kind: 'timeout', message: expect.stringContaining('No result after 60 min') })
    expect(decisions.at(-1)).toMatchObject({ message: expect.stringContaining('at 59 steps') })
  })

  it('manual and untracked tasks get one reminder, then the timeout; never a completion', () => {
    for (const mode of ['manual', 'untracked'] as const) {
      const t = startTracking({ taskId: 't2', title: 'Docs', mode }, T0)
      const polls: Array<[number, Observation]> = []
      for (let m = 1; m <= 60; m++) polls.push([m, { kind: 'unknown' }])
      const { decisions } = run(t, polls)
      const kinds = decisions.map((d) => d.kind)
      expect(kinds.filter((k) => k === 'attention')).toHaveLength(1)
      expect(kinds.at(-1)).toBe('timeout')
      expect(kinds.filter((k) => k === 'progress')).toHaveLength(0)
    }
  })

  it('a manual task never takes a conversation id', () => {
    const t = startTracking({ taskId: 't3', title: 'x', mode: 'manual', conversationId: 'c9' }, T0)
    expect(t.conversationId).toBeUndefined()
  })

  it('the timeout follows cortexHub.taskTimeoutMinutes, and ignores nonsense', () => {
    expect(timingsFor(90).timeoutMs).toBe(90 * MIN)
    expect(timingsFor(0).timeoutMs).toBe(DEFAULT_TIMINGS.timeoutMs)
    expect(timingsFor('5').timeoutMs).toBe(DEFAULT_TIMINGS.timeoutMs)
    expect(timingsFor(undefined).timeoutMs).toBe(DEFAULT_TIMINGS.timeoutMs)
    const t = tracked()
    expect(decide(t, steps(1), T0 + 89 * MIN, timingsFor(90)).decision.kind).not.toBe('timeout')
    expect(decide(t, steps(1), T0 + 90 * MIN, timingsFor(90)).decision.kind).toBe('timeout')
  })
})

describe('sameRun', () => {
  it('a button from an earlier run of the same task does not match the current run', () => {
    const first = tracked()
    const again = startTracking({ taskId: 't1', title: 'Fix login', attempt: 3, mode: 'tracked', conversationId: 'c2' }, T0 + MIN)
    expect(sameRun(first, decide(first, steps(4), T0 + 1000).next)).toBe(true)
    expect(sameRun(first, again)).toBe(false)
    expect(sameRun(first, null)).toBe(false)
  })
})

describe('what the hub hears', () => {
  it('Mark done completes, Mark failed fails, Release task declines', () => {
    expect(outcomeFor('Mark done')).toEqual({ kind: 'complete', status: 'completed', result: { summary: 'Marked done by the user in the IDE' } })
    expect(outcomeFor('Mark failed')).toMatchObject({ kind: 'complete', status: 'failed', result: { error: 'Marked failed by the user in the IDE' } })
    expect(outcomeFor('Release task')).toEqual({ kind: 'decline', reason: 'Released by the user in the IDE' })
  })

  it('a revoke for another owner stops the conversation; the agent\'s own report does not', () => {
    expect(revokeStopsConversation('completed')).toBe(false)
    expect(revokeStopsConversation('failed')).toBe(false)
    for (const reason of ['cancelled', 'deleted', 'rerouted', 'lease expired']) expect(revokeStopsConversation(reason)).toBe(true)
  })

  it('untracked and manual tasks tell the hub they are not followed automatically', () => {
    expect(untrackedProgress('manual')).toMatch(/^Manual mode: .*clipboard.*Nothing tracks it automatically/)
    expect(untrackedProgress('untracked')).toMatch(/^Untracked: .*did not report/)
  })
})

describe('paste shortcut by OS', () => {
  it('Cmd+V on macOS only', () => {
    expect(pasteShortcut('darwin')).toBe('Cmd+V')
    expect(pasteShortcut('win32')).toBe('Ctrl+V')
    expect(pasteShortcut('linux')).toBe('Ctrl+V')
  })

  it('the clipboard toast names the right shortcut and says the task is not tracked', () => {
    const mac = untrackedToast('Fix login', 'manual', 'darwin')
    const win = untrackedToast('Fix login', 'manual', 'win32')
    expect(mac).toContain('with Cmd+V')
    expect(win).toContain('with Ctrl+V')
    expect(win).not.toContain('Cmd+V')
    for (const text of [mac, win, untrackedToast('Fix login', 'untracked', 'linux')]) {
      expect(text).toContain('will not be tracked automatically')
      expect(text).toContain('Mark done')
      expect(text).toContain('Release task')
    }
    expect(untrackedToast('Fix login', 'untracked', 'linux')).not.toContain('clipboard')
  })
})

describe('taskPrompt', () => {
  it('carries the task and asks the agent to report through cortex_task_update', () => {
    const prompt = taskPrompt('t1', 'Do the thing')
    expect(prompt.startsWith('[Cortex Task t1]\n\nDo the thing\n')).toBe(true)
    expect(prompt).toContain('cortex_task_update with taskId "t1"')
  })
})

describe('isReviewTask', () => {
  it('matches review titles, not words that contain "review"', () => {
    expect(isReviewTask('[Review] Fix login')).toBe(true)
    expect(isReviewTask('Code review: api')).toBe(true)
    expect(isReviewTask('Reviewer pass')).toBe(true)
    expect(isReviewTask('Add a preview pane')).toBe(false)
  })
})
