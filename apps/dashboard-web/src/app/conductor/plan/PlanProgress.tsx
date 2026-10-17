'use client'

// Plan progress: a stacked bar by status bucket plus a legend with done/total and percent. Every bucket
// keeps its segment (empty ones at zero width) so a poll grows and shrinks them instead of redrawing.
import { STATUS_COLOR, STATUS_LABEL } from '@/lib/conductor-plan/status'
import { PROGRESS_BUCKETS, progressPercent, type ProgressCounts } from '@/lib/conductor-plan/summary'
import styles from './plan.module.css'

export function PlanProgress({ counts }: { counts: ProgressCounts }) {
  const percent = progressPercent(counts)
  return (
    <div className={styles.progress}>
      <div className={styles.bar} role="img" aria-label={`${counts.done} of ${counts.total} done`}>
        {PROGRESS_BUCKETS.map((b) => (
          <span
            key={b}
            style={{ flexGrow: counts[b], background: STATUS_COLOR[b] }}
            title={`${STATUS_LABEL[b]}: ${counts[b]}`}
          />
        ))}
      </div>
      <div className={styles.barLegend}>
        <b>{counts.done}/{counts.total} · {percent}%</b>
        {PROGRESS_BUCKETS.filter((b) => counts[b] > 0).map((b) => (
          <span key={b}>
            <i style={{ background: STATUS_COLOR[b] }} />
            {counts[b]} {STATUS_LABEL[b]}
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
