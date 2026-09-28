import { describe, it, expect } from 'vitest'
import { fuseByRank, RRF_K } from './fusion.js'
import type { QdrantSearchResult } from './types.js'

const arm = (...ids: string[]): QdrantSearchResult[] =>
  ids.map((id, i) => ({ id, score: 100 - i, payload: { memory: id } }))

describe('fuseByRank', () => {
  it('puts what both arms found first, scored 1 when both ranked it first', () => {
    const fused = fuseByRank([arm('a', 'b'), arm('a', 'c')])

    expect(fused.map((h) => h.id)).toEqual(['a', 'b', 'c'])
    expect(fused[0]!.score).toBe(1)
  })

  it('ranks by position, not by the arms\' incomparable scores', () => {
    const dense = [{ id: 'x', score: 0.9, payload: {} }]
    const lexical = [{ id: 'y', score: 42, payload: {} }, { id: 'x', score: 1, payload: {} }]

    expect(fuseByRank([dense, lexical]).map((h) => h.id)).toEqual(['x', 'y'])
  })

  it('keeps every score in [0, 1]', () => {
    const fused = fuseByRank([arm('a', 'b', 'c'), arm('c', 'd')])
    for (const { score } of fused) {
      expect(score).toBeGreaterThan(0)
      expect(score).toBeLessThanOrEqual(1)
    }
  })

  it('normalises by the arms that answered, so one arm alone still tops out at 1', () => {
    const fused = fuseByRank([arm('a', 'b'), []])

    expect(fused[0]!.score).toBe(1)
    expect(fused[1]!.score).toBeCloseTo((RRF_K + 1) / (RRF_K + 2))
  })

  it('returns nothing when neither arm did', () => {
    expect(fuseByRank([[], []])).toEqual([])
  })

  it('leaves the arms it was given unchanged', () => {
    const dense = arm('a')
    fuseByRank([dense, arm('a')])

    expect(dense[0]!.score).toBe(100)
  })
})
