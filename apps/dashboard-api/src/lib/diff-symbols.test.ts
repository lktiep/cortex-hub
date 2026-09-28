import { describe, it, expect } from 'vitest'
import { analyzeDiff, parseCypherTable, parseUnifiedDiff, type RunCypher } from './diff-symbols.js'

const WHOLE = { start: 1, end: Number.MAX_SAFE_INTEGER }

function ranges(diff: string) {
  return Object.fromEntries(parseUnifiedDiff(diff).changed)
}

describe('parseUnifiedDiff', () => {
  it('marks a replaced line by its old number, not the context around it', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -10,7 +10,8 @@ export function foo() {',
      ' c10',
      ' c11',
      ' c12',
      '-old13',
      '+new13',
      '+new14',
      ' c14',
      ' c15',
      ' c16',
      '',
    ].join('\n')

    expect(ranges(diff)).toEqual({ 'src/a.ts': [{ start: 13, end: 13 }] })
  })

  it('marks an insertion by the two old lines it lands between', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -20,6 +20,8 @@',
      ' c20',
      ' c21',
      ' c22',
      '+n1',
      '+n2',
      ' c23',
      ' c24',
      ' c25',
    ].join('\n')

    expect(ranges(diff)).toEqual({ 'src/a.ts': [{ start: 22, end: 23 }] })
  })

  it('reads zero-context hunks, including pure deletions and pure insertions', () => {
    const diff = [
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -5,2 +4,0 @@ function a() {',
      '-x',
      '-y',
      '@@ -30,0 +29,2 @@ function b() {',
      '+p',
      '+q',
      '@@ -40 +41 @@',
      '-r',
      '+s',
    ].join('\n')

    expect(ranges(diff)).toEqual({
      'src/b.ts': [
        { start: 5, end: 6 },
        { start: 30, end: 31 },
        { start: 40, end: 40 },
      ],
    })
  })

  it('reads a diff whose hunk bodies were left out the same as the full one', () => {
    const headersOnly = [
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -5,2 +4,0 @@ function a() {',
      '@@ -30,0 +29,2 @@ function b() {',
      '@@ -40 +41 @@',
      'diff --git a/src/c.ts b/src/c.ts',
      '--- a/src/c.ts',
      '+++ b/src/c.ts',
      '@@ -7,3 +7,1 @@',
      '',
    ].join('\n')

    expect(ranges(headersOnly)).toEqual({
      'src/b.ts': [
        { start: 5, end: 6 },
        { start: 30, end: 31 },
        { start: 40, end: 40 },
      ],
      'src/c.ts': [{ start: 7, end: 9 }],
    })
  })

  it('reads a diff cut down to its git headers and hunk headers', () => {
    const gitHeadersOnly = [
      'diff --git a/src/b.ts b/src/b.ts',
      '@@ -5,2 +4,0 @@',
      '@@ -40 +41 @@',
      'diff --git a/src/old.ts b/src/new.ts',
      '@@ -7,3 +7,1 @@',
      '',
    ].join('\n')

    // The rename cannot be placed without its --- line, so it is left out rather than guessed.
    expect(ranges(gitHeadersOnly)).toEqual({
      'src/b.ts': [
        { start: 5, end: 6 },
        { start: 40, end: 40 },
      ],
    })
  })

  it('lists new files apart, covers deleted files whole, and reads a rename by its old path', () => {
    const diff = [
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      'index 0000000..1234567',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,3 @@',
      '+++ an added line that reads like a header',
      '+b',
      '+c',
      'diff --git a/src/gone.ts b/src/gone.ts',
      'deleted file mode 100644',
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '--- a removed line that reads like a header',
      '-x',
      'diff --git a/src/old name.ts b/src/renamed.ts',
      'similarity index 90%',
      'rename from src/old name.ts',
      'rename to src/renamed.ts',
      '--- a/src/old name.ts\t',
      '+++ b/src/renamed.ts\t',
      '@@ -3 +3 @@',
      '-a',
      '+b',
    ].join('\n')

    const parsed = parseUnifiedDiff(diff)
    expect(parsed.added).toEqual(['src/new.ts'])
    expect(Object.fromEntries(parsed.changed)).toEqual({
      'src/gone.ts': [WHOLE],
      'src/old name.ts': [{ start: 3, end: 3 }],
    })
  })

  it('decodes quoted paths, CRLF line ends, timestamps and the no-newline marker', () => {
    const diff = [
      'diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"',
      '--- "a/src/caf\\303\\251.ts"',
      '+++ "b/src/caf\\303\\251.ts"',
      '@@ -1,2 +1,2 @@',
      ' a',
      '-b',
      '\\ No newline at end of file',
      '+B',
      '\\ No newline at end of file',
      '--- src/d.ts\t2026-09-28 10:00:00.000000000 +0700',
      '+++ src/d.ts\t2026-09-28 10:05:00.000000000 +0700',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
    ].join('\r\n')

    expect(ranges(diff)).toEqual({
      'src/café.ts': [{ start: 2, end: 2 }],
      'src/d.ts': [{ start: 2, end: 2 }],
    })
  })
})

