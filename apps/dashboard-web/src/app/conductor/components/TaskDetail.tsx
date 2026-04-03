'use client'

import { useState, useCallback, useRef } from 'react'
import { formatJson, getResultSummary, getTaskDuration, type ConductorTask, type StructuredTaskResult } from './shared'
import { ClipboardList, Hand, CheckCircle, XCircle, Hourglass, ChevronDown, X, Trash2, ICON_INLINE } from '@/lib/icons'
import { StatusBadge, PriorityBadge, ResultDisplay } from './StatusBadge'
import { DecisionMatrix } from './DecisionMatrix'
import { LiveOutput } from './LiveOutput'
import { MarkdownRenderer } from '@/components/ui/MarkdownRenderer'
import type { FindingDecision } from '@/lib/api'
import styles from '../page.module.css'

/** Collapsible section wrapper */
function Section({
  title,
  icon,
  children,
  defaultOpen = true,
}: {
  title: string
  icon?: React.ReactNode
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={styles.detailSection}>
      <button
        className={styles.detailSectionHeader}
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <h3 className={styles.detailSectionTitle}>
          {icon}
          {title}
        </h3>
        <ChevronDown
          size={14}
          strokeWidth={2}
          className={`${styles.detailSectionChevron} ${open ? styles.detailSectionChevronOpen : ''}`}
        />
      </button>
      {open && (
        <div className={styles.detailSectionContent}>{children}</div>
      )}
    </div>
  )
}

