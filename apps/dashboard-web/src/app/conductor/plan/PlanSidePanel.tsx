'use client'

// Plan side panel: Needs you, Awaiting lead, Workers, Fallback tally and Critical path.
import type { CriticalPath } from '@/lib/conductor-plan/analysis'
import { formatUntil, type PlanTask } from '@/lib/conductor-plan/model'
import type { NeedItem, WorkerRow } from '@/lib/conductor-plan/summary'
import styles from './plan.module.css'

const IDLE_COLOR = '#34d399'
const BUSY_COLOR = '#60a5fa'
const TALLY_COLOR = '#94a3b8'

interface Props {
  needs: NeedItem[]
  awaiting: NeedItem[]
  workers: WorkerRow[]
  tally: { label: string; count: number }[]
  critical: CriticalPath
  byId: Map<string, PlanTask>
  onSelect: (taskId: string) => void
}

function hhmm(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function NeedButton({ item, onSelect }: { item: NeedItem; onSelect: (taskId: string) => void }) {
  return (
    <button
      type="button"
      className={`${styles.need} ${styles.needBtn} ${styles[item.tone]}`}
      onClick={() => onSelect(item.taskId)}
    >
      <b>{item.key}</b>
      {item.title} · {item.detail}
    </button>
  )
}

export function PlanSidePanel({ needs, awaiting, workers, tally, critical, byId, onSelect }: Props) {
  const now = new Date()
  const max = Math.max(1, ...tally.map((t) => t.count))
  const path = critical.ids.map((id) => byId.get(id)?.key ?? id)
  const days = String(Math.round(critical.days * 10) / 10)
  return (
    <aside className={styles.side}>
      <section>
        <h3>Needs you <span className={styles.count}>{needs.length}</span></h3>
        {needs.length === 0 && <p className={styles.muted}>Nothing needs you</p>}
        {needs.map((n) => <NeedButton key={`${n.kind}:${n.taskId}`} item={n} onSelect={onSelect} />)}
      </section>
      <section>
        <h3>Awaiting lead <span className={styles.count}>{awaiting.length}</span></h3>
        {awaiting.map((n) => <NeedButton key={`${n.kind}:${n.taskId}`} item={n} onSelect={onSelect} />)}
      </section>
      <section>
        <h3>Workers</h3>
        {workers.length === 0 && <p className={styles.muted}>No workers online for this project</p>}
        {workers.map((w) => (
          <div key={w.agentId}>
            <p className={styles.worker}>
              <i style={{ background: w.status === 'busy' ? BUSY_COLOR : IDLE_COLOR }} />
              <b>{w.agentId}</b>
              <span>{w.hostname}</span>
            </p>
            <p className={styles.muted}>
              {w.currentTask ? `current: ${w.currentTask.key}${w.currentTask.title ? ` ${w.currentTask.title}` : ''}` : 'idle'}
              {w.engines ? ` · ${w.engines}` : ''}
            </p>
            {w.quota.map((q) => (
              <p key={`${q.label}:${q.until}`} className={styles.muted}>
                {q.label} until {hhmm(q.until)} ({formatUntil(q.until, now)})
              </p>
            ))}
          </div>
        ))}
      </section>
      <section>
        <h3>Fallback tally</h3>
        {tally.map((t) => (
          <div key={t.label} className={styles.routeRow}>
            <span>{t.label}</span>
            <div className={styles.routeBar}>
              <span style={{ width: `${(t.count / max) * 100}%`, background: TALLY_COLOR }} />
            </div>
            <b>{t.count}</b>
          </div>
        ))}
      </section>
      <section>
        <h3>Critical path</h3>
        <p className={styles.muted}>
          {path.length === 0 ? 'No remaining work' : `${path.join(' → ')} · ${days} d`}
        </p>
      </section>
    </aside>
  )
}
