'use client'

import { useState, useMemo } from 'react'
import DashboardLayout from '@/components/layout/DashboardLayout'
import useSWR from 'swr'
import { getSessions, type SessionHandoff } from '@/lib/api'
import styles from './page.module.css'

// ── Types ──
type StatusFilter = 'all' | 'pending' | 'claimed' | 'completed'

// ── Components ──
function PriorityBadge({ priority }: { priority: number }) {
  const label = priority <= 3 ? 'high' : priority <= 6 ? 'medium' : 'low'
  const variant = priority <= 3 ? 'error' : priority <= 6 ? 'warning' : 'healthy'
  return (
    <span className={`badge badge-${variant}`}>
      {label} ({priority})
    </span>
  )
}

function StatusBadge({ status }: { status: string }) {
  const variant =
    status === 'completed'
      ? 'healthy'
      : status === 'claimed'
        ? 'warning'
        : status === 'pending'
          ? 'warning'
          : 'error'
  return <span className={`badge badge-${variant}`}>{status}</span>
}

function TimeAgo({ date }: { date: string }) {
  const now = new Date()
  const past = new Date(date)
  const diff = Math.floor((now.getTime() - past.getTime()) / 1000)
  if (diff < 60) return <span>{diff}s ago</span>
  if (diff < 3600) return <span>{Math.floor(diff / 60)}m ago</span>
  if (diff < 86400) return <span>{Math.floor(diff / 3600)}h ago</span>
  return <span>{Math.floor(diff / 86400)}d ago</span>
}

function SessionCard({
  session,
  onSelect,
}: {
  session: SessionHandoff
  onSelect: () => void
}) {
  return (
    <div className={`card ${styles.sessionCard}`} onClick={onSelect}>
      <div className={styles.sessionHeader}>
        <code className={styles.sessionId}>{session.id.slice(0, 8)}</code>
        <StatusBadge status={session.status} />
      </div>

      <p className={styles.taskSummary}>{session.task_summary}</p>

      <div className={styles.metaGrid}>
        <div className={styles.metaItem}>
          <span className={styles.metaLabel}>Project</span>
          <span className={styles.metaValue}>{session.project}</span>
        </div>
        <div className={styles.metaItem}>
          <span className={styles.metaLabel}>From</span>
          <code className={styles.agentName}>{session.from_agent}</code>
        </div>
        <div className={styles.metaItem}>
          <span className={styles.metaLabel}>To</span>
          <code className={styles.agentName}>{session.to_agent ?? '—'}</code>
        </div>
        <div className={styles.metaItem}>
          <span className={styles.metaLabel}>Priority</span>
          <PriorityBadge priority={session.priority} />
        </div>
      </div>

      <div className={styles.sessionFooter}>
        <span className={styles.timestamp}>
          {session.created_at ? <TimeAgo date={session.created_at} /> : '—'}
        </span>
        {session.claimed_by && (
          <span className={styles.claimedBy}>
            Claimed by <code>{session.claimed_by}</code>
          </span>
        )}
      </div>
    </div>
  )
}

