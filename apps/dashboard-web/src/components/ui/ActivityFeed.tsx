import React from 'react'
import { TimelineEvent } from './TimelineEvent'
import type { ActivityEvent } from '@/lib/api'
import { ACTIVITY_ICONS, ICON_DEFAULTS } from '@/lib/icons'
import { Mailbox } from 'lucide-react'
import { parseDateSafe, formatTimeAgo } from '@/lib/date'
import styles from './ActivityFeed.module.css'

function timeAgo(dateStr: string): string {
  return formatTimeAgo(dateStr)
}

function ActivityRow({ event }: { event: ActivityEvent }) {
  const IconComp =
    ACTIVITY_ICONS[event.type as keyof typeof ACTIVITY_ICONS] ?? ACTIVITY_ICONS.default
  const statusClass =
    event.status === 'ok' || event.status === 'completed'
      ? 'healthy'
      : event.status === 'error'
        ? 'error'
        : 'warning'
  return (
    <TimelineEvent
      icon={<IconComp size={16} strokeWidth={ICON_DEFAULTS.strokeWidth} />}
      detail={event.detail}
      meta={`${event.agent_id}${event.latency_ms ? ` · ${event.latency_ms}ms` : ''}`}
      status={event.status}
      statusVariant={statusClass}
      time={timeAgo(event.created_at)}
    />
  )
}

export interface ActivityFeedProps {
  /** Activity events to display */
  events: ActivityEvent[]
  /** Empty-state message */
  emptyMessage?: string
}

export function ActivityFeed({
  events,
  emptyMessage = 'No activity yet. Events appear when agents make API calls.',
}: ActivityFeedProps) {
  if (!events || events.length === 0) {
    return (
      <div className={`card ${styles.card}`}>
        <div className={styles.empty}>
          <span><Mailbox size={24} strokeWidth={1.5} /></span>
          <p>{emptyMessage}</p>
        </div>
      </div>
    )
  }

  const today = new Date().toDateString()
  const yesterday = new Date(Date.now() - 86400000).toDateString()

  const groups: { Today: ActivityEvent[]; Yesterday: ActivityEvent[]; Earlier: ActivityEvent[] } = {
    Today: [],
    Yesterday: [],
    Earlier: [],
  }

  events.forEach((event) => {
    const eDate = parseDateSafe(event.created_at).toDateString()
    if (eDate === today) groups.Today.push(event)
    else if (eDate === yesterday) groups.Yesterday.push(event)
    else groups.Earlier.push(event)
  })

  return (
    <div className={`card ${styles.card}`}>
      <div className={styles.list}>
        {Object.entries(groups)
          .filter(([, evts]) => evts.length > 0)
          .map(([label, evts]) => (
            <div key={label} className={styles.group}>
              <h3 className={styles.groupHeader}>{label}</h3>
              {evts.map((event, i) => (
                <ActivityRow key={`${event.created_at}-${i}`} event={event} />
              ))}
            </div>
          ))}
      </div>
    </div>
  )
}
