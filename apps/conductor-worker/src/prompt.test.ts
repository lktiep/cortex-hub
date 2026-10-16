import { describe, expect, it } from 'vitest'
import type { AssignedTask } from '@cortex/shared-types'
import { PROMPT_LIMIT, buildPrompt } from './prompt.js'

const RULE_A = 'Do not commit, push, or switch branches; the worker does that.'
const RULE_B = 'Stay inside this working tree.'

function makeTask(over: Partial<AssignedTask> = {}): AssignedTask {
  return {
    id: 'task-1',
    key: 'T-1',
    title: 'Add a thing',
    description: 'Make the thing work.',
    context: {},
    files: [],
    branch: 'feat/thing',
    baseBranch: 'main',
    route: { executor: 'claude', model: 'sonnet' },
    attempt: 1,
    leaseExpiresAt: '2026-10-16T10:00:00.000Z',
    reviews: [],
    handoff: null,
    testCommand: null,
    ...over,
  } as AssignedTask
}

function expectSafe(prompt: string): void {
  expect(prompt.length).toBeLessThanOrEqual(PROMPT_LIMIT)
  expect(prompt).toContain(RULE_A)
  expect(prompt).toContain(RULE_B)
}

describe('buildPrompt', () => {
  it('includes title, description, files, reviews, handoff and rules', () => {
    const prompt = buildPrompt(
      makeTask({
        files: ['src/a.ts', 'src/b.ts'],
        reviews: [
          { at: '2026-10-01T00:00:00Z', by: 'alice', verdict: 'reject', feedback: 'old feedback' },
          { at: '2026-10-02T00:00:00Z', by: 'bob', verdict: 'approve', feedback: 'new feedback' },
        ],
        handoff: { branch: 'feat/thing', commit: null, note: 'quota ran out midway' },
      }),
    )
    expect(prompt).toContain('# T-1: Add a thing')
    expect(prompt).toContain('Make the thing work.')
    expect(prompt).toContain('## Files')
    expect(prompt).toContain('src/a.ts')
    expect(prompt).toContain('## Previous review feedback')
    expect(prompt).toContain('bob')
    expect(prompt).toContain('approve')
    expect(prompt.indexOf('new feedback')).toBeLessThan(prompt.indexOf('old feedback'))
    expect(prompt).toContain('## Handoff from the previous run')
    expect(prompt).toContain('quota ran out midway')
    expect(prompt).toContain('## Rules')
    expectSafe(prompt)
    expect(prompt).not.toContain('## Resuming')
  })

  it('works for a title-only task', () => {
    const prompt = buildPrompt(makeTask({ description: '' }))
    expect(prompt).toContain('# T-1: Add a thing')
    expect(prompt).not.toContain('## Files')
    expect(prompt).not.toContain('## Previous review feedback')
    expectSafe(prompt)
  })

  it('uses the id when key is null', () => {
    expect(buildPrompt(makeTask({ key: null }))).toContain('# task-1: Add a thing')
  })

  it('adds a Resuming section when resumed', () => {
    const prompt = buildPrompt(makeTask(), { resumed: true })
    expect(prompt).toContain('## Resuming')
    expect(prompt).toContain('interrupted')
    expect(prompt).toContain('git status')
    expect(prompt).toContain('git diff')
    expect(prompt.indexOf('## Resuming')).toBeLessThan(prompt.indexOf('## Rules'))
  })

  it('rules survive truncation and the result is <= PROMPT_LIMIT', () => {
    const prompt = buildPrompt(makeTask({ description: 'd'.repeat(100_000) }))
    expectSafe(prompt)
    expect(prompt).toContain('[truncated]')
    expect(prompt).toContain('dddd')
  })

  it('drops oldest reviews first and says so', () => {
    const reviews = Array.from({ length: 200 }, (_, i) => ({
      at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      by: `r${i}`,
      verdict: 'reject' as const,
      feedback: 'f'.repeat(1000),
    }))
    const prompt = buildPrompt(makeTask({ reviews }))
    expectSafe(prompt)
    expect(prompt).toMatch(/\[truncated: \d+ older reviews omitted\]/)
    expect(prompt).toContain('r199')
    expect(prompt).not.toContain('r0 ')
  })

  it('survives 5000 file paths', () => {
    const files = Array.from({ length: 5000 }, (_, i) => `src/dir/file-${i}.ts`)
    expectSafe(buildPrompt(makeTask({ files })))
  })

  it('survives a 50 000-char handoff note', () => {
    const handoff = { branch: 'b', commit: null, note: 'n'.repeat(50_000) }
    expectSafe(buildPrompt(makeTask({ handoff })))
  })

  it('survives a 30 000-char title', () => {
    expectSafe(buildPrompt(makeTask({ title: 't'.repeat(30_000) })))
  })

  it('survives everything oversized at once', () => {
    const task = makeTask({
      title: 't'.repeat(30_000),
      description: 'd'.repeat(100_000),
      files: Array.from({ length: 5000 }, (_, i) => `src/f${i}.ts`),
      handoff: { branch: 'b', commit: null, note: 'n'.repeat(50_000) },
      reviews: Array.from({ length: 200 }, (_, i) => ({
        at: `2026-01-01T00:${String(i % 60).padStart(2, '0')}:00Z`,
        by: 'x',
        verdict: 'reject' as const,
        feedback: 'f'.repeat(1000),
      })),
    })
    expectSafe(buildPrompt(task, { resumed: true }))
  })
})
