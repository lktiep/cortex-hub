import { describe, it, expect, afterEach, vi } from 'vitest'
import { Embedder, EMBED_PRIORITY_HEADER } from './embedder.js'

const config = { provider: 'openai' as const, apiKey: '', model: 'auto', gatewayUrl: 'http://api:4000/api/llm' }

/** Answers every embedding request with one vector per input, recording the headers. */
function gateway() {
  const headers: Array<Record<string, string>> = []
  const fetchMock = vi.fn(async (_url: string, init: { headers: Record<string, string>; body: string }) => {
    headers.push(init.headers)
    const { input } = JSON.parse(init.body) as { input: string | string[] }
    const texts = Array.isArray(input) ? input : [input]
    return Response.json({ data: texts.map((_, index) => ({ embedding: [1, 2, 3], index })) })
  })
  vi.stubGlobal('fetch', fetchMock)
  return headers
}

describe('Embedder priority', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('marks every request of a background embedder for the background lane', async () => {
    const headers = gateway()
    const embedder = new Embedder(config, [], { priority: 'background' })
    await embedder.embed('one')
    await embedder.embedBatch(['two', 'three'])
    expect(headers).toHaveLength(2)
    expect(headers.every((h) => h[EMBED_PRIORITY_HEADER] === 'background')).toBe(true)
  })

  it('sends no priority by default, so the gateway treats it as a query', async () => {
    const headers = gateway()
    await new Embedder(config).embed('one')
    await new Embedder(config, [], { priority: 'query' }).embedBatch(['two', 'three'])
    expect(headers.map((h) => h[EMBED_PRIORITY_HEADER])).toEqual([undefined, undefined])
  })
})
