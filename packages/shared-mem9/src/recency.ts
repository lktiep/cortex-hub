/**
 * Recency blend for memory search results.
 *
 * A search score is mostly relevance with a little age mixed in. Session
 * summaries are the exception: the latest one is what a new session wants, so
 * age counts for half and decays with a two-day half-life.
 *
 * Apply it exactly once per result. `Mem9.search` already returns blended
 * scores; blending them again squares the age penalty and lets an old but
 * relevant memory sink below a fresh irrelevant one.
 */

import type { MemoryItem } from './types.js'

const DAY_MS = 1000 * 60 * 60 * 24

/** Memories older than this get no recency credit at all. */
const MEMORY_RECENCY_DAYS = 90
/** Decay constant for session summaries, in days. */
const SESSION_DECAY_DAYS = 2

export function isSessionSummary(m: Pick<MemoryItem, 'metadata'>): boolean {
  return m.metadata?.['type'] === 'session-summary'
}

/** Returns `m` with its score replaced by the relevance/recency blend. */
export function blendRecency<T extends MemoryItem>(m: T, now = Date.now()): T {
  const time = m.createdAt ? new Date(m.createdAt).getTime() : 0
  const ageInDays = Math.max(0, (now - (Number.isNaN(time) ? 0 : time)) / DAY_MS)

  const session = isSessionSummary(m)
  const recency = session
    ? Math.exp(-ageInDays / SESSION_DECAY_DAYS)
    : Math.max(0, 1 - ageInDays / MEMORY_RECENCY_DAYS)
  const weightRecency = session ? 0.5 : 0.1

  return { ...m, score: (m.score ?? 0) * (1 - weightRecency) + recency * weightRecency }
}

/** Sorts best first, in place, and returns the same array. */
export function byScore<T extends Pick<MemoryItem, 'score'>>(memories: T[]): T[] {
  return memories.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
}
