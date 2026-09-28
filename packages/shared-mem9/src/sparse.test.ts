import { describe, it, expect } from 'vitest'
import {
  tokenizeCode,
  tokenizeText,
  hashToken,
  documentSparseVector,
  querySparseVector,
  averageTokenLength,
} from './sparse.js'

describe('tokenizeCode', () => {
  it('keeps an identifier and its parts, so both queries find it', () => {
    expect(tokenizeCode('resolveRepoNames')).toEqual([
      'resolvereponames',
      'resolve',
      'repo',
      'names',
    ])
  })

  it('splits snake_case', () => {
    expect(tokenizeCode('file_path')).toEqual(['file_path', 'file', 'path'])
  })

  it('keeps an acronym run whole', () => {
    expect(tokenizeCode('parseHTTPResponse')).toEqual([
      'parsehttpresponse',
      'parse',
      'http',
      'response',
    ])
  })

  it('drops punctuation, single characters and bare numbers', () => {
    expect(tokenizeCode('const x = items[0].map((i) => i * 2)')).toEqual([
      'const',
      'items',
      'map',
    ])
  })

  it('is case-insensitive', () => {
    expect(tokenizeCode('Qdrant')).toEqual(tokenizeCode('qdrant'))
  })
})

describe('hashToken', () => {
  it('is stable, so an index written today is queryable tomorrow', () => {
    expect(hashToken('embedder')).toBe(hashToken('embedder'))
  })

  it('stays inside u32, which is what Qdrant indexes by', () => {
    for (const token of ['a', 'embedder', 'resolvereponames', 'ünïcödé', '']) {
      const hash = hashToken(token)
      expect(Number.isInteger(hash)).toBe(true)
      expect(hash).toBeGreaterThanOrEqual(0)
      expect(hash).toBeLessThanOrEqual(0xffffffff)
    }
  })

  it('separates different terms', () => {
    expect(hashToken('embed')).not.toBe(hashToken('embedder'))
  })
})

describe('documentSparseVector', () => {
  it('emits one weight per distinct term', () => {
    const vec = documentSparseVector('embed embed query', 3)
    expect(vec.indices).toHaveLength(2)
    expect(vec.values).toHaveLength(2)
    expect(new Set(vec.indices).size).toBe(2)
  })

  it('saturates: the second occurrence is worth less than the first', () => {
    const avg = 4
    const once = documentSparseVector('alpha beta gamma delta', avg)
    const twice = documentSparseVector('alpha alpha beta gamma', avg)
    const weightOf = (v: { indices: number[]; values: number[] }, token: string) =>
      v.values[v.indices.indexOf(hashToken(token))]!

    const first = weightOf(once, 'alpha')
    const second = weightOf(twice, 'alpha')
    expect(second).toBeGreaterThan(first)
    expect(second).toBeLessThan(first * 2)
  })

  it('holds length against a document: the same term scores lower in a longer one', () => {
    const avg = 5
    const short = documentSparseVector('alpha beta', avg)
    const long = documentSparseVector('alpha beta gamma delta epsilon zeta eta theta', avg)
    const weightOf = (v: { indices: number[]; values: number[] }) =>
      v.values[v.indices.indexOf(hashToken('alpha'))]!
    expect(weightOf(long)).toBeLessThan(weightOf(short))
  })

  it('survives an empty corpus average instead of dividing by zero', () => {
    const vec = documentSparseVector('alpha beta', 0)
    expect(vec.values.every((v) => Number.isFinite(v) && v > 0)).toBe(true)
  })

  it('returns an empty vector for text with nothing searchable in it', () => {
    expect(documentSparseVector('{ } ; ( ) 42', 10)).toEqual({ indices: [], values: [] })
  })
})

describe('querySparseVector', () => {
  it('weighs every term the same and lets Qdrant supply the IDF', () => {
    const vec = querySparseVector('embed the query embed')
    expect(vec.values.every((v) => v === 1)).toBe(true)
  })

  it('deduplicates repeated terms', () => {
    const vec = querySparseVector('embed embed embed')
    expect(vec.indices).toHaveLength(new Set(vec.indices).size)
  })

  it('lines up with the document side on the same term', () => {
    const doc = documentSparseVector('resolveRepoNames', 2)
    const query = querySparseVector('repo names')
    expect(query.indices.every((i) => doc.indices.includes(i))).toBe(true)
  })
})

describe('averageTokenLength', () => {
  it('averages token counts, not character counts', () => {
    expect(averageTokenLength(['alpha beta', 'gamma delta epsilon zeta'])).toBe(3)
  })

  it('is 0 for an empty corpus', () => {
    expect(averageTokenLength([])).toBe(0)
  })
})

describe('tokenizeText', () => {
  it('keeps Vietnamese words whole, and folded so they match text typed without accents', () => {
    expect(tokenizeText('Đơn hàng bị treo')).toEqual(['đơn', 'don', 'hàng', 'hang', 'bị', 'bi', 'treo'])
  })

  it('matches accented text from an unaccented query', () => {
    const stored = new Set(tokenizeText('Đơn hàng bị treo ở trạng thái pending'))
    expect(tokenizeText('don hang bi treo pending').every((t) => stored.has(t))).toBe(true)
  })

  it('treats composed and decomposed accents as the same word', () => {
    expect(tokenizeText('tiếng'.normalize('NFD'))).toEqual(tokenizeText('tiếng'.normalize('NFC')))
  })

  it('still breaks identifiers into their parts', () => {
    expect(tokenizeText('cart_v2_enabled')).toEqual(['cart_v2_enabled', 'cart', 'v2', 'enabled'])
    expect(tokenizeText('OrderService.cancelOrder')).toEqual([
      'orderservice',
      'order',
      'service',
      'cancelorder',
      'cancel',
      'order',
    ])
  })

  it('keeps numbers, which in a memory are facts', () => {
    expect(tokenizeText('Postgres on 5433, not 5432')).toEqual(['postgres', 'on', '5433', 'not', '5432'])
  })

  it('drops single characters and punctuation', () => {
    expect(tokenizeText('a ? b - 7')).toEqual([])
  })
})
