import { describe, it, expect } from 'vitest'
import { formatDiffImpact } from './diff-impact.js'

describe('formatDiffImpact', () => {
  it('prints a pre-commit check as lines', () => {
    const data = {
      success: true,
      data: {
        summary: {
          changed_count: 1, affected_count: 1, risk_level: 'low', files: 2,
          new_files: ['src/new.ts'], files_without_symbols: ['README.md'],
        },
        changed_symbols: [
          { id: 'Function:src/a.ts:boot', name: 'boot', type: 'Function', filePath: 'src/a.ts', startLine: 4, endLine: 9 },
        ],
        affected_processes: [
          { id: 'p1', name: 'Startup', process_type: 'flow', step_count: 3, changed_steps: [{ symbol: 'boot', step: 1 }] },
        ],
        repo: 'app',
      },
    }

    expect(formatDiffImpact(data).split('\n')).toEqual([
      'Risk: low — 1 changed symbol(s) in 2 file(s), 1 affected flow(s)',
      '',
      'Changed:',
      '  Function boot → src/a.ts:4-9',
      '',
      'Affected flows:',
      '  Startup (via boot)',
      '',
      'New files, not in the graph yet: src/new.ts',
      '',
      'No indexed symbol on a changed line: README.md',
    ])
  })

  it('says when a lookup failed, and leaves another shape as JSON', () => {
    const partial = {
      data: {
        summary: { changed_count: 0, affected_count: 0, risk_level: 'unknown', files: 1 },
        changed_symbols: [], affected_processes: [], partial: true,
      },
    }

    expect(formatDiffImpact(partial)).toBe('Risk: unknown — 0 changed symbol(s) in 1 file(s), 0 affected flow(s) (a lookup failed: lists are a lower bound)')
    expect(formatDiffImpact({ data: { raw: 'x' } })).toBe(JSON.stringify({ data: { raw: 'x' } }, null, 2))
  })
})
