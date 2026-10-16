'use client'

// Per-task actions for the plan drawer: approve, reject, clear escalation, reroute, review history.
import { useState } from 'react'
import { EXECUTORS, reviewConductorTask, routeConductorTask } from '@/lib/api'
import type { ConductorWorker, Executor } from '@/lib/api'
import {
  actionErrorMessage, availableActions, routeBodyFromForm, routeFormFrom, type RouteForm,
} from '@/lib/conductor-plan/actions'
import type { PlanTask } from '@/lib/conductor-plan/model'
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
  const [error, setError] = useState<string | null>(null)
  const [rejecting, setRejecting] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [form, setForm] = useState<RouteForm>(() => routeFormFrom(task))

  const body = routeBodyFromForm(form, task)
  const changed = Object.keys(body).length > 0
  const models = Array.from(new Set(
    workers.flatMap((w) => w.engines.filter((e) => e.executor === form.executor).flatMap((e) => e.models)),
  )).filter((m) => m !== '*')

  async function run(call: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await call()
      onDone()
    } catch (err) {
      setError(actionErrorMessage(err))
      if (typeof err === 'object' && err !== null && (err as { status?: unknown }).status === 409) onDone()
    } finally {
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
            onClick={() => void run(() => reviewConductorTask(task.id, { verdict: 'reject', feedback: feedback.trim(), by: 'dashboard' }))}
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
            {workers.map((w) => <option key={w.agentId} value={w.agentId}>{w.agentId}</option>)}
          </select>
          <button
            className={styles.actionBtn}
            disabled={busy || !changed}
            onClick={() => void run(() => routeConductorTask(task.id, body))}
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
