export interface ProgressThrottle {
  push(line: string): void
  stop(): void
}

export interface ProgressThrottleOptions {
  intervalMs?: number
  maxLen?: number
  now?: () => number
}

/**
 * Rate-limits progress lines: the first goes out at once, then at most one per
 * `intervalMs`, always the latest. Progress is best effort, so `send` errors are ignored.
 */
export function createProgressThrottle(
  send: (message: string) => void,
  opts: ProgressThrottleOptions = {},
): ProgressThrottle {
  const intervalMs = opts.intervalMs ?? 5_000
  const maxLen = opts.maxLen ?? 300
  const now = opts.now ?? Date.now
  let lastSent: number | null = null
  let pending: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const deliver = (line: string): void => {
    lastSent = now()
    try {
      send(line)
    } catch {
      // best effort
    }
  }

  const flush = (): void => {
    timer = null
    if (stopped || pending === null) return
    const line = pending
    pending = null
    deliver(line)
  }

  return {
    push(raw: string): void {
      if (stopped) return
      const line = raw.trim().slice(0, maxLen)
      if (line === '') return
      const elapsed = lastSent === null ? Infinity : now() - lastSent
      if (pending === null && timer === null && elapsed >= intervalMs) {
        deliver(line)
        return
      }
      pending = line
      if (timer === null) timer = setTimeout(flush, Math.max(0, intervalMs - elapsed))
    },
    stop(): void {
      stopped = true
      pending = null
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
  }
}
