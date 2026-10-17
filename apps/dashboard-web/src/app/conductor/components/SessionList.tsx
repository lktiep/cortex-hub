'use client'

import { useState } from 'react'
import type { ConductorClosedSession, ConductorSession } from '@/lib/api'
import { formatTimeAgo, getIdeInfo } from './shared'
import styles from '../page.module.css'

type SessionFilter = 'open' | 'closed'

const CLOSED: Record<ConductorClosedSession['status'], { label: string; title: string }> = {
  completed: { label: 'ended', title: 'Ended with cortex_session_end' },
  abandoned: { label: 'IDE closed', title: 'Closed by the IDE when it exited, without a session end' },
  expired: { label: 'expired', title: 'Closed by the hub after it sat idle' },
}

function SessionRow({ session, closed }: { session: ConductorSession; closed?: ConductorClosedSession['status'] }) {
  const { icon, label, colorClass } = getIdeInfo(session.ide ?? undefined)
  const how = closed ? (CLOSED[closed] ?? { label: closed, title: closed }) : null
  return (
    <div className={`${styles.sessionRow} ${closed ? styles.sessionRowClosed : ''}`}>
      <span className={`${styles.agentIdeIcon} ${colorClass ? styles[colorClass] : ''}`} title={label}>{icon}</span>
      <strong className={styles.agentIdText}>{session.agentId}</strong>
      <span className={styles.sessionMeta}>{session.hostname ?? '-'}</span>
      <span className={styles.sessionMeta}>{session.branch ?? '-'}</span>
      {how && <span className={styles.sessionStatus} title={how.title}>{how.label}</span>}
      <span className={`${styles.sessionMeta} ${styles.sessionTime}`}>{formatTimeAgo(session.lastActivity)}</span>
    </div>
  )
}

/** MCP sessions: folded until opened, then the open ones, with the recently closed ones a tab away. */
export function SessionList({ open, closed }: { open: ConductorSession[]; closed: ConductorClosedSession[] }) {
  const [expanded, setExpanded] = useState(false)
  const [filter, setFilter] = useState<SessionFilter>('open')
  if (open.length === 0 && closed.length === 0) return null

  const tabs: { key: SessionFilter; label: string; count: number }[] = [
    { key: 'open', label: 'Open', count: open.length },
    { key: 'closed', label: 'Closed', count: closed.length },
  ]
  const empty = filter === 'open' ? open.length === 0 : closed.length === 0

  return (
    <div className={styles.sessionList}>
      <button
        type="button"
        className={styles.sessionToggle}
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <span className={`${styles.collapseIcon} ${expanded ? '' : styles.collapseIconClosed}`}>▾</span>
        <span className={styles.sessionListLabel}>MCP sessions</span>
        <span className={styles.filterCount}>{open.length} open</span>
      </button>
      {expanded && (
        <>
          <div className={styles.sessionFilter} role="tablist" aria-label="Session status">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={filter === tab.key}
                className={`${styles.sessionFilterTab} ${filter === tab.key ? styles.sessionFilterTabActive : ''}`}
                onClick={() => setFilter(tab.key)}
              >
                {tab.label} <span className={styles.filterCount}>{tab.count}</span>
              </button>
            ))}
          </div>
          {empty ? (
            <div className={styles.sessionEmpty}>{filter === 'open' ? 'No open sessions.' : 'No closed sessions yet.'}</div>
          ) : (
            <div className={styles.sessionRows}>
              {filter === 'open'
                ? open.map((s) => <SessionRow key={s.sessionId} session={s} />)
                : closed.map((s) => <SessionRow key={s.sessionId} session={s} closed={s.status} />)}
            </div>
          )}
        </>
      )}
    </div>
  )
}
