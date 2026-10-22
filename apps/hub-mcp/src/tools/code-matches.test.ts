import { describe, it, expect } from 'vitest'
import { formatCodeMatches, formatOtherRepos, trimChunk, SNIPPET_CHARS, outlineFiles, outlineQuery, parseOutline, formatOutline } from './code-matches.js'

describe('trimChunk', () => {
  it('drops the indexer header of a first chunk', () => {
    expect(trimChunk('// File: src/a.ts\nimport x from "x"\n')).toBe('import x from "x"')
  })

  it('starts a later chunk at its first whole line', () => {
    expect(trimChunk('ress ?? remote\n  const ok = true\n')).toBe('  const ok = true')
  })

  it('cuts a long chunk at a line end', () => {
    const line = 'x'.repeat(99)
    const text = trimChunk(`// File: a.ts\n${Array(40).fill(line).join('\n')}`)
    expect(text.length).toBeLessThanOrEqual(SNIPPET_CHARS + 2)
    expect(text.endsWith(`${line}\n…`)).toBe(true)
  })
})

describe('formatCodeMatches', () => {
  const matches = [
    { score: 0.538, filePath: 'src/lib/api-auth.ts', chunkIndex: 3, startLine: 40, endLine: 80, content: '// File: src/lib/api-auth.ts\nexport function lookupApiKey() {}' },
    { score: 0.5, filePath: 'src/routes/keys.ts', chunkIndex: 2, content: 'tail\nkeysRouter.post("/verify")' },
    { score: 0.4, filePath: 'src/routes/keys.ts', chunkIndex: 3, content: 'tail\nkeysRouter.put("/:id")' },
    { score: 0.37, filePath: 'src/lib/api-auth.ts', chunkIndex: 0, content: 'x' },
    { score: 0.33, filePath: 'bench/gold.ts', chunkIndex: 1, content: 'x' },
  ]

  it('lists each file once, in the order its best chunk ranked', () => {
    const out = formatCodeMatches(matches)
    expect(out).toContain('1. src/lib/api-auth.ts — L40-80 54%, 37%\n2. src/routes/keys.ts — 50%, 40%\n3. bench/gold.ts — 33%')
  })

  it('shows code for the top three chunks only', () => {
    const out = formatCodeMatches(matches)
    expect(out.match(/^### /gm)).toHaveLength(3)
    expect(out).toContain('### src/routes/keys.ts\n```typescript\nkeysRouter.put("/:id")\n```')
    expect(out).not.toContain('// File:')
    expect(out).toContain('### src/lib/api-auth.ts:40-80\n')
    expect(out).toContain('read just those lines')
  })

  it('says nothing when there is nothing to show', () => {
    expect(formatCodeMatches([])).toBe('')
    expect(formatCodeMatches([{ score: 0.9 }])).toBe('')
  })
})

describe('formatOtherRepos', () => {
  const m = (repo: string, filePath: string, score: number) => ({ repo, filePath, score })

  it('gives each repo one line of its best two files, and no repo more than that', () => {
    const text = formatOtherRepos([
      m('big', 'a.ts', 0.6), m('big', 'b.ts', 0.59), m('big', 'c.ts', 0.58), m('small', 'd.ts', 0.4),
    ])

    expect(text).toContain('- big — a.ts 60%, b.ts 59%\n- small — d.ts 40%')
    expect(text).not.toContain('c.ts')
  })

  it('lists five repos at most', () => {
    const text = formatOtherRepos(['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].map((r, i) => m(r, 'x.ts', 0.6 - i / 100)))

    expect(text).toContain('- r5 —')
    expect(text).not.toContain('- r6 —')
  })
})

describe('outline of the top files', () => {
  it('takes the best three files of the repo searched, once each', () => {
    const files = outlineFiles([
      { score: 0.9, filePath: 'a.ts' }, { score: 0.8, filePath: 'a.ts' }, { score: 0.7, filePath: 'x.ts', repo: 'other' },
      { score: 0.6, filePath: 'b.ts' }, { score: 0.5, filePath: 'c.ts' }, { score: 0.4, filePath: 'd.ts' },
    ])
    expect(files).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })

  it('quotes paths so one cannot end the list', () => {
    expect(outlineQuery(["it's.ts"])).toContain("['it\\'s.ts']")
  })

  it('reads the cypher table and lists functions with their lines, in file rank order', () => {
    const rows = parseOutline('| file | name | type | s | e |\n| --- | --- | --- | --- | --- |\n' +
      '| b.ts | helper | Function | 1 | 9 |\n| a.ts | KEY | Const | 2 | 2 |\n| a.ts | run | Function | 4 | 20 |\n(3 rows)\n---\nNext: …')
    expect(rows).toHaveLength(3)
    expect(formatOutline(rows, ['a.ts', 'b.ts'])).toContain('- a.ts: run L4-20\n- b.ts: helper L1-9')
  })

  it('caps a long file and says how many it left out', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ file: 'a.ts', name: `f${i}`, type: 'Function', start: i * 10, end: i * 10 + 5 }))
    expect(formatOutline(rows, ['a.ts'])).toContain('f9 L90-95, +2 more')
  })

  it('says nothing when the graph has no symbols there', () => {
    expect(formatOutline([], ['a.ts'])).toBe('')
  })
})
