import { describe, it, expect } from 'vitest'
import { appendHintBlocks, canAppendHints } from './hint-blocks.js'

describe('appendHintBlocks', () => {
  it('adds a conductor block', () => {
    expect(appendHintBlocks('x', [], ['TT3 ready'])).toBe('x\n\n---\n📋 Conductor:\n  TT3 ready')
  })

  it('adds the hints block before the conductor block', () => {
    expect(appendHintBlocks('x', ['h1', 'h2'], ['c1'])).toBe(
      'x\n\n---\n💡 Cortex hints:\n  h1\n  h2\n\n---\n📋 Conductor:\n  c1',
    )
  })

  it('adds nothing for empty arrays', () => {
    expect(appendHintBlocks('x', [], [])).toBe('x')
  })
})

describe('canAppendHints', () => {
  it('accepts a body whose last content item is text', () => {
    expect(canAppendHints({ result: { content: [{ type: 'image' }, { type: 'text', text: 'a' }] } })).toBe(true)
  })

  it.each([
    ['null', null],
    ['no result', {}],
    ['no content', { result: {} }],
    ['empty content', { result: { content: [] } }],
    ['non-array content', { result: { content: 'x' } }],
    ['last item not text', { result: { content: [{ type: 'text', text: 'a' }, { type: 'image' }] } }],
    ['text not a string', { result: { content: [{ type: 'text', text: 1 }] } }],
  ])('refuses %s', (_name, body) => {
    expect(canAppendHints(body)).toBe(false)
  })
})
