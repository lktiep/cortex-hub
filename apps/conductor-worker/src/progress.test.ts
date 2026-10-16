import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProgressThrottle } from './progress.js'

describe('createProgressThrottle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends the first line immediately', () => {
    const send = vi.fn()
    createProgressThrottle(send).push('one')
    expect(send).toHaveBeenCalledExactlyOnceWith('one')
  })

  it('sends at most one line per 5 s and it is the latest', () => {
    const send = vi.fn()
    const t = createProgressThrottle(send)
    t.push('a')
    t.push('b')
    t.push('c')
    expect(send).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(4999)
    expect(send).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith('c')
    vi.advanceTimersByTime(20_000)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('sends at once after a quiet period longer than intervalMs', () => {
    const send = vi.fn()
    const t = createProgressThrottle(send)
    t.push('a')
    vi.advanceTimersByTime(6000)
    t.push('b')
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith('b')
  })

  it('waits the full interval measured from the last send', () => {
    const send = vi.fn()
    const t = createProgressThrottle(send)
    t.push('a')
    vi.advanceTimersByTime(3000)
    t.push('b')
    vi.advanceTimersByTime(1999)
    expect(send).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith('b')
  })

  it('honours a non-default intervalMs', () => {
    const send = vi.fn()
    const t = createProgressThrottle(send, { intervalMs: 1000 })
    t.push('a')
    t.push('b')
    vi.advanceTimersByTime(999)
    expect(send).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(send).toHaveBeenLastCalledWith('b')
    vi.advanceTimersByTime(1000)
    t.push('c')
    expect(send).toHaveBeenLastCalledWith('c')
  })

  it('ignores blank lines and caps length', () => {
    const send = vi.fn()
    const t = createProgressThrottle(send, { maxLen: 10 })
    t.push('   ')
    t.push('')
    expect(send).not.toHaveBeenCalled()
    t.push('  0123456789abcdef  ')
    expect(send).toHaveBeenCalledExactlyOnceWith('0123456789')
  })

  it('stop cancels the pending send', () => {
    const send = vi.fn()
    const t = createProgressThrottle(send)
    t.push('a')
    t.push('b')
    t.stop()
    vi.advanceTimersByTime(20_000)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('push after stop sends nothing', () => {
    const send = vi.fn()
    const t = createProgressThrottle(send)
    t.stop()
    t.push('a')
    vi.advanceTimersByTime(20_000)
    expect(send).not.toHaveBeenCalled()
  })

  it('a throwing send does not break later sends', () => {
    const send = vi
      .fn<(m: string) => void>()
      .mockImplementationOnce(() => {
        throw new Error('socket closed')
      })
    const t = createProgressThrottle(send)
    expect(() => t.push('a')).not.toThrow()
    t.push('b')
    vi.advanceTimersByTime(5000)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith('b')
  })
})
