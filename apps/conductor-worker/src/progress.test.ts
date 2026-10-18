import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProgressBatcher } from './progress.js'

describe('createProgressBatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends the first line immediately', () => {
    const send = vi.fn()
    createProgressBatcher(send).push('one')
    expect(send).toHaveBeenCalledExactlyOnceWith('one')
  })

  it('sends the lines of the next 5 s together, none dropped', () => {
    const send = vi.fn()
    const b = createProgressBatcher(send)
    b.push('a')
    b.push('b')
    b.push('c')
    expect(send).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(4999)
    expect(send).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith('b\nc')
    vi.advanceTimersByTime(20_000)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('sends at once after a quiet period longer than intervalMs', () => {
    const send = vi.fn()
    const b = createProgressBatcher(send)
    b.push('a')
    vi.advanceTimersByTime(6000)
    b.push('b')
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith('b')
  })

  it('waits the full interval measured from the last send', () => {
    const send = vi.fn()
    const b = createProgressBatcher(send, { intervalMs: 1000 })
    b.push('a')
    vi.advanceTimersByTime(600)
    b.push('b')
    vi.advanceTimersByTime(399)
    expect(send).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(send).toHaveBeenLastCalledWith('b')
  })

  it('ignores blank lines and trailing spaces', () => {
    const send = vi.fn()
    const b = createProgressBatcher(send)
    b.push('   ')
    b.push('')
    expect(send).not.toHaveBeenCalled()
    b.push('  indented  ')
    expect(send).toHaveBeenCalledExactlyOnceWith('  indented')
  })

  it('a batch over maxChars keeps its newest lines and says how many it left out', () => {
    const send = vi.fn()
    const b = createProgressBatcher(send, { maxChars: 20 })
    b.push('first')
    for (const l of ['line 1', 'line 2', 'line 3', 'line 4']) b.push(l)
    vi.advanceTimersByTime(5000)
    expect(send).toHaveBeenLastCalledWith('(1 earlier lines left out; cw tail on the worker shows them)\nline 2\nline 3\nline 4')
  })

  it('cuts a single line to maxChars', () => {
    const send = vi.fn()
    createProgressBatcher(send, { maxChars: 10 }).push('0123456789abcdef')
    expect(send).toHaveBeenCalledExactlyOnceWith('0123456789')
  })

  it('lets go of the oldest waiting lines in a long burst, and counts them', () => {
    const send = vi.fn()
    const b = createProgressBatcher(send, { maxChars: 100 })
    b.push('first')
    for (let i = 0; i < 1000; i++) b.push(`burst line ${String(i).padStart(3, '0')}`)
    vi.advanceTimersByTime(5000)
    const message = String(send.mock.lastCall?.[0])
    expect(message.length).toBeLessThan(200)
    expect(message).toMatch(/^\(\d+ earlier lines left out; cw tail on the worker shows them\)\n/)
    expect(message.endsWith('burst line 999')).toBe(true)
    const [head = '', ...kept] = message.split('\n')
    expect(Number(/\d+/.exec(head)?.[0]) + kept.length).toBe(1000)
  })

  it('flush sends what is waiting now', () => {
    const send = vi.fn()
    const b = createProgressBatcher(send)
    b.push('a')
    b.push('b')
    b.flush()
    expect(send).toHaveBeenLastCalledWith('b')
    vi.advanceTimersByTime(20_000)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('stop sends what is waiting, then takes no more', () => {
    const send = vi.fn()
    const b = createProgressBatcher(send)
    b.push('a')
    b.push('b')
    b.stop()
    expect(send).toHaveBeenLastCalledWith('b')
    b.push('c')
    b.flush()
    vi.advanceTimersByTime(20_000)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('a throwing send does not break later sends', () => {
    const send = vi
      .fn<(m: string) => void>()
      .mockImplementationOnce(() => {
        throw new Error('socket closed')
      })
    const b = createProgressBatcher(send)
    expect(() => b.push('a')).not.toThrow()
    b.push('b')
    vi.advanceTimersByTime(5000)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith('b')
  })
})
