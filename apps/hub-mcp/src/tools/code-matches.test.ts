import { describe, it, expect } from 'vitest'
import { formatCodeMatches, formatOtherRepos, trimChunk, SNIPPET_CHARS, outlineFiles, outlineQuery, parseOutline, hitSymbols } from './code-matches.js'

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
    expect(out).toContain('Read just those lines')
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

describe('the symbols the hits fall in', () => {
  const sym = (name: string, start: number, end: number, type = 'Function') => ({ file: 'a.ts', name, type, start, end })

  it('takes the best five files of the repo searched, once each', () => {
    const files = outlineFiles([
      { score: 0.9, filePath: 'a.ts' }, { score: 0.8, filePath: 'a.ts' }, { score: 0.7, filePath: 'x.ts', repo: 'other' },
      ...['b', 'c', 'd', 'e', 'f'].map((f, i) => ({ score: 0.6 - i / 10, filePath: `${f}.ts` })),
    ])
    expect(files).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'])
  })

  it('asks for one file\'s symbols, with its path quoted', () => {
    expect(outlineQuery("it's.ts")).toContain("n.filePath = 'it\\'s.ts'")
    expect(outlineQuery('a.ts')).toContain("labels(n) IN ['Function', 'Method'")
  })

  it('reads the cypher table', () => {
    const rows = parseOutline('| file | name | type | s | e |\n| --- | --- | --- | --- | --- |\n' +
      '| b.ts | helper | Function | 1 | 9 |\n| a.ts | run | Function | 4 | 20 |\n(2 rows)\n---\nNext: …')
    expect(rows).toEqual([
      { file: 'b.ts', name: 'helper', type: 'Function', start: 1, end: 9 },
      { file: 'a.ts', name: 'run', type: 'Function', start: 4, end: 20 },
    ])
  })

  it('names the innermost symbol a hit falls in, not the class around it', () => {
    const symbols = [sym('Api', 1, 200, 'Class'), sym('get', 10, 30, 'Method'), sym('put', 40, 60, 'Method'), sym('KEY', 12, 12, 'Const')]
    expect(hitSymbols(symbols, [[15, 25]])).toBe('get L10-30')
    expect(hitSymbols(symbols, [[25, 45]])).toBe('get L10-30, put L40-60')
    expect(hitSymbols(symbols, [[100, 120]])).toBe('Api L1-200')
  })

  it('caps the list and says how many it left out', () => {
    const symbols = Array.from({ length: 5 }, (_, i) => sym(`f${i}`, i * 10, i * 10 + 5))
    expect(hitSymbols(symbols, [[0, 50]])).toBe('f0 L0-5, f1 L10-15, f2 L20-25, +2 more')
  })

  it('says nothing when no hit falls in a symbol', () => {
    expect(hitSymbols([sym('far', 300, 320)], [[1, 30]])).toBe('')
    expect(hitSymbols([], [[1, 30]])).toBe('')
  })

  it('puts them on the file\'s line', () => {
    const out = formatCodeMatches([{ score: 0.5, filePath: 'a.ts', startLine: 15, endLine: 25 }], 0, [sym('get', 10, 30)])
    expect(out).toContain('1. a.ts — L15-25 50% · in get L10-30')
    expect(out).toContain('cortex_code_context')
  })
})
