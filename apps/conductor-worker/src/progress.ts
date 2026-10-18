export interface ProgressBatcher {
  push(line: string): void
  /** Sends what is waiting now. */
  flush(): void
  /** Sends what is waiting, then takes no more. */
  stop(): void
}

export interface ProgressBatcherOptions {
  intervalMs?: number
  maxChars?: number
  now?: () => number
}

/**
 * Sends progress lines in batches: the first at once, then every `intervalMs` the lines that
 * came in meanwhile, one message with a line each. A batch over `maxChars` keeps its newest
 * lines and says how many it left out. Progress is best effort, so `send` errors are ignored.
 */
export function createProgressBatcher(
  send: (message: string) => void,
  opts: ProgressBatcherOptions = {},
): ProgressBatcher {
  const intervalMs = opts.intervalMs ?? 5_000
  const maxChars = opts.maxChars ?? 2_000
  const now = opts.now ?? Date.now
  let lastSent: number | null = null
  let waiting: string[] = []
  let waitingChars = 0
  /** Lines already let go while waiting, so a burst cannot grow without end. */
  let dropped = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const deliver = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    if (waiting.length === 0) return
    const lines = waiting
    let left = dropped
    waiting = []
    waitingChars = 0
    dropped = 0
    // the newest lines that fit, and always the newest one
    const sizes = lines.map((l) => Math.min(l.length, maxChars))
    let start = lines.length - 1
    let size = sizes[start] ?? 0
    while (start > 0 && size + 1 + (sizes[start - 1] ?? 0) <= maxChars) {
      start -= 1
      size += 1 + (sizes[start] ?? 0)
    }
    left += start
    const kept = lines.slice(start).map((l) => l.slice(0, maxChars))
    const head = left > 0 ? [`(${left} earlier lines left out; cw tail on the worker shows them)`] : []
    lastSent = now()
    try {
      send([...head, ...kept].join('\n'))
    } catch {
      // best effort
    }
  }

  return {
    push(raw: string): void {
      if (stopped) return
      const line = raw.trimEnd()
      if (line.trim() === '') return
      waiting.push(line)
      waitingChars += line.length + 1
      while (waitingChars > maxChars * 2 && waiting.length > 1) {
        waitingChars -= (waiting.shift() ?? '').length + 1
        dropped += 1
      }
      if (timer !== null) return
      const elapsed = lastSent === null ? Infinity : now() - lastSent
      if (elapsed >= intervalMs) deliver()
      else timer = setTimeout(deliver, intervalMs - elapsed)
    },
    flush(): void {
      if (!stopped) deliver()
    },
    stop(): void {
      if (stopped) return
      deliver()
      stopped = true
    },
  }
}
