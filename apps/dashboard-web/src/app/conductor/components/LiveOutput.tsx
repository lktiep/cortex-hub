'use client'

import { useEffect, useRef, useState } from 'react'
import { getLogActionLabel } from './shared'
import { ICON_INLINE } from '@/lib/icons'
import { currentStep, lastLogId, lineTone, liveness, logTime, mergeLogs, span } from '@/lib/task-activity'
import type { LineTone, TaskLog } from '@/lib/task-activity'
import styles from '../page.module.css'

const POLL_MS = 5000
/** An engine silent this long may be stuck: its last output turns amber. */
const QUIET_WARN_MS = 5 * 60_000
/** A worker sends something at least once a minute while it runs a task. */
const WORKER_LOST_MS = 3 * 60_000

const TONE_CLASS: Record<LineTone, string | undefined> = {
  tool: styles.outputTool,
  info: styles.outputInfo,
  error: styles.outputError,
  thinking: styles.outputThinking,
  note: styles.outputThinking,
  text: undefined,
}

/** The task's log, read from the hub every few seconds while it runs; only new rows are fetched. */
export function LiveOutput({ taskId, isActive }: { taskId: string; isActive: boolean }) {
  const [logs, setLogs] = useState<TaskLog[]>([])
  // The hub's clock, so "N min ago" holds when this machine's clock is off.
  const [hubNow, setHubNow] = useState<number | null>(null)
  const [unreachable, setUnreachable] = useState(false)
  const lastId = useRef<number | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined

    async function poll() {
      const after = lastId.current
      try {
        const query = after === null ? '' : `?after=${after}`
        const res = await fetch(`/api/conductor/${encodeURIComponent(taskId)}/logs${query}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as { logs?: TaskLog[]; now?: string }
        if (stopped) return
        const fresh = data.logs ?? []
        const top = lastLogId(fresh)
        if (top !== null) lastId.current = Math.max(after ?? 0, top)
        setLogs((prev) => mergeLogs(prev, fresh))
        const now = typeof data.now === 'string' ? Date.parse(data.now) : NaN
        setHubNow(Number.isNaN(now) ? Date.now() : now)
        setUnreachable(false)
      } catch {
        if (!stopped) setUnreachable(true)
      }
      if (!stopped && isActive) timer = setTimeout(() => void poll(), POLL_MS)
    }

    void poll()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [taskId, isActive])

  // Follow new output unless the reader has scrolled up to read.
  useEffect(() => {
    const el = box.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  }, [logs])

  function onScroll() {
    const el = box.current
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  const rows = logs.filter((l) => l.action !== 'quiet')

  return (
    <div>
      {isActive && hubNow !== null && <ActivityStrip logs={logs} now={hubNow} />}
      {unreachable && <div className={styles.activityWarn}>The hub did not answer; trying again.</div>}
      {rows.length === 0 ? (
        <div className={styles.logEntry} style={{ color: 'var(--text-tertiary)', borderLeftColor: 'transparent' }}>
          No output yet
        </div>
      ) : (
        <div ref={box} className={styles.activityLog} onScroll={onScroll}>
          {rows.map((log) => <LogRow key={log.id} log={log} />)}
        </div>
      )}
    </div>
  )
}

function ActivityStrip({ logs, now }: { logs: TaskLog[]; now: number }) {
  const step = currentStep(logs)
  const { lastOutputAt, heartbeat } = liveness(logs)
  const lastSeen = logs.reduce((max, l) => Math.max(max, logTime(l.created_at) || 0), 0)
  const quietFor = lastOutputAt === null ? null : now - lastOutputAt

  return (
    <>
      <div className={styles.activityStrip}>
        <div className={styles.activityItem}>
          <span className={styles.activityLabel}>Current step</span>
          <span className={styles.activityValue} title={step?.text}>
            {step ? step.text : 'not started yet'}
          </span>
        </div>
        <div className={styles.activityItem}>
          <span className={styles.activityLabel}>Last output</span>
          <span
            className={styles.activityValue}
            style={quietFor !== null && quietFor > QUIET_WARN_MS ? { color: 'var(--status-warning)' } : undefined}
          >
            {quietFor === null ? 'none yet' : `${span(quietFor)} ago`}
          </span>
        </div>
        {heartbeat && (
          <div className={styles.activityItem}>
            <span className={styles.activityLabel}>Worker</span>
            <span className={styles.activityValue}>checked in {span(now - heartbeat.at)} ago</span>
          </div>
        )}
      </div>
      {lastSeen > 0 && now - lastSeen > WORKER_LOST_MS && (
        <div className={styles.activityWarn}>
          Nothing from the worker for {span(now - lastSeen)}. If it does not come back, run{' '}
          <code>cw status</code> on its machine.
        </div>
      )}
    </>
  )
}

function LogRow({ log }: { log: TaskLog }) {
  const time = new Date(logTime(log.created_at)).toLocaleTimeString()

  if (log.action === 'progress') {
    return (
      <div className={styles.outputRow}>
        <span className={styles.outputTime}>{time}</span>
        <div className={styles.outputText}>
          {(log.message ?? '').split('\n').map((line, i) => (
            <div key={i} className={TONE_CLASS[lineTone(line)]}>{line}</div>
          ))}
        </div>
      </div>
    )
  }

  const { label, icon: Icon, color } = getLogActionLabel(log.action)
  return (
    <div className={styles.liveOutputLifecycle} style={{ borderLeftColor: color }}>
      <span className={styles.liveOutputLifecycleIcon}><Icon {...ICON_INLINE} /></span>
      <span className={styles.liveOutputLifecycleAction} style={{ color }}>{label}</span>
      <span className={styles.liveOutputLifecycleMsg}>{log.message || log.agent_id}</span>
      <span className={styles.timestamp}>{time}</span>
    </div>
  )
}
