import { describe, expect, it } from 'vitest'
import { EXCERPT_CHARS, formatKnowledgeDocument, formatKnowledgeResults, type KnowledgeHit } from './knowledge-format.js'

const long = (word: string) => `${word} `.repeat(400)
const hit = (n: number, extra: Partial<KnowledgeHit> = {}): KnowledgeHit => ({
  documentId: `kdoc-${n}`,
  title: `Doc ${n}`,
  score: 0.9 - n / 10,
  content: long(`body${n}`),
  ...extra,
})

describe('formatKnowledgeResults', () => {
  it('gives each document a heading and a short excerpt, not its whole chunk', () => {
    const text = formatKnowledgeResults('q', [hit(1)])
    expect(text).toContain('### Result 1: Doc 1 (ID: kdoc-1, Score: 0.800)')
    expect(text.length).toBeLessThan(EXCERPT_CHARS + 300)
    expect(text).toContain('cortex_knowledge_search(id: "<ID>")')
  })

  it('lists a document once when several of its chunks match', () => {
    const text = formatKnowledgeResults('q', [hit(1), hit(1, { chunkIndex: 2 }), hit(2)])
    expect(text.match(/^### Result/gm)).toHaveLength(2)
    expect(text).toContain('### Result 2: Doc 2')
  })

  it('stays within the budget by listing later hits by heading only', () => {
    const hits = [1, 2, 3, 4, 5].map((n) => hit(n))
    const text = formatKnowledgeResults('q', hits, 900)
    expect(text.match(/^### Result/gm)).toHaveLength(5)
    expect(text).toContain('body1')
    expect(text).not.toContain('body5')
    expect(text).toMatch(/more listed by heading only/)
    expect(text.length).toBeLessThan(900 + 300)
  })

  it('keeps type, tags and an obsolete flag on the heading', () => {
    const text = formatKnowledgeResults('q', [hit(1, { deprecated: true, document: { tags: '["auth","ws"]', hall_type: 'fact' } })])
    expect(text).toContain('[type: fact; tags: auth, ws; possibly obsolete]')
  })

  it('survives tags that are not JSON', () => {
    expect(() => formatKnowledgeResults('q', [hit(1, { document: { tags: 'auth' } })])).not.toThrow()
  })
})

describe('formatKnowledgeDocument', () => {
  it('joins every chunk in order', () => {
    const text = formatKnowledgeDocument({
      id: 'kdoc-1',
      title: 'Doc',
      chunks: [{ chunk_index: 1, content: 'second' }, { chunk_index: 0, content: 'first' }],
    })
    expect(text).toBe('# Doc (ID: kdoc-1)\n\nfirst\n\nsecond')
  })
})
