/**
 * The gate in front of the embedding provider, with a lane for each kind of caller.
 *
 * ollama answers one embedding request at a time and queues the rest inside
 * itself, where we cannot see them, so the gateway admits a fixed number at a
 * time and makes everyone else wait here. One shared FIFO put a search behind
 * every batch a re-index had already queued: with a dozen index jobs embedding,
 * a query's own 15ms embedding waited seconds.
 *
 * So there are two lanes. A query starts before any waiting background request,
 * and background work never holds more than `concurrency - 1` slots, which
 * leaves a query a free slot even while an index is running flat out.
 */

export type EmbedLane = 'query' | 'background'

export interface EmbedGate {
  run<T>(fn: () => Promise<T>, lane?: EmbedLane): Promise<T>
  stats(): { inFlight: number; backgroundInFlight: number; waitingQueries: number; waitingBackground: number }
}

export function createEmbedGate(concurrency: number): EmbedGate {
  const limit = Math.max(1, Math.floor(concurrency))
  // With a single slot there is nothing to reserve: background may take it, and
  // a query still goes first the moment it frees up.
  const backgroundLimit = Math.max(1, limit - 1)

  let inFlight = 0
  let backgroundInFlight = 0
  const waiting: Record<EmbedLane, Array<() => void>> = { query: [], background: [] }

  const canStart = (lane: EmbedLane) =>
    inFlight < limit && (lane === 'query' || backgroundInFlight < backgroundLimit)

  const take = (lane: EmbedLane) => {
    inFlight++
    if (lane === 'background') backgroundInFlight++
  }

  // A released slot is handed over, counted on the waiter's behalf before it
  // wakes, so nothing that arrives in between can take it.
  const handOver = () => {
    while (waiting.query.length > 0 && canStart('query')) {
      take('query')
      waiting.query.shift()?.()
    }
    while (waiting.query.length === 0 && waiting.background.length > 0 && canStart('background')) {
      take('background')
      waiting.background.shift()?.()
    }
  }

  async function run<T>(fn: () => Promise<T>, lane: EmbedLane = 'query'): Promise<T> {
    const overtaking = lane === 'background' && waiting.query.length > 0
    if (waiting[lane].length === 0 && !overtaking && canStart(lane)) {
      take(lane)
    } else {
      await new Promise<void>((resolve) => waiting[lane].push(resolve))
    }
    try {
      return await fn()
    } finally {
      inFlight--
      if (lane === 'background') backgroundInFlight--
      handOver()
    }
  }

  return {
    run,
    stats: () => ({
      inFlight,
      backgroundInFlight,
      waitingQueries: waiting.query.length,
      waitingBackground: waiting.background.length,
    }),
  }
}

/** The lane a request asked for; anything but 'background' is a query. */
export function laneOf(header: string | undefined): EmbedLane {
  return header?.trim().toLowerCase() === 'background' ? 'background' : 'query'
}