describe('parseCypherTable', () => {
  const footer = '\n---\nNext: To explore a result symbol in depth, run gitnexus-context "<name>"'

  it('reads rows by column name and keeps empty cells in place', () => {
    const markdown = '| id | name | step |\n| --- | --- | --- |\n| a |  | 1 |\n| b | B | 2 |'
    const rows = parseCypherTable({ raw: JSON.stringify({ markdown, row_count: 2 }) + footer })
    expect(rows).toEqual([
      { id: 'a', name: '', step: '1' },
      { id: 'b', name: 'B', step: '2' },
    ])
  })

  it('reads the zero-rows sentence as no rows', () => {
    expect(parseCypherTable({ raw: 'Query returned 0 rows.' + footer })).toEqual([])
  })

  it('throws on an error answer instead of reading it as no rows', () => {
    // GitNexus answers a failed query with HTTP 200 and this body.
    expect(() => parseCypherTable({ raw: 'Error: Prepare failed: Parser exception: Invalid input' + footer }))
      .toThrow(/Parser exception/)
    expect(() => parseCypherTable({ nothing: 'here' })).toThrow()
  })
})

// ── analyzeDiff against a small fake graph ──

type FakeNode = { id: string; name: string; type: string; filePath: string; startLine: number; endLine: number }

const NODES: FakeNode[] = [
  { id: 'Function:src/a.ts:alpha', name: 'alpha', type: 'Function', filePath: 'src/a.ts', startLine: 1, endLine: 9 },
  { id: 'Function:src/a.ts:beta', name: 'beta', type: 'Function', filePath: 'src/a.ts', startLine: 10, endLine: 20 },
  { id: 'Function:src/a.ts:gamma', name: 'gamma', type: 'Function', filePath: 'src/a.ts', startLine: 21, endLine: 30 },
  // Same relative path under another root: only used when the exact path has nothing.
  { id: 'Function:vendor/src/a.ts:alpha', name: 'alpha', type: 'Function', filePath: 'vendor/src/a.ts', startLine: 1, endLine: 30 },
]
const STEPS = [
  { nodeId: 'Function:src/a.ts:beta', pid: 'proc_1', label: 'HandleLogin → Beta', processType: 'cross_community', stepCount: 4, step: 2 },
  { nodeId: 'Function:src/a.ts:beta', pid: 'proc_2', label: 'Refresh → Beta', processType: 'intra_community', stepCount: 3, step: 3 },
  { nodeId: 'Function:src/a.ts:gamma', pid: 'proc_2', label: 'Refresh → Beta', processType: 'intra_community', stepCount: 3, step: 1 },
]

