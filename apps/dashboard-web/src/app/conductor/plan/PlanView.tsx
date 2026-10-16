'use client'

// Plan view: full-screen overlay for one plan tree — phase tabs, progress, diagram, side panel and task detail.
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import useSWR from 'swr'
import { cancelConductorTask, deleteConductorTask, getConductorTree } from '@/lib/api'
import { actionErrorMessage } from '@/lib/conductor-plan/actions'
import { criticalPath } from '@/lib/conductor-plan/analysis'
import { computeDepths, selectPhase } from '@/lib/conductor-plan/layout'
import { toPlanTasks } from '@/lib/conductor-plan/model'
import {
  awaitingLead,
  groupTabs,
  needsYou,
  progressCounts,
  routeTally,
  workerRows,
} from '@/lib/conductor-plan/summary'
import { TaskDetail } from '../components/TaskDetail'
import { PlanDiagram } from './PlanDiagram'
import { PlanProgress } from './PlanProgress'
import { PlanSidePanel } from './PlanSidePanel'
import { PlanTaskActions } from './PlanTaskActions'
import styles from './plan.module.css'

const isNotFound = (err: unknown) => (err as { status?: unknown } | null)?.status === 404

export function PlanView({ rootId, onClose }: { rootId: string; onClose: () => void }) {
  const { data, error, mutate } = useSWR(
    ['conductor-tree', rootId],
    () => getConductorTree(rootId),
    { refreshInterval: 5000, keepPreviousData: true },
  )
  const [pickedGroup, setGroupId] = useState<string | null>(null)
  const [pickedId, setSelectedId] = useState<string | undefined>(undefined)
  const [actionError, setActionError] = useState<string | null>(null)
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  // The overlay covers the page; keep the page from scrolling underneath it.
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [])

  const tasks = useMemo(() => (data ? toPlanTasks(data.root, data.tasks) : []), [data])
  const workers = useMemo(() => data?.workers ?? [], [data])
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks])
  const tabs = useMemo(() => groupTabs(tasks), [tasks])
  // A tab or selection that vanished from a refreshed tree falls back to All / no selection.
  const groupId = pickedGroup !== null && tabs.some((t) => t.id === pickedGroup) ? pickedGroup : null
  const selectedId = pickedId !== undefined && byId.has(pickedId) ? pickedId : undefined
  const phase = useMemo(() => (groupId ? selectPhase(tasks, groupId) : undefined), [tasks, groupId])
  const side = useMemo(() => {
    const { cyclic } = computeDepths(tasks)
    return {
      counts: progressCounts(tasks),
      needs: needsYou(tasks),
      awaiting: awaitingLead(tasks),
      tally: routeTally(tasks),
      critical: criticalPath(tasks, cyclic),
      workerRows: workerRows(workers, tasks, new Date()),
    }
  }, [tasks, workers])

  const selected = selectedId ? byId.get(selectedId) : undefined
  const drawable = tasks.some((t) => t.kind !== 'group')
  const title = data?.root.title ?? 'Plan'

  const handleCancel = async (id: string) => {
    setActionError(null)
    try {
      await cancelConductorTask(id)
    } catch (err) {
      setActionError(actionErrorMessage(err))
    }
    void mutate()
  }
  /** Resolves true only when the task was actually deleted (not cancelled at the prompt, not refused). */
  const handleDelete = async (id: string): Promise<boolean> => {
    if (!window.confirm('Delete this task permanently?')) return false
    setActionError(null)
    try {
      await deleteConductorTask(id)
      setSelectedId(undefined)
      void mutate()
      return true
    } catch (err) {
      setActionError(actionErrorMessage(err))
      void mutate()
      return false
    }
  }

  let body: React.ReactNode
  if (error && isNotFound(error)) {
    body = (
      <div className={styles.state}>
        <p>This plan no longer exists</p>
        <button type="button" className={styles.btn} onClick={onClose}>Close</button>
      </div>
    )
  } else if (error && !data) {
    body = (
      <div className={styles.state}>
        <p>{error instanceof Error ? error.message : 'Failed to load the plan'}</p>
        <button type="button" className={styles.btn} onClick={() => void mutate()}>Retry</button>
      </div>
    )
  } else if (!data) {
    body = <div className={styles.state}><p>Loading plan…</p></div>
  } else if (!drawable) {
    body = <div className={styles.state}><p>This plan has no tasks yet</p></div>
  } else {
    body = (
      <>
        <PlanProgress counts={side.counts} />
        <div className={styles.viewBody}>
          <div className={styles.viewDiagram}>
            <PlanDiagram
              tasks={tasks}
              workers={workers}
              phase={phase}
              selectedId={selectedId}
              onSelect={setSelectedId}
              viewKey={`${rootId}:${groupId ?? ''}`}
            />
          </div>
          <PlanSidePanel
            needs={side.needs}
            awaiting={side.awaiting}
            workers={side.workerRows}
            tally={side.tally}
            critical={side.critical}
            byId={byId}
            onSelect={setSelectedId}
          />
        </div>
      </>
    )
  }

  if (!mounted) return null
  return createPortal(
    <div className={styles.viewOverlay}>
      <header className={styles.viewHeader}>
        <h2>{title}</h2>
        <div className={styles.tabs}>
          <button
            type="button"
            className={`${styles.tab} ${groupId === null ? styles.tabActive : ''}`}
            onClick={() => setGroupId(null)}
          >
            All
          </button>
          {!isNotFound(error) && tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`${styles.tab} ${groupId === tab.id ? styles.tabActive : ''}`}
              onClick={() => setGroupId(tab.id)}
            >
              {tab.label} <small>{tab.count} · {Math.round(tab.days * 10) / 10} d</small>
            </button>
          ))}
        </div>
        {error && !isNotFound(error) && data && <span className={styles.note}>Refresh failed — retrying</span>}
        {actionError && (
          <span className={styles.headerError} role="alert">
            {actionError}
            <button type="button" aria-label="Dismiss error" onClick={() => setActionError(null)}>×</button>
          </span>
        )}
        <button type="button" className={styles.btn} onClick={onClose}>× Close</button>
      </header>
      {body}
      {selected && (
        <TaskDetail
          task={selected.row}
          onClose={() => setSelectedId(undefined)}
          onCancel={() => void handleCancel(selected.id)}
          onDelete={() => handleDelete(selected.id)}
          actions={
            <PlanTaskActions key={selected.id} task={selected} workers={workers} onDone={() => void mutate()} />
          }
        />
      )}
    </div>,
    document.body,
  )
}
