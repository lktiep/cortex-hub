import { describe, it, expect } from 'vitest'
import { blendRecency, byScore } from './recency.js'
import type { MemoryItem } from './types.js'

const NOW = Date.parse('2026-09-28T12:00:00Z')
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString()

const memory = (score: number, age: number, type?: string): MemoryItem => ({
  id: `${type ?? 'fact'}-${age}`,
  memory: 'x',
  hash: '',
  score,
  createdAt: daysAgo(age),
  updatedAt: daysAgo(age),
  metadata: type ? { type } : undefined,
})

describe('blendRecency', () => {
  it('mixes one tenth of linear 90-day recency into an ordinary memory', () => {
    expect(blendRecency(memory(0.6, 0), NOW).score).toBeCloseTo(0.9 * 0.6 + 0.1, 6)
    expect(blendRecency(memory(0.6, 45), NOW).score).toBeCloseTo(0.9 * 0.6 + 0.05, 6)
    expect(blendRecency(memory(0.6, 200), NOW).score).toBeCloseTo(0.9 * 0.6, 6)
  })

  it('weighs a session summary half on age, decaying over days', () => {
    expect(blendRecency(memory(1, 0, 'session-summary'), NOW).score).toBeCloseTo(1, 6)
    expect(blendRecency(memory(1, 2, 'session-summary'), NOW).score).toBeCloseTo(0.5 + 0.5 * Math.exp(-1), 6)
  })

  it('gives a memory with no timestamp no recency credit', () => {
    const m = { ...memory(0.5, 0), createdAt: '' }
    expect(blendRecency(m, NOW).score).toBeCloseTo(0.45, 6)
  })

  it('leaves the rest of the memory untouched', () => {
    const m = memory(0.5, 3, 'note')
    expect(blendRecency(m, NOW)).toEqual({ ...m, score: expect.any(Number) })
    expect(m.score).toBe(0.5)
  })

  it('is not idempotent, which is why it must run once per result', () => {
    // Blending an already-blended score drags an old relevant memory under a new weak one.
    const oldRelevant = memory(0.8, 60)
    const newWeak = memory(0.72, 0)
    const once = byScore([oldRelevant, newWeak].map((m) => blendRecency(m, NOW)))
    expect(once[0]!.id).toBe(oldRelevant.id)
    const twice = byScore(once.map((m) => blendRecency(m, NOW)))
    expect(twice[0]!.id).toBe(newWeak.id)
  })
})