export function TaskDetail({
  task,
  onClose,
  onCancel,
  onDelete,
  onMarkDone,
  onNewTaskFromOutcome,
}: {
  task: ConductorTask
  onClose: () => void
  onCancel: () => void
  onDelete: () => void
  onMarkDone?: () => void
  onNewTaskFromOutcome?: (task: ConductorTask) => void
}) {
  const isRunning = task.status === 'in_progress' || task.status === 'accepted' || task.status === 'analyzing'
  const isActionable = task.status === 'pending' || task.status === 'assigned' || task.status === 'accepted' || task.status === 'in_progress' || task.status === 'analyzing' || task.status === 'review'

  // Detect structured findings for DecisionMatrix
  const [decisionVersion, setDecisionVersion] = useState(0)
  const refreshDecisions = useCallback(() => setDecisionVersion((v) => v + 1), [])
  const panelRef = useRef<HTMLDivElement>(null)

  // Swipe logic
  const [touchStart, setTouchStart] = useState<number | null>(null)
  const [translateY, setTranslateY] = useState(0)

  const handleTouchStart = (e: React.TouchEvent) => {
    if (panelRef.current?.scrollTop === 0) {
      setTouchStart(e.touches[0]?.clientY ?? null)
    }
  }

  const handleTouchMove = (e: React.TouchEvent) => {
    if (touchStart === null) return
    const touchY = e.touches[0]?.clientY
    if (touchY === undefined) return
    const diff = touchY - touchStart
    if (diff > 0) {
      setTranslateY(diff)
    } else {
      setTranslateY(0)
    }
  }

  const handleTouchEnd = () => {
    if (translateY > 120) {
      onClose()
    } else {
      setTranslateY(0)
    }
    setTouchStart(null)
  }

  let structuredResult: StructuredTaskResult | null = null
  let contextDecisions: Record<string, FindingDecision> = {}
  try {
    if (task.result) {
      const parsed = JSON.parse(task.result)
      if (parsed && Array.isArray(parsed.findings) && parsed.findings.length > 0) {
        structuredResult = parsed as StructuredTaskResult
      }
    }
  } catch { /* not structured */ }
  try {
    if (task.context) {
      const ctx = JSON.parse(task.context)
      if (ctx.decisions) contextDecisions = ctx.decisions as Record<string, FindingDecision>
    }
  } catch { /* ignore */ }

  return (
    <div className={styles.detailOverlay} onClick={onClose}>
      <div 
        className={styles.detailPanel} 
        onClick={(e) => e.stopPropagation()}
        ref={panelRef}
        style={{
          transform: translateY > 0 ? `translateY(${translateY}px)` : undefined,
          transition: touchStart ? 'none' : 'transform 0.25s cubic-bezier(0.32, 0.72, 0, 1)'
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {/* Mobile drag handle */}
        <div className={styles.detailDragHandle} />

        {/* Header with status pill + close */}
        <div className={styles.detailHeader}>
          <div className={styles.detailHeaderStatus}>
            <StatusBadge status={task.status} />
            <PriorityBadge priority={task.priority} />
          </div>
          <button className={styles.detailClose} onClick={onClose} aria-label="Close">
            <X size={14} strokeWidth={2} />
          </button>
        </div>

        <div className={styles.detailBody}>
          {/* Task title as prominent heading */}
          <h2 className={styles.detailTitle} style={{ marginBottom: 'var(--space-4)', fontSize: '1.0625rem' }}>
            {task.title}
          </h2>

          {/* Compact meta grid */}
          <div className={styles.detailMetaGrid}>
            <div className={styles.detailRow}>
              <span className={styles.detailLabel}>ID</span>
              <code className={styles.detailValue}>{task.id.slice(0, 16)}…</code>
            </div>
            <div className={styles.detailRow}>
              <span className={styles.detailLabel}>Created By</span>
              <code className={styles.detailValue}>{task.created_by_agent ?? 'unknown'}</code>
            </div>
            <div className={styles.detailRow}>
              <span className={styles.detailLabel}>Assigned To</span>
              <code className={styles.detailValue}>{task.assigned_to_agent ?? 'any agent'}</code>
            </div>
            {task.completed_by && (
              <div className={styles.detailRow}>
                <span className={styles.detailLabel}>Completed By</span>
                <code className={styles.detailValue}>{task.completed_by}</code>
              </div>
            )}
            {task.parent_task_id && (
              <div className={styles.detailRow}>
                <span className={styles.detailLabel}>Parent</span>
                <code className={styles.detailValue}>{task.parent_task_id.slice(0, 16)}…</code>
              </div>
            )}
          </div>

          {/* Description with Markdown rendering */}
          {task.description && (
            <Section title="Description" defaultOpen={true}>
              <MarkdownRenderer content={task.description} />
            </Section>
          )}

          {/* Timeline */}
          <Section title="Timeline" defaultOpen={false}>
            <div className={styles.taskTimeline}>
              <div className={styles.timelineStep}>
                <span className={`${styles.timelineDot} ${styles.timelineDotActive}`} />
                <div className={styles.timelineInfo}>
                  <span className={styles.timelineLabel}><ClipboardList {...ICON_INLINE} /> Created</span>
                  <span className={styles.timelineTime}>
                    {task.created_at ? new Date(task.created_at).toLocaleString() : '--'}
                  </span>
                </div>
              </div>
              <div className={styles.timelineStep}>
                <span className={`${styles.timelineDot} ${task.accepted_at ? styles.timelineDotActive : styles.timelineDotPending}`} />
                <div className={styles.timelineInfo}>
                  <span className={styles.timelineLabel}><Hand {...ICON_INLINE} /> Accepted</span>
                  <span className={styles.timelineTime}>
                    {task.accepted_at ? new Date(task.accepted_at).toLocaleString() : 'Pending'}
                  </span>
                </div>
              </div>
              <div className={styles.timelineStep}>
                <span className={`${styles.timelineDot} ${task.completed_at ? styles.timelineDotActive : styles.timelineDotPending}`} />
                <div className={styles.timelineInfo}>
                  <span className={styles.timelineLabel}>
                    {task.status === 'completed' ? <CheckCircle {...ICON_INLINE} /> : task.status === 'failed' ? <XCircle {...ICON_INLINE} /> : <Hourglass {...ICON_INLINE} />} {task.status === 'failed' ? 'Failed' : 'Completed'}
                  </span>
                  <span className={styles.timelineTime}>
                    {task.completed_at ? `${new Date(task.completed_at).toLocaleString()} (${getTaskDuration(task)})` : 'In progress...'}
                  </span>
                </div>
              </div>
            </div>
          </Section>

          {/* Delegation Flow */}
          {(task.created_by_agent || task.assigned_to_agent || task.completed_by) && (
            <Section title="Delegation Flow" defaultOpen={false}>
              <div className={styles.delegationFlow}>
                {task.created_by_agent && (
                  <div className={styles.delegationStep}>
                    <span className={styles.delegationLabel}>Created by</span>
                    <code className={styles.delegationAgent}>{task.created_by_agent}</code>
                  </div>
                )}
                {task.assigned_to_agent && (
                  <>
                    <span className={styles.delegationArrow}>↓</span>
                    <div className={styles.delegationStep}>
                      <span className={styles.delegationLabel}>Assigned to</span>
                      <code className={styles.delegationAgent}>{task.assigned_to_agent}</code>
                    </div>
                  </>
                )}
                {task.completed_by && (
                  <>
                    <span className={styles.delegationArrow}>↓</span>
                    <div className={`${styles.delegationStep} ${styles.delegationStepDone}`}>
                      <span className={styles.delegationLabel}>Completed by</span>
                      <code className={styles.delegationAgent}>{task.completed_by}</code>
                    </div>
                  </>
                )}
              </div>
            </Section>
          )}

          {/* Result: DecisionMatrix for structured findings, or MarkdownRenderer */}
          {task.result && (
            <Section title={structuredResult ? 'Decision Matrix' : 'Result'} defaultOpen={true}>
              {structuredResult ? (
                <DecisionMatrix
                  key={decisionVersion}
                  taskId={task.id}
                  result={structuredResult}
                  decisions={contextDecisions}
                  onDecisionChange={refreshDecisions}
                />
              ) : (
                <ResultDisplay result={task.result} />
              )}
              {onNewTaskFromOutcome && (
                <button
                  className={styles.outcomeActionBtn}
                  onClick={() => { onNewTaskFromOutcome(task); onClose() }}
                >
                  New Task from Outcome
                </button>
              )}
            </Section>
          )}

          {/* Context */}
          {task.context && task.context !== '{}' && (
            <Section title="Context" defaultOpen={false}>
              <pre className={styles.detailCode}>{formatJson(task.context)}</pre>
            </Section>
          )}

          {/* Live Output */}
          <Section title={isRunning ? '● Live Output' : 'Output Log'} defaultOpen={isRunning}>
            <LiveOutput taskId={task.id} isActive={isRunning} />
          </Section>
        </div>

        {/* Sticky ghost action buttons */}
        <div className={styles.detailActions}>
          {isActionable && (
            <>
              {onMarkDone && (
                <button
                  className={`${styles.detailActionBtn} ${styles.detailActionBtnSuccess}`}
                  onClick={onMarkDone}
                >
                  <CheckCircle size={14} strokeWidth={1.5} />
                  Done
                </button>
              )}
              <button
                className={`${styles.detailActionBtn} ${styles.detailActionBtnWarning}`}
                onClick={onCancel}
              >
                Cancel
              </button>
            </>
          )}
          <button
            className={`${styles.detailActionBtn} ${styles.detailActionBtnDanger}`}
            onClick={() => { onDelete(); onClose() }}
          >
            <Trash2 size={14} strokeWidth={1.5} />
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}
