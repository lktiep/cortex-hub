// What a running task is doing, read from its log rows. Pure module: no React, no DOM.
//
// A worker sends its engine's output as `progress` rows, a few lines each: `→ tool: target`,
// `• step`, `✗ error`, `(thinking) …` or plain text. When the engine prints nothing for a
// minute it sends a heartbeat, kept as the task's one `quiet` row.

export interface TaskLog {
  id: number
  action: string
  message: string | null
  agent_id: string | null
  created_at: string
}

/** Rows the live view keeps; the hub keeps the last 200 progress rows of a task. */
export const KEPT_LOGS = 500

/** `prev` with the rows of `next` it lacks, oldest first, only the newest `quiet` row, at most `kept`. */
export function mergeLogs(prev: TaskLog[], next: TaskLog[], kept = KEPT_LOGS): TaskLog[] {
  const byId = new Map<number, TaskLog>()
  for (const log of [...prev, ...next]) byId.set(log.id, log)
  const all = [...byId.values()].sort((a, b) => a.id - b.id)
  const quiet = all.filter((l) => l.action === 'quiet').at(-1)
  return all.filter((l) => l.action !== 'quiet' || l === quiet).slice(-kept)
}

/** The highest id in `logs`, to ask the hub for what came after; null for none. */
export function lastLogId(logs: TaskLog[]): number | null {
  return logs.reduce<number | null>((max, l) => (max === null || l.id > max ? l.id : max), null)
}

/** `created_at` as milliseconds; the hub writes UTC, with or without the `Z`. */
export function logTime(createdAt: string): number {
  const iso = createdAt.includes('T') ? createdAt : createdAt.replace(' ', 'T')
  return Date.parse(/Z$|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`)
}

export type LineTone = 'tool' | 'info' | 'error' | 'thinking' | 'note' | 'text'

/** How a progress line reads, from the marker the worker put in front of it. */
export function lineTone(line: string): LineTone {
  if (line.startsWith('→ ')) return 'tool'
  if (line.startsWith('• ')) return 'info'
  if (line.startsWith('✗ ')) return 'error'
  if (line.startsWith('(thinking) ')) return 'thinking'
  if (/^\(\d+ earlier lines left out/.test(line)) return 'note'
  return 'text'
}

export interface Step {
  tone: 'tool' | 'info'
  text: string
}

/** The step the task is on: the newest tool call or step line, without its marker. */
export function currentStep(logs: TaskLog[]): Step | null {
  for (let i = logs.length - 1; i >= 0; i--) {
    const log = logs[i]
    if (log === undefined || log.action !== 'progress' || log.message === null) continue
    const lines = log.message.split('\n')
    for (let j = lines.length - 1; j >= 0; j--) {
      const line = lines[j] ?? ''
      const tone = lineTone(line)
      if (tone === 'tool' || tone === 'info') return { tone, text: line.slice(2) }
    }
  }
  return null
}

export interface Liveness {
  /** When the engine last printed something, in ms; null before the first line. */
  lastOutputAt: number | null
  /** The newest heartbeat after that output: the worker is there, the engine quiet. */
  heartbeat: { at: number; message: string } | null
}

export function liveness(logs: TaskLog[]): Liveness {
  let lastOutputAt: number | null = null
  let quiet: TaskLog | undefined
  for (const log of logs) {
    if (log.action === 'progress') lastOutputAt = Math.max(lastOutputAt ?? 0, logTime(log.created_at))
    else if (log.action === 'quiet') quiet = log
  }
  const at = quiet === undefined ? NaN : logTime(quiet.created_at)
  const heartbeat =
    quiet !== undefined && !Number.isNaN(at) && (lastOutputAt === null || at >= lastOutputAt)
      ? { at, message: quiet.message ?? '' }
      : null
  return { lastOutputAt, heartbeat }
}

/** `ms` as a short span: `12 s`, `7 min`, `2 h 5 min`. */
export function span(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s} s`
  const min = Math.floor(s / 60)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return min % 60 === 0 ? `${h} h` : `${h} h ${min % 60} min`
}