function SessionDetail({
  session,
  onClose,
}: {
  session: SessionHandoff
  onClose: () => void
}) {
  return (
    <div className={styles.detailOverlay} onClick={onClose}>
      <div className={styles.detailPanel} onClick={(e) => e.stopPropagation()}>
        <div className={styles.detailHeader}>
          <h2 className={styles.detailTitle}>Session Details</h2>
          <button className={styles.detailClose} onClick={onClose}>
            ×
          </button>
        </div>

        <div className={styles.detailBody}>
          <div className={styles.detailRow}>
            <span className={styles.detailLabel}>ID</span>
            <code className={styles.detailValue}>{session.id}</code>
          </div>
          <div className={styles.detailRow}>
            <span className={styles.detailLabel}>Status</span>
            <StatusBadge status={session.status} />
          </div>
          <div className={styles.detailRow}>
            <span className={styles.detailLabel}>Project</span>
            <span className={styles.detailValue}>{session.project}</span>
          </div>
          <div className={styles.detailRow}>
            <span className={styles.detailLabel}>From Agent</span>
            <code className={styles.detailValue}>{session.from_agent}</code>
          </div>
          <div className={styles.detailRow}>
            <span className={styles.detailLabel}>To Agent</span>
            <code className={styles.detailValue}>{session.to_agent ?? 'Not assigned'}</code>
          </div>
          <div className={styles.detailRow}>
            <span className={styles.detailLabel}>Priority</span>
            <PriorityBadge priority={session.priority} />
          </div>
          {session.claimed_by && (
            <div className={styles.detailRow}>
              <span className={styles.detailLabel}>Claimed By</span>
              <code className={styles.detailValue}>{session.claimed_by}</code>
            </div>
          )}
          <div className={styles.detailRow}>
            <span className={styles.detailLabel}>Created</span>
            <span className={styles.detailValue}>
              {session.created_at ? new Date(session.created_at).toLocaleString() : '—'}
            </span>
          </div>
          {session.expires_at && (
            <div className={styles.detailRow}>
              <span className={styles.detailLabel}>Expires</span>
              <span className={styles.detailValue}>
                {new Date(session.expires_at).toLocaleString()}
              </span>
            </div>
          )}

          {/* Task Summary */}
          <div className={styles.detailSection}>
            <h3 className={styles.detailSectionTitle}>Task Summary</h3>
            <p className={styles.detailText}>{session.task_summary}</p>
          </div>

          {/* Context */}
          {session.context && (
            <div className={styles.detailSection}>
              <h3 className={styles.detailSectionTitle}>Context</h3>
              <pre className={styles.detailCode}>{session.context}</pre>
            </div>
          )}

          {/* Timeline */}
          <div className={styles.detailSection}>
            <h3 className={styles.detailSectionTitle}>Timeline</h3>
            <div className={styles.timeline}>
              <div className={`${styles.timelineItem} ${styles.timelineDone}`}>
                <div className={styles.timelineDot} />
                <span>Created</span>
                <span className={styles.timelineTime}>
                  {session.created_at ? new Date(session.created_at).toLocaleTimeString() : '—'}
                </span>
              </div>
              <div
                className={`${styles.timelineItem} ${session.claimed_by ? styles.timelineDone : ''}`}
              >
                <div className={styles.timelineDot} />
                <span>Claimed</span>
                <span className={styles.timelineTime}>
                  {session.claimed_by ?? 'Waiting...'}
                </span>
              </div>
              <div
                className={`${styles.timelineItem} ${session.status === 'completed' ? styles.timelineDone : ''}`}
              >
                <div className={styles.timelineDot} />
                <span>Completed</span>
                <span className={styles.timelineTime}>
                  {session.status === 'completed' ? '✓' : 'Pending...'}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function SessionsPage() {
  const { data, error, isLoading, mutate } = useSWR('sessions', () => getSessions(100), {
    refreshInterval: 15000,
  })

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [selectedSession, setSelectedSession] = useState<SessionHandoff | null>(null)

  const allSessions = data?.sessions ?? []

  const filteredSessions = useMemo(() => {
    if (statusFilter === 'all') return allSessions
    return allSessions.filter((s) => s.status === statusFilter)
  }, [allSessions, statusFilter])

  const pendingCount = allSessions.filter((s) => s.status === 'pending').length
  const claimedCount = allSessions.filter((s) => s.status === 'claimed').length
  const completedCount = allSessions.filter((s) => s.status === 'completed').length

  const filterTabs: { key: StatusFilter; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: allSessions.length },
    { key: 'pending', label: '⏳ Pending', count: pendingCount },
    { key: 'claimed', label: '🔄 In Progress', count: claimedCount },
    { key: 'completed', label: '✅ Completed', count: completedCount },
  ]

  return (
    <DashboardLayout title="Sessions" subtitle="Agent task handoffs and execution tracking">
      {/* Stats */}
      <div className={styles.statsGrid}>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}>📋</span>
          <div>
            <div className={styles.statValue}>{allSessions.length}</div>
            <div className={styles.statLabel}>Total Sessions</div>
          </div>
        </div>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}>⏳</span>
          <div>
            <div className={styles.statValue}>{pendingCount}</div>
            <div className={styles.statLabel}>Pending</div>
          </div>
        </div>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}>🔄</span>
          <div>
            <div className={styles.statValue}>{claimedCount}</div>
            <div className={styles.statLabel}>In Progress</div>
          </div>
        </div>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}>✅</span>
          <div>
            <div className={styles.statValue}>{completedCount}</div>
            <div className={styles.statLabel}>Completed</div>
          </div>
        </div>
      </div>

      {/* Sessions List */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Session Handoffs</h2>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => mutate()}
            disabled={isLoading}
          >
            {isLoading ? 'Loading…' : 'Refresh'}
          </button>
        </div>

        {/* Status Filter Tabs */}
        <div className={styles.filterTabs}>
          {filterTabs.map((tab) => (
            <button
              key={tab.key}
              className={`${styles.filterTab} ${statusFilter === tab.key ? styles.filterTabActive : ''}`}
              onClick={() => setStatusFilter(tab.key)}
            >
              {tab.label}
              <span className={styles.filterCount}>{tab.count}</span>
            </button>
          ))}
        </div>

        {error && (
          <div className={styles.errorBanner}>⚠️ Failed to load sessions</div>
        )}

        {filteredSessions.length === 0 && !isLoading ? (
          <div className={`card ${styles.emptyState}`}>
            <span className={styles.emptyIcon}>⇄</span>
            <p>
              {allSessions.length > 0
                ? 'No sessions match the current filter.'
                : 'No session handoffs yet.'}
            </p>
            <p className={styles.emptyHint}>
              Sessions appear when agents start tasks via the{' '}
              <code>cortex.session.start</code> MCP tool.
            </p>
          </div>
        ) : (
          <div className={styles.sessionsGrid}>
            {filteredSessions.map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                onSelect={() => setSelectedSession(session)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Session Detail Slide-over */}
      {selectedSession && (
        <SessionDetail
          session={selectedSession}
          onClose={() => setSelectedSession(null)}
        />
      )}
    </DashboardLayout>
  )
}
