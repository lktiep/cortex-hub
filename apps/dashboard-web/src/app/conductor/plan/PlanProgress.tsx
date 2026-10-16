'use client'

// Plan progress: a stacked bar by status bucket plus a legend with done/total and percent.
import { STATUS_COLOR, STATUS_LABEL } from '@/lib/conductor-plan/status'
import { progressPercent, progressSegments, type ProgressCounts } from '@/lib/conductor-plan/summary'
import styles from './plan.module.css'

export function PlanProgress({ counts }: { counts: ProgressCounts }) {
  const segments = progressSegments(counts)
  const percent = progressPercent(counts)
  return (
    <div className={styles.progress}>
      <div className={styles.bar}>
        {segments.map((s) => (
          <span
            key={s.bucket}
            style={{ flex: s.count, background: s.color }}
            title={`${STATUS_LABEL[s.bucket]}: ${s.count}`}
          />
        ))}
      </div>
      <div className={styles.barLegend}>
        <b>{counts.done}/{counts.total} · {percent}%</b>
        {segments.map((s) => (
          <span key={s.bucket}>
            <i style={{ background: s.color }} />
            {STATUS_LABEL[s.bucket]} {s.count}
          </span>
        ))}
        {counts.stopped > 0 && (
          <span>
            <i style={{ background: STATUS_COLOR.stopped }} />
            {counts.stopped} stopped
          </span>
        )}
      </div>
    </div>
  )
}
