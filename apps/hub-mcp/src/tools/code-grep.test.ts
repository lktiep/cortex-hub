import { describe, it, expect } from 'vitest'
import { formatGrep, HITS_PER_FILE } from './code-grep.js'

describe('formatGrep', () => {
  it('lists hits by repo and file, like rg', () => {
    const text = formatGrep({
      pattern: 'case 144',
      searched: ['server', 'tools', 'docs'],
      results: [
        { repo: 'tools', total: 1, truncated: false, hits: [{ file: 'decoder.py', line: 3, text: '144: "TalkNpc"' }] },
        { repo: 'server', total: 2, truncated: false, hits: [
          { file: 'src/Player.cs', line: 10, text: 'case 144:' },
          { file: 'src/Map.cs', line: 4, text: 'case 144:' },
        ] },
        { repo: 'docs', total: 0, truncated: false, hits: [] },
      ],
    })
    expect(text).toContain('3 line(s) in 2 of 3 repo(s)')
    expect(text).toContain('## tools — 1 line(s)\ndecoder.py:3: 144: "TalkNpc"')
    expect(text).toContain('src/Player.cs:10: case 144:')
    expect(text).not.toContain('## docs')
    expect(text).toContain('cortex_code_read')
  })

  it('counts what it did not list, and names what it could not search', () => {
    const hits = Array.from({ length: HITS_PER_FILE + 3 }, (_, i) => ({ file: 'big.cs', line: i + 1, text: 'x' }))
    const text = formatGrep({
      pattern: 'x',
      results: [{ repo: 'server', total: 40, truncated: true, hits }, { repo: 'tools', total: 0, truncated: false, hits: [], error: 'timed out' }],
      notCloned: ['docs'],
    })
    expect(text).toContain(`## server — 40+ line(s), ${HITS_PER_FILE + 3} shown`)
    expect(text).toContain('big.cs: … 3 more')
    expect(text).toContain('Not searched: tools (timed out)')
    expect(text).toContain('No checkout on the hub yet: docs')
    expect(text).toContain('narrow with path')
  })

  it('names files with a count each when asked for files', () => {
    const text = formatGrep({
      pattern: 'encrypt|cipher',
      filesOnly: true,
      searched: ['china', 'tools'],
      results: [
        { repo: 'china', total: 2, truncated: false, hits: [], files: [{ file: 'Network/NetState.cs', count: 1 }, { file: 'clsWorld.cs', count: 2 }] },
        { repo: 'tools', total: 90, truncated: false, hits: [], files: [{ file: 'a.py', count: 4 }] },
      ],
    })
    expect(text).toContain('92 file(s) in 2 of 2 repo(s)')
    expect(text).toContain('## china — 2 file(s)\nNetwork/NetState.cs (1)\nclsWorld.cs (2)')
    expect(text).toContain('## tools — 90 file(s), 1 shown\na.py (4)')
    expect(text).toContain('path: file')
  })

  it('says no match plainly', () => {
    expect(formatGrep({ pattern: 'nope', searched: ['a', 'b'], results: [] })).toBe('grep "nope": no match in 2 repo(s), on each repo\'s default branch.')
  })
})
