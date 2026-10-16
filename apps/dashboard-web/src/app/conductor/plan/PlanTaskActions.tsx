'use client'

// Per-task actions for the plan drawer: approve, reject, clear escalation, reroute, review history.
import { useRef, useState } from 'react'
import { EXECUTORS, reviewConductorTask, routeConductorTask } from '@/lib/api'
import type { ConductorWorker, Executor } from '@/lib/api'
import { actionErrorMessage, availableActions } from '@/lib/conductor-plan/actions'
import type { PlanTask } from '@/lib/conductor-plan/model'
import {
  modelOptions, pinOptions, routeBodyFromForm, routeFormFrom, type RouteForm,
} from '@/lib/conductor-plan/route-form'
import { formatTimeAgo } from '../components/shared'
import styles from './plan.module.css'

interface Props {
  task: PlanTask
  workers: ConductorWorker[]
  onDone: () => void
}

export function PlanTaskActions({ task, workers, onDone }: Props) {
  const avail = availableActions(task)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false) // state lags a same-tick double click; the ref does not
  const [error, setError] = useState<string | null>(null)
  const [rejecting, setRejecting] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [form, setForm] = useState<RouteForm>(() => routeFormFrom(task))
  // The form is diffed against what it showed on mount, so a poll that brings a reroute made
  // elsewhere cannot make Save send the old values back.
  const [baseline, setBaseline] = useState<RouteForm>(form)

  const body = routeBodyFromForm(form, baseline)
  const changed = Object.keys(body).length > 0
  const models = modelOptions(workers, form.executor)
  const pins = pinOptions(workers, form.pinnedAgent)

  async function run(call: () => Promise<unknown>, afterOk?: () => void) {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await call()
      afterOk?.()
      onDone()
    } catch (err) {
      setError(actionErrorMessage(err))
      if (typeof err === 'object' && err !== null && (err as { status?: unknown }).status === 409) onDone()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className={styles.actions}>
      {avail.review && (
        <div className={styles.actionRow}>
          <button
            className={styles.actionBtn}
            disabled={busy}
            onClick={() => void run(() => reviewConductorTask(task.id, { verdict: 'approve', by: 'dashboard' }))}
          >
            Approve
          </button>
          <button className={styles.actionBtn} disabled={busy} onClick={() => setRejecting((v) => !v)}>
            Reject
          </button>
        </div>
      )}
      {avail.review && rejecting && (
        <div className={styles.actionForm}>
          <textarea
            className={styles.actionInput}
            rows={3}
            placeholder="Feedback for the worker (required)"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
          />
          <button
            className={styles.actionBtn}
            disabled={busy || feedback.trim() === ''}
            onClick={() => void run(() => reviewConductorTask(task.id, { verdict: 'reject', feedback: feedback.trim(), by: 'dashboard' }), () => {
              setRejecting(false)
              setFeedback('')
            })}
          >
            Send rejection
          </button>
        </div>
      )}
      {avail.clearEscalation && (
        <button
          className={styles.actionBtn}
          disabled={busy}
          onClick={() => void run(() => routeConductorTask(task.id, { clearEscalation: true }))}
        >
          Clear escalation
        </button>
      )}
      {avail.route && (
        <div className={styles.actionForm}>
          <div className={styles.actionLabel}>Route</div>
          <select
            className={styles.actionInput}
            aria-label="Executor"
            value={form.executor}
            onChange={(e) => setForm({ ...form, executor: e.target.value as Executor | '' })}
          >
            <option value="">any</option>
            {EXECUTORS.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
          <input
            className={styles.actionInput}
            aria-label="Model"
            placeholder="model"
            list={`models-${task.id}`}
            value={form.model}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
          />
          <datalist id={`models-${task.id}`}>
            {models.map((m) => <option key={m} value={m} />)}
          </datalist>
          <input
            className={styles.actionInput}
            aria-label="Effort"
            placeholder="effort"
            value={form.effort}
            onChange={(e) => setForm({ ...form, effort: e.target.value })}
          />
          <select
            className={styles.actionInput}
            aria-label="Pinned agent"
            value={form.pinnedAgent}
            onChange={(e) => setForm({ ...form, pinnedAgent: e.target.value })}
          >
            <option value="">any</option>
            {pins.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button
            className={styles.actionBtn}
            disabled={busy || !changed}
            onClick={() => {
              if (task.state === 'running' &&
                !window.confirm('This stops the running attempt and restarts it on the new route. Continue?')) return
              void run(() => routeConductorTask(task.id, body), () => setBaseline(form))
            }}
          >
            Save route
          </button>
        </div>
      )}
      {error && <div className={styles.actionError} role="alert">{error}</div>}
      {task.reviews.length > 0 && (
        <div className={styles.actionForm}>
          <div className={styles.actionLabel}>Review history</div>
          {task.reviews.map((r, i) => (
            <div key={`${r.at}-${i}`} className={styles.reviewLine}>
              {r.by} · {r.verdict}{r.feedback ? ` · ${r.feedback}` : ''} · {formatTimeAgo(r.at)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
