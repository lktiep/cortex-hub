import { describe, it, expect } from 'vitest'
import { appendHintBlocks, canAppendHints, noteLines, NOTE_LINES } from './hint-blocks.js'

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

  it('puts file notes before the hints', () => {
    expect(appendHintBlocks('x', ['h1'], [], ['a.ts [risk] r'])).toBe(
      'x\n\n---\n📌 Known notes on these files:\n  a.ts [risk] r\n\n---\n💡 Cortex hints:\n  h1',
    )
  })
})

describe('noteLines', () => {
  const note = (id: string, title = `t-${id}`, note = '') => ({ id, title, kind: 'risk', note })

  it('shows each note once, under the first path that has it', () => {
    expect(noteLines({ 'a.ts': [note('1', 'Locks', 'take the lock first')], 'b.ts': [note('1'), note('2')] })).toEqual([
      'a.ts [risk] Locks — take the lock first',
      'b.ts [risk] t-2',
    ])
  })

  it('caps the lines and their length', () => {
    const many = Array.from({ length: 20 }, (_, i) => note(String(i), 'x'.repeat(300)))
    const lines = noteLines({ 'a.ts': many })
    expect(lines).toHaveLength(NOTE_LINES)
    expect(lines.every((l) => l.length <= 200 && l.endsWith('…'))).toBe(true)
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
