import { describe, it, expect, vi } from 'vitest'
import { rerankByRelevance, type TypeSafeClient } from './typesafe.js'

/**
 * A client that answers every ranking question from a fixed preference list.
 * `calls` records what it was asked, because the whole point of the listwise
 * rewrite is that a search costs one call rather than one per candidate.
 */
function fakeClient(order: (ids: string[]) => string[]) {
  const calls: Array<Record<string, unknown>> = []
  const client = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stands in for the client's untyped question tree
    async systemOne(state: unknown, questions: Record<string, any>) {
      calls.push({ state, questions })
      const ids = Object.keys(questions.best.criteria)
      const ranked = order(ids)
      const probabilities: Record<string, number> = {}
      ranked.forEach((id, i) => {
        probabilities[id] = 1 - i / (ranked.length + 1)
      })
      return {
        model: 'fake',
        answers: { best: { type: 'choice', choice: ranked[0], confidence: 0.9, probabilities } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }
    },
  }
  return { client: client as unknown as TypeSafeClient, calls }
}

const cand = (n: number, scores?: number[]) =>
  Array.from({ length: n }, (_, i) => ({
    item: i,
    text: `candidate ${i}`,
    // Descending retrieval scores, the order Qdrant would hand over.
    score: scores?.[i] ?? 1 - i * 0.01,
  }))

describe('rerankByRelevance', () => {
  it('asks one question about the whole pool', async () => {
    const { client, calls } = fakeClient((ids) => ids)
    await rerankByRelevance(client, 'q', cand(30))
    expect(calls).toHaveLength(1)
    const questions = calls[0]!.questions as { best: { criteria: Record<string, unknown> } }
    expect(Object.keys(questions.best.criteria)).toHaveLength(30)
  })

  it('puts the reranker’s pick first even when it was retrieved last', async () => {
    // Reverse the list: the worst vector hit becomes the best answer.
    const { client } = fakeClient((ids) => [...ids].reverse())
    const out = await rerankByRelevance(client, 'q', cand(10))
    expect(out[0]!.item).toBe(9)
    expect(out[0]!.relevance).toBe(1)
    expect(out.at(-1)!.item).toBe(0)
  })

  it('keeps the vector score as a tie-break only, never a reordering', async () => {
    // A pool wide enough that a blended cosine score would outrun a rank gap:
    // 100 candidates means gap 0.01, while the vector scores span 0.5.
    const scores = Array.from({ length: 100 }, (_, i) => 1 - i * 0.005)
    const { client } = fakeClient((ids) => [...ids].reverse())
    const out = await rerankByRelevance(client, 'q', cand(100, scores), { weight: 0.9 })
    expect(out.map((r) => r.item)).toEqual(cand(100).map((_, i) => 99 - i))
  })

  it('falls back to retrieval order when the call fails', async () => {
    const onError = vi.fn()
    const client = {
      systemOne: async () => {
        throw new Error('529 overloaded')
      },
    } as unknown as TypeSafeClient
    const out = await rerankByRelevance(client, 'q', cand(5), { onError })
    expect(out.map((r) => r.item)).toEqual([0, 1, 2, 3, 4])
    expect(out.every((r) => r.relevance === null)).toBe(true)
    expect(out.map((r) => r.retrievalScore)).toEqual(cand(5).map((c) => c.score))
    expect(onError).toHaveBeenCalledOnce()
  })

  it('spends no call on a pool it cannot order', async () => {
    const { client, calls } = fakeClient((ids) => ids)
    const one = await rerankByRelevance(client, 'q', cand(1))
    expect(calls).toHaveLength(0)
    expect(one).toHaveLength(1)
    expect(await rerankByRelevance(client, 'q', [])).toEqual([])
  })

  it('ranks a pool larger than roundSize in rounds', async () => {
    const { client, calls } = fakeClient((ids) => [...ids].reverse())
    const out = await rerankByRelevance(client, 'q', cand(10), { roundSize: 4 })
    // 4 + 4 + 2 candidates, so three calls, each ordering its own slice.
    expect(calls).toHaveLength(3)
    expect(out).toHaveLength(10)
    expect(out.every((r) => r.relevance !== null)).toBe(true)
    // Within a round the order is reversed; the winners of each round lead.
    expect(out.slice(0, 3).map((r) => r.item).sort((a, b) => a - b)).toEqual([3, 7, 9])
  })

  it('leaves the tail past maxCandidates in retrieval order, below what was ranked', async () => {
    const { client } = fakeClient((ids) => [...ids].reverse())
    const out = await rerankByRelevance(client, 'q', cand(8), { maxCandidates: 4 })
    expect(out.slice(0, 4).map((r) => r.item)).toEqual([3, 2, 1, 0])
    expect(out.slice(4).map((r) => r.item)).toEqual([4, 5, 6, 7])
    expect(out.slice(4).every((r) => r.relevance === null)).toBe(true)
  })

  it('keeps a candidate the reranker omitted instead of dropping it', async () => {
    // Jev is free to leave an option out of its distribution; a missing id must
    // not delete a retrieved result.
    const { client } = fakeClient((ids) => ids.filter((id) => id !== 'c2'))
    const out = await rerankByRelevance(client, 'q', cand(4))
    expect(out).toHaveLength(4)
    const omitted = out.find((r) => r.item === 1)!
    expect(omitted.relevance).toBeNull()
  })
})
