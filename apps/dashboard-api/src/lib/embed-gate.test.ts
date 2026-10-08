import { describe, it, expect } from 'vitest'
import { createEmbedGate, laneOf } from './embed-gate.js'

/** A request the test finishes by hand, recording when it started. */
function held(log: string[], name: string) {
  let finish!: () => void
  const done = new Promise<void>((resolve) => (finish = resolve))
  return {
    fn: async () => {
      log.push(name)
      await done
      return name
    },
    finish,
  }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('createEmbedGate', () => {
  it('keeps a slot free for queries while background work runs', async () => {
    const gate = createEmbedGate(2)
    const log: string[] = []
    const bg1 = held(log, 'bg1')
    const bg2 = held(log, 'bg2')
    const query = held(log, 'query')

    const running = [gate.run(bg1.fn, 'background'), gate.run(bg2.fn, 'background')]
    await settle()
    expect(log).toEqual(['bg1'])
    expect(gate.stats()).toMatchObject({ inFlight: 1, backgroundInFlight: 1, waitingBackground: 1 })

    const answered = gate.run(query.fn)
    await settle()
    expect(log).toEqual(['bg1', 'query'])

    query.finish()
    await expect(answered).resolves.toBe('query')
    bg1.finish()
    await settle()
    expect(log).toEqual(['bg1', 'query', 'bg2'])
    bg2.finish()
    await Promise.all(running)
    expect(gate.stats()).toEqual({ inFlight: 0, backgroundInFlight: 0, waitingQueries: 0, waitingBackground: 0 })
  })

  it('hands a freed slot to a waiting query before waiting background work', async () => {
    const gate = createEmbedGate(1)
    const log: string[] = []
    const first = held(log, 'bg1')
    const second = held(log, 'bg2')
    const query = held(log, 'query')

    const all = [gate.run(first.fn, 'background'), gate.run(second.fn, 'background')]
    await settle()
    all.push(gate.run(query.fn))
    await settle()
    expect(log).toEqual(['bg1'])

    first.finish()
    await settle()
    expect(log).toEqual(['bg1', 'query'])
    query.finish()
    await settle()
    expect(log).toEqual(['bg1', 'query', 'bg2'])
    second.finish()
    await Promise.all(all)
  })

  it('serves queries in arrival order and never more than the limit at once', async () => {
    const gate = createEmbedGate(2)
    const log: string[] = []
    const q1 = held(log, 'q1')
    const q2 = held(log, 'q2')
    const q3 = held(log, 'q3')
    const q4 = held(log, 'q4')
    const all = [q1, q2, q3, q4].map((call) => gate.run(call.fn))
    await settle()
    expect(log).toEqual(['q1', 'q2'])

    q2.finish()
    await settle()
    expect(log).toEqual(['q1', 'q2', 'q3'])
    q1.finish()
    await settle()
    expect(log).toEqual(['q1', 'q2', 'q3', 'q4'])
    q3.finish()
    q4.finish()
    await Promise.all(all)
  })

  it('releases the slot when the request throws', async () => {
    const gate = createEmbedGate(1)
    await expect(gate.run(async () => { throw new Error('provider down') }, 'background')).rejects.toThrow('provider down')
    await expect(gate.run(async () => 'ok')).resolves.toBe('ok')
    expect(gate.stats().inFlight).toBe(0)
  })
})

describe('laneOf', () => {
  it('only the background header asks for the background lane', () => {
    expect(laneOf('background')).toBe('background')
    expect(laneOf(' Background ')).toBe('background')
    expect(laneOf(undefined)).toBe('query')
    expect(laneOf('urgent')).toBe('query')
  })
})