function table(rows: Array<Record<string, string | number>>) {
  if (rows.length === 0) return { raw: 'Query returned 0 rows.\n---\nNext: ...' }
  const header = Object.keys(rows[0] as object)
  const markdown = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${header.map((h) => String(r[h] ?? '')).join(' | ')} |`),
  ].join('\n')
  return { raw: `${JSON.stringify({ markdown, row_count: rows.length }, null, 2)}\n---\nNext: ...` }
}

function fakeGraph(fail?: (query: string) => boolean): { run: RunCypher; queries: string[] } {
  const queries: string[] = []
  const run: RunCypher = async (query) => {
    queries.push(query)
    if (fail?.(query)) return { raw: 'Error: Runtime exception: something broke\n---\nNext: ...' }
    if (query.includes('STEP_IN_PROCESS')) {
      return table(STEPS.filter((s) => query.includes(`"${s.nodeId}"`)))
    }
    const file = /n\.filePath = "((?:[^"\\]|\\.)*)"/.exec(query)?.[1]?.replace(/\\(.)/g, '$1')
    return table(NODES.filter((n) => n.filePath === file || n.filePath.endsWith(`/${file}`)))
  }
  return { run, queries }
}

const editBeta = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -15 +15 @@',
  '-old',
  '+new',
].join('\n')

describe('analyzeDiff', () => {
  it('finds the symbols that cover a changed line and the flows they are steps of', async () => {
    const { run } = fakeGraph()
    const impact = await analyzeDiff(editBeta, run)

    expect(impact.changed_symbols.map((s) => s.name)).toEqual(['beta'])
    expect(impact.changed_symbols[0]?.filePath).toBe('src/a.ts')
    expect(impact.affected_processes.map((p) => p.id).sort()).toEqual(['proc_1', 'proc_2'])
    expect(impact.summary).toMatchObject({ changed_count: 1, affected_count: 2, risk_level: 'medium', files: 1 })
    expect(impact.partial).toBeUndefined()
  })

  it('reports an unknown risk, never a low one, when a graph query fails', async () => {
    const { run } = fakeGraph((q) => q.includes('STEP_IN_PROCESS'))
    const impact = await analyzeDiff(editBeta, run)

    expect(impact.partial).toBe(true)
    expect(impact.summary.risk_level).toBe('unknown')
    expect(impact.summary.message).toMatch(/lower bound/)
  })

  it('lists new files and files with nothing indexed without calling them safe by omission', async () => {
    const diff = [
      'diff --git a/src/new.ts b/src/new.ts',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1 @@',
      '+x',
      'diff --git a/README.md b/README.md',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n')
    const { run, queries } = fakeGraph()
    const impact = await analyzeDiff(diff, run)

    expect(impact.summary.new_files).toEqual(['src/new.ts'])
    expect(impact.summary.files_without_symbols).toEqual(['README.md'])
    expect(impact.summary).toMatchObject({ files: 2, changed_count: 0, risk_level: 'low' })
    // The new file is not looked up: the graph cannot have it yet.
    expect(queries.some((q) => q.includes('src/new.ts'))).toBe(false)
  })

  it('tells an empty diff from one it could not read', async () => {
    const { run, queries } = fakeGraph()

    const empty = await analyzeDiff('', run)
    expect(empty.summary.risk_level).toBe('none')
    expect(empty.partial).toBeUndefined()

    const garbage = await analyzeDiff('this is not a diff', run)
    expect(garbage.summary.risk_level).toBe('unknown')
    expect(garbage.partial).toBe(true)

    expect(queries).toEqual([])
  })

  it('prefers the exact path over a suffix match under another root', async () => {
    const { run } = fakeGraph()
    const impact = await analyzeDiff(editBeta, run)
    expect(impact.changed_symbols.every((s) => s.filePath === 'src/a.ts')).toBe(true)
  })

  it('escapes paths from the diff before they reach a query', async () => {
    const diff = [
      'diff --git a/src/x.ts b/src/x.ts',
      '--- "a/src/we\\"ird\\\\.ts"',
      '+++ "b/src/we\\"ird\\\\.ts"',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n')
    const { run, queries } = fakeGraph()
    await analyzeDiff(diff, run)

    expect(queries[0]).toContain('n.filePath = "src/we\\"ird\\\\.ts"')
  })
})
