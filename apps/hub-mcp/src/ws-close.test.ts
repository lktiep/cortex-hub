import { describe, it, expect } from 'vitest'
import { forwardCloseCode } from './ws-close.js'

describe('forwardCloseCode', () => {
  it.each([1000, 1001, 1008, 1011, 3000, 4000, 4009, 4999])('keeps %i', (code) => {
    expect(forwardCloseCode(code)).toBe(code)
  })

  it('maps 1005 (no status) to 1000', () => {
    expect(forwardCloseCode(1005)).toBe(1000)
  })

  it.each([1006, 1002, 1015, 2999, 5000])('maps %i to 1011', (code) => {
    expect(forwardCloseCode(code)).toBe(1011)
  })
})
