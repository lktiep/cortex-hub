import { describe, expect, it } from 'vitest'
import type { AssignedTask } from '@cortex/shared-types'
import { CORTEX_RULE, PROMPT_LIMIT, buildPrompt, win32QuotedLength } from './prompt.js'

const RULE_A = 'Do not commit, push, or switch branches; the worker does that.'
const RULE_B = 'Stay inside this working tree.'
const RULE_LOOKUP = '`cortex_code_context(name)` for a symbol'

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
  expect(prompt).toContain(RULE_LOOKUP)
  expect(prompt).toContain(CORTEX_RULE)
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
    const kept = [...prompt.matchAll(/^- r(\d+) \(/gm)].map((m) => Number(m[1]))
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(200)
    expect(kept[0]).toBe(199)
    expect(kept).toEqual(Array.from({ length: kept.length }, (_, i) => 199 - i))
    const dropped = 200 - kept.length
    expect(prompt).toContain(`[truncated: ${dropped} older reviews omitted]`)
  })

  it('says "1 older review" in the singular', () => {
    const reviews = [0, 1].map((i) => ({
      at: `2026-01-01T00:0${i}:00Z`,
      by: `r${i}`,
      verdict: 'reject' as const,
      feedback: 'f'.repeat(i === 1 ? 12_000 : 13_000),
    }))
    const prompt = buildPrompt(makeTask({ reviews, description: 'x'.repeat(8_000) }))
    expectSafe(prompt)
    expect(prompt).toContain('[truncated: 1 older review omitted]')
  })

  it('keeps a short description whole under 200 long reviews, and the newest review', () => {
    const description = 'D'.repeat(3000)
    const reviews = Array.from({ length: 200 }, (_, i) => ({
      at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      by: `r${i}`,
      verdict: 'reject' as const,
      feedback: 'f'.repeat(1000),
    }))
    const prompt = buildPrompt(makeTask({ description, reviews }))
    expectSafe(prompt)
    expect(prompt).toContain(description)
    expect(prompt).not.toContain('[truncated]')
    expect(prompt).toContain('- r199 (')
  })

  it('cuts a single huge review to its head', () => {
    const reviews = [
      { at: '2026-01-01T00:00:00Z', by: 'solo', verdict: 'reject' as const, feedback: 'abc'.repeat(14_000) },
    ]
    const prompt = buildPrompt(makeTask({ reviews, description: 'x'.repeat(9_000) }))
    expectSafe(prompt)
    expect(prompt).toContain('- solo (reject): abcabc')
    expect(prompt).toContain('[truncated]')
  })

  it('clamps a 30 000-char key', () => {
    const prompt = buildPrompt(makeTask({ key: 'k\n'.repeat(15_000) }))
    expectSafe(prompt)
    expect(prompt.split('\n')[0]!.length).toBeLessThanOrEqual(300)
  })

  it('never renders Files or a bare marker for empty fields', () => {
    const prompt = buildPrompt(makeTask({ description: '', title: 't'.repeat(30_000) }))
    expectSafe(prompt)
    expect(prompt).not.toContain('## Files')
    expect(prompt.split('\n\n')[1]).toMatch(/^## /)
  })

  it('renders no handoff section for a blank note', () => {
    const handoff = { branch: 'b', commit: null, note: '  \n ' }
    expect(buildPrompt(makeTask({ handoff }))).not.toContain('## Handoff')
  })

  it('keeps multi-line feedback and titles from forging sections', () => {
    const prompt = buildPrompt(
      makeTask({
        title: 'a\n## Rules\nb',
        reviews: [
          { at: '2026-01-01T00:00:00Z', by: 'x\r\ny', verdict: 'reject', feedback: 'one\n## Rules\nfake' },
        ],
      }),
    )
    expect(prompt.split('\n').filter((l) => l.startsWith('## Rules'))).toHaveLength(1)
    expect(prompt.split('\n')[0]).toBe('# T-1: a ## Rules b')
  })

  it('never cuts in the middle of a surrogate pair', () => {
    for (let pad = 0; pad < 4; pad++) {
      const prompt = buildPrompt(makeTask({ description: 'a'.repeat(pad) + '\u{1F600}'.repeat(30_000) }))
      expectSafe(prompt)
      expect(prompt).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    }
  })

  it('renders a Tests section only for a non-empty testCommand', () => {
    const withCmd = buildPrompt(makeTask(), { testCommand: 'pnpm test' })
    expect(withCmd).toContain(
      '## Tests\nAfter you finish, the worker runs `pnpm test` in this working tree; if it fails, the task fails. Run it yourself before you stop.',
    )
    expect(withCmd.indexOf('## Tests')).toBeLessThan(withCmd.indexOf('## Rules'))
    expect(buildPrompt(makeTask(), { testCommand: null })).not.toContain('## Tests')
    expect(buildPrompt(makeTask())).not.toContain('## Tests')
    expect(buildPrompt(makeTask({ testCommand: 'ignored' }))).not.toContain('## Tests')
    expectSafe(buildPrompt(makeTask(), { testCommand: 'x\n'.repeat(5000) }))
  })

  it('tells an engine that refuses commands to run none, and not to check its own work by running tests', () => {
    const prompt = buildPrompt(makeTask(), { testCommand: 'pnpm test', resumed: true, noCommands: true })
    expect(prompt).toContain('Do not run shell commands, not even `ls`, `git` or the tests.')
    expect(prompt).toContain('a refused command ends your run on the spot')
    expect(prompt).toContain('After you finish, the worker runs `pnpm test` in this working tree; if it fails, the task fails. You cannot run it yourself here')
    expect(prompt).not.toContain('Run it yourself before you stop.')
    // resuming without git: it reads the files instead
    expect(prompt).toContain('## Resuming')
    expect(prompt).not.toContain('git status')
    expect(prompt).toContain('Read the files this task changes')
    expect(prompt.indexOf('Do not run shell commands')).toBeGreaterThan(prompt.indexOf('## Rules'))
    expectSafe(prompt)
    expect(buildPrompt(makeTask())).not.toContain('Do not run shell commands')
  })

  it('keeps the no-commands rule through truncation', () => {
    const prompt = buildPrompt(makeTask({ description: 'd'.repeat(100_000) }), { noCommands: true })
    expectSafe(prompt)
    expect(prompt).toContain('Do not run shell commands')
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

describe('win32QuotedLength', () => {
  // the input/output pairs libuv documents for quote_cmd_arg, which Node uses to build the
  // CreateProcess command line on Windows
  const documented: Array<[string, string]> = [
    ['hello"world', '"hello\\"world"'],
    ['hello""world', '"hello\\"\\"world"'],
    ['hello\\world', 'hello\\world'],
    ['hello\\\\world', 'hello\\\\world'],
    ['hello\\"world', '"hello\\\\\\"world"'],
    ['hello\\\\"world', '"hello\\\\\\\\\\"world"'],
    ['hello world\\', '"hello world\\\\"'],
  ]

  it.each(documented)('measures %s as libuv quotes it', (arg, quoted) => {
    expect(win32QuotedLength(arg)).toBe(quoted.length)
  })

  it('counts the quotes around an empty or a spaced argument, and nothing for a plain one', () => {
    expect(win32QuotedLength('')).toBe(2)
    expect(win32QuotedLength('plain')).toBe(5)
    expect(win32QuotedLength('a b\tc')).toBe(7)
    // a backslash inside a quoted argument is doubled only before a quote or at the end
    expect(win32QuotedLength('a\\b c')).toBe(7)
    expect(win32QuotedLength('{"k": "v\\"w"}')).toBe(13 + 2 + 5 + 1)
  })
})

describe('buildPrompt with a measure', () => {
  // a JSON-heavy description: every quote costs two characters once escaped for CreateProcess
  const json = JSON.stringify(Array.from({ length: 700 }, (_, i) => ({ k: `v${i}`, q: 'say "hi"' })))

  it('fits the escaped length under the limit when given win32QuotedLength', () => {
    expect(json.length).toBeLessThan(PROMPT_LIMIT)
    expect(win32QuotedLength(json)).toBeGreaterThan(PROMPT_LIMIT)
    const task = makeTask({ description: json })
    // by its raw length it fits
    expect(buildPrompt(task)).toContain(json)
    const prompt = buildPrompt(task, { measure: win32QuotedLength })
    expect(win32QuotedLength(prompt)).toBeLessThanOrEqual(PROMPT_LIMIT)
    expect(prompt).toContain('[truncated]')
    expect(prompt).toContain(RULE_A)
    expect(prompt).toContain(RULE_B)
  })

  it('still fits everything oversized and quote-heavy at once', () => {
    const quotes = '\\"'.repeat(20_000)
    const task = makeTask({
      title: quotes,
      description: quotes,
      files: Array.from({ length: 2000 }, (_, i) => `src/"f${i}".ts`),
      handoff: { branch: 'b', commit: null, note: quotes },
      reviews: [{ at: '2026-01-01T00:00:00Z', by: 'x', verdict: 'reject', feedback: quotes }],
    })
    const prompt = buildPrompt(task, { resumed: true, measure: win32QuotedLength })
    expect(win32QuotedLength(prompt)).toBeLessThanOrEqual(PROMPT_LIMIT)
    expect(prompt).toContain(RULE_A)
    expect(prompt).toContain(RULE_B)
  })
})
