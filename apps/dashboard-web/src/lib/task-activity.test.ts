import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { currentStep, lastLogId, lineTone, liveness, logTime, mergeLogs, reportsSteps, span } from './task-activity'
import type { TaskLog } from './task-activity'

const row = (id: number, action: string, message: string | null, createdAt = '2026-10-18T09:00:00Z'): TaskLog => ({
  id,
  action,
  message,
  agent_id: 'w1',
  created_at: createdAt,
})

describe('mergeLogs', () => {
  it('adds the new rows in id order, once each', () => {
    const prev = [row(1, 'picked_up', null), row(2, 'progress', 'a')]
    const merged = mergeLogs(prev, [row(3, 'progress', 'b'), row(2, 'progress', 'a')])
    expect(merged.map((l) => l.id)).toEqual([1, 2, 3])
  })

  it('keeps only the newest heartbeat', () => {
    const prev = [row(1, 'progress', 'a'), row(2, 'quiet', 'still running: x, no output for 1 min')]
    const merged = mergeLogs(prev, [row(5, 'quiet', 'still running: x, no output for 2 min')])
    expect(merged.map((l) => l.id)).toEqual([1, 5])
  })

  it('keeps the newest rows up to the limit', () => {
    const prev = Array.from({ length: 10 }, (_, i) => row(i + 1, 'progress', `p${i}`))
    expect(mergeLogs(prev, [row(11, 'progress', 'p10')], 4).map((l) => l.id)).toEqual([8, 9, 10, 11])
  })

  it('lastLogId is the highest id, or null', () => {
    expect(lastLogId([])).toBeNull()
    expect(lastLogId([row(4, 'progress', 'a'), row(9, 'quiet', 'q'), row(7, 'progress', 'b')])).toBe(9)
  })
})

describe('logTime', () => {
  it('reads the hub timestamps as UTC', () => {
    const at = Date.UTC(2026, 9, 18, 9, 0, 5)
    expect(logTime('2026-10-18T09:00:05Z')).toBe(at)
    expect(logTime('2026-10-18 09:00:05')).toBe(at)
    expect(logTime('2026-10-18T11:00:05+02:00')).toBe(at)
  })
})

describe('lineTone', () => {
  it('reads the marker the worker puts in front', () => {
    expect(lineTone('→ Bash: pnpm test')).toBe('tool')
    expect(lineTone('• tests passed')).toBe('info')
    expect(lineTone('✗ exit 1')).toBe('error')
    expect(lineTone('(thinking) why')).toBe('thinking')
    expect(lineTone('(12 earlier lines left out; cw tail on the worker shows them)')).toBe('note')
    expect(lineTone('Looking at the parser')).toBe('text')
  })
})

describe('currentStep', () => {
  it('is the newest tool call or step, without its marker', () => {
    const logs = [
      row(1, 'progress', '• engine: claude (opus)'),
      row(2, 'progress', '→ Read: src/a.ts\n→ Bash: pnpm test\n(thinking) the tests\nall green'),
      row(3, 'quiet', 'still running: Bash: pnpm test, no output for 1 min'),
    ]
    expect(currentStep(logs)).toEqual({ tone: 'tool', text: 'Bash: pnpm test' })
    expect(currentStep([...logs, row(4, 'progress', '• commit')])).toEqual({ tone: 'info', text: 'commit' })
  })

  it('is null before any step', () => {
    expect(currentStep([row(1, 'picked_up', null), row(2, 'progress', 'plain text')])).toBeNull()
  })
})

describe('reportsSteps', () => {
  it('is unknown before the first progress', () => {
    expect(reportsSteps([])).toBeNull()
    expect(reportsSteps([row(1, 'created', 'Task created'), row(2, 'picked_up', null)])).toBeNull()
  })

  it('is false for a worker that sends only the engine text', () => {
    const logs = [
      row(1, 'picked_up', null),
      row(2, 'progress', 'agy started (gemini)'),
      row(3, 'progress', 'Looking at the parser first. [Bash]'),
    ]
    expect(reportsSteps(logs)).toBe(false)
  })

  it('is true once a marked line or a heartbeat comes', () => {
    expect(reportsSteps([row(1, 'progress', 'text'), row(2, 'progress', '• engine: agy (gemini)')])).toBe(true)
    expect(reportsSteps([row(1, 'progress', 'text\n→ Bash: pnpm test')])).toBe(true)
    expect(reportsSteps([row(1, 'progress', '(3 earlier lines left out; cw tail on the worker shows them)\nok')])).toBe(true)
    expect(reportsSteps([row(1, 'progress', 'text'), row(2, 'quiet', 'still running: x, no output for 2 min')])).toBe(true)
  })
})

describe('liveness', () => {
  const t = (s: number): string => new Date(Date.UTC(2026, 9, 18, 9, 0, s)).toISOString()

  it('has the time of the newest output, and the heartbeat only when it came after', () => {
    const logs = [row(1, 'progress', 'a', t(0)), row(2, 'progress', 'b', t(10))]
    expect(liveness(logs)).toEqual({ lastOutputAt: logTime(t(10)), heartbeat: null })

    const quiet = [...logs, row(3, 'quiet', 'still running: x, no output for 1 min', t(50))]
    expect(liveness(quiet)).toEqual({
      lastOutputAt: logTime(t(10)),
      heartbeat: { at: logTime(t(50)), message: 'still running: x, no output for 1 min' },
    })
    expect(liveness([row(3, 'quiet', 'q', t(5)), row(4, 'progress', 'c', t(20))]).heartbeat).toBeNull()
  })

  it('knows nothing before the first output', () => {
    expect(liveness([row(1, 'picked_up', null)])).toEqual({ lastOutputAt: null, heartbeat: null })
  })
})

describe('span', () => {
  it('is short', () => {
    expect(span(-5)).toBe('0 s')
    expect(span(12_400)).toBe('12 s')
    expect(span(7 * 60_000 + 59_000)).toBe('7 min')
    expect(span(2 * 3_600_000)).toBe('2 h')
    expect(span(2 * 3_600_000 + 5 * 60_000)).toBe('2 h 5 min')
  })
})

it('stays free of React and the DOM', () => {
  const src = readFileSync(new URL('./task-activity.ts', import.meta.url), 'utf8')
  expect(src).not.toMatch(/from 'react|document\.|window\./)
})
