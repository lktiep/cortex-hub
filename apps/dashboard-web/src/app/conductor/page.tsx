'use client'

import { useState, useMemo, useCallback } from 'react'
import DashboardLayout from '@/components/layout/DashboardLayout'
import useSWR from 'swr'
import {
  getConductorTasks,
  getConductorAgents,
  createConductorTask,
  cancelConductorTask,
  deleteConductorTask,
  type ConductorTask,
  type ConductorAgent,
} from '@/lib/api'
import styles from './page.module.css'

// ── Types ──
type StatusFilter = 'all' | 'pending' | 'assigned' | 'accepted' | 'in_progress' | 'review' | 'completed' | 'failed' | 'cancelled'

// ── Helpers ──
function formatTimeAgo(dateStr: string): string {
  const now = new Date()
  const past = new Date(dateStr)
  const diff = Math.floor((now.getTime() - past.getTime()) / 1000)
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function formatJson(value: string | null): string {
  if (!value) return ''
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

// ── Components ──
function StatusBadge({ status }: { status: string }) {
  const variant =
    status === 'completed'
      ? 'healthy'
      : status === 'in_progress'
        ? 'warning'
        : status === 'pending'
          ? 'warning'
          : status === 'failed'
            ? 'error'
            : 'error'
  const label = status.replace('_', ' ')
  return <span className={`badge badge-${variant}`}>{label}</span>
}

function PriorityBadge({ priority }: { priority: number }) {
  const label = priority <= 3 ? 'high' : priority <= 6 ? 'medium' : 'low'
  const variant = priority <= 3 ? 'error' : priority <= 6 ? 'warning' : 'healthy'
  return (
    <span className={`badge badge-${variant}`}>
      {label} ({priority})
    </span>
  )
}

function TaskCard({
  task,
  onSelect,
  onCancel,
  onDelete,
}: {
  task: ConductorTask
  onSelect: () => void
  onCancel: () => void
  onDelete: () => void
}) {
  const statusClass =
    task.status === 'pending'
      ? styles.taskCardPending
      : task.status === 'in_progress'
        ? styles.taskCardInProgress
        : task.status === 'completed'
          ? styles.taskCardCompleted
          : task.status === 'failed'
            ? styles.taskCardFailed
            : styles.taskCardCancelled

  return (
    <div className={`card ${styles.taskCard} ${statusClass}`} onClick={onSelect}>
      <div className={styles.taskHeader}>
        <h3 className={styles.taskTitle}>{task.title}</h3>
        <StatusBadge status={task.status} />
      </div>

      {task.description && (
        <p className={styles.taskDescription}>{task.description}</p>
      )}

      <div className={styles.taskMeta}>
        <div className={styles.metaItem}>
          <span className={styles.metaLabel}>Created by</span>
          <code className={styles.agentName}>{task.created_by_agent ?? 'unknown'}</code>
        </div>
        <div className={styles.metaItem}>
          <span className={styles.metaLabel}>Assigned to</span>
          <code className={styles.agentName}>{task.assigned_to_agent ?? 'any'}</code>
        </div>
        <div className={styles.metaItem}>
          <span className={styles.metaLabel}>Priority</span>
          <PriorityBadge priority={task.priority} />
        </div>
        {task.completed_by && (
          <div className={styles.metaItem}>
            <span className={styles.metaLabel}>Completed by</span>
            <code className={styles.agentName}>{task.completed_by}</code>
          </div>
        )}
      </div>

      <div className={styles.taskFooter}>
        <span className={styles.timestamp}>
          {task.created_at ? formatTimeAgo(task.created_at) : '--'}
        </span>
        <div className={styles.taskActions} onClick={(e) => e.stopPropagation()}>
          {(task.status === 'pending' || task.status === 'in_progress') && (
            <button className={`${styles.actionBtn} ${styles.actionBtnDanger}`} onClick={onCancel}>
              Cancel
            </button>
          )}
          <button className={`${styles.actionBtn} ${styles.actionBtnDanger}`} onClick={onDelete}>
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}

function TaskDetail({
  task,
  onClose,
  onCancel,
  onDelete,
}: {
  task: ConductorTask
  onClose: () => void
  onCancel: () => void
  onDelete: () => void
}) {
  return (
    <div className={styles.detailOverlay} onClick={onClose}>
      <div className={styles.detailPanel} onClick={(e) => e.stopPropagation()}>
        <div className={styles.detailHeader}>
          <h2 className={styles.detailTitle}>Task Details</h2>
          <button className={styles.detailClose} onClick={onClose}>
            x
          </button>
        </div>

        <div className={styles.detailBody}>
          <div className={styles.detailRow}>
            <span className={styles.detailLabel}>ID</span>
            <code className={styles.detailValue}>{task.id}</code>
          </div>
          <div className={styles.detailRow}>
            <span className={styles.detailLabel}>Status</span>
            <StatusBadge status={task.status} />
          </div>
          <div className={styles.detailRow}>
            <span className={styles.detailLabel}>Priority</span>
            <PriorityBadge priority={task.priority} />
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
          <div className={styles.detailRow}>
            <span className={styles.detailLabel}>Created</span>
            <span className={styles.detailValue}>
              {task.created_at ? new Date(task.created_at).toLocaleString() : '--'}
            </span>
          </div>
          {task.accepted_at && (
            <div className={styles.detailRow}>
              <span className={styles.detailLabel}>Started</span>
              <span className={styles.detailValue}>
                {new Date(task.accepted_at).toLocaleString()}
              </span>
            </div>
          )}
          {task.completed_at && (
            <div className={styles.detailRow}>
              <span className={styles.detailLabel}>Completed</span>
              <span className={styles.detailValue}>
                {new Date(task.completed_at).toLocaleString()}
              </span>
            </div>
          )}

          {/* Title & Description */}
          <div className={styles.detailSection}>
            <h3 className={styles.detailSectionTitle}>Title</h3>
            <p className={styles.detailText}>{task.title}</p>
          </div>

          {task.description && (
            <div className={styles.detailSection}>
              <h3 className={styles.detailSectionTitle}>Description</h3>
              <p className={styles.detailText}>{task.description}</p>
            </div>
          )}

          {/* Result */}
          {task.result && (
            <div className={styles.detailSection}>
              <h3 className={styles.detailSectionTitle}>Result</h3>
              <pre className={styles.detailCode}>{formatJson(task.result)}</pre>
            </div>
          )}

          {/* Context */}
          {task.context && task.context !== '{}' && (
            <div className={styles.detailSection}>
              <h3 className={styles.detailSectionTitle}>Context</h3>
              <pre className={styles.detailCode}>{formatJson(task.context)}</pre>
            </div>
          )}

          {/* Actions */}
          <div className={styles.detailActions}>
            {(task.status === 'pending' || task.status === 'in_progress') && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => { onCancel(); onClose() }}
              >
                Cancel Task
              </button>
            )}
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => { onDelete(); onClose() }}
              style={{ borderColor: 'var(--status-error)', color: 'var(--status-error)' }}
            >
              Delete Task
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function CreateTaskForm({
  onClose,
  onCreated,
  agents,
}: {
  onClose: () => void
  onCreated: () => void
  agents: ConductorAgent[]
}) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [assignedTo, setAssignedTo] = useState('')
  const [priority, setPriority] = useState(5)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    setSubmitting(true)
    try {
      await createConductorTask({
        title: title.trim(),
        description: description.trim() || undefined,
        assignedTo: assignedTo.trim() || undefined,
        priority,
        agentId: 'dashboard-ui',
      })
      onCreated()
      onClose()
    } catch (err) {
      console.error('Failed to create task:', err)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={styles.formOverlay} onClick={onClose}>
      <div className={styles.formPanel} onClick={(e) => e.stopPropagation()}>
        <h2 className={styles.formTitle}>Create Task</h2>
        <form onSubmit={handleSubmit}>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Title *</label>
            <input
              className={styles.formInput}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Task title"
              required
            />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Description</label>
            <textarea
              className={styles.formTextarea}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Task description (optional)"
            />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Assign to agent</label>
            <select
              className={styles.formInput}
              value={assignedTo}
              onChange={(e) => setAssignedTo(e.target.value)}
            >
              <option value="">Any agent</option>
              {agents.map((agent) => (
                <option key={agent.agentId} value={agent.agentId}>
                  {agent.agentId}{agent.ide ? ` (${agent.ide})` : ''}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Priority (1=highest, 10=lowest)</label>
            <input
              className={styles.formInput}
              type="number"
              min={1}
              max={10}
              value={priority}
              onChange={(e) => setPriority(Number(e.target.value))}
            />
          </div>
          <div className={styles.formActions}>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary btn-sm" disabled={submitting || !title.trim()}>
              {submitting ? 'Creating...' : 'Create Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function ConductorPage() {
  const { data, error, isLoading, mutate } = useSWR('conductor-tasks', () => getConductorTasks({ limit: 200 }), {
    refreshInterval: 10000,
  })
  const { data: agentsData } = useSWR('conductor-agents', getConductorAgents, {
    refreshInterval: 5000,
  })

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [selectedTask, setSelectedTask] = useState<ConductorTask | null>(null)
  const [showCreateForm, setShowCreateForm] = useState(false)

  const allTasks = data?.tasks ?? []
  const agents = agentsData?.agents ?? []
  const onlineCount = agentsData?.online ?? agents.length

  const filteredTasks = useMemo(() => {
    if (statusFilter === 'all') return allTasks
    return allTasks.filter((t) => t.status === statusFilter)
  }, [allTasks, statusFilter])

  const counts = useMemo(() => ({
    all: allTasks.length,
    pending: allTasks.filter((t) => t.status === 'pending').length,
    in_progress: allTasks.filter((t) => t.status === 'in_progress').length,
    completed: allTasks.filter((t) => t.status === 'completed').length,
    failed: allTasks.filter((t) => t.status === 'failed').length,
    cancelled: allTasks.filter((t) => t.status === 'cancelled').length,
  }), [allTasks])

  const handleCancel = useCallback(async (id: string) => {
    try {
      await cancelConductorTask(id)
      mutate()
    } catch (err) {
      console.error('Failed to cancel task:', err)
    }
  }, [mutate])

  const handleDelete = useCallback(async (id: string) => {
    try {
      await deleteConductorTask(id)
      mutate()
    } catch (err) {
      console.error('Failed to delete task:', err)
    }
  }, [mutate])

  const filterTabs: { key: StatusFilter; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: counts.all },
    { key: 'pending', label: 'Pending', count: counts.pending },
    { key: 'in_progress', label: 'In Progress', count: counts.in_progress },
    { key: 'completed', label: 'Completed', count: counts.completed },
    { key: 'failed', label: 'Failed', count: counts.failed },
    { key: 'cancelled', label: 'Cancelled', count: counts.cancelled },
  ]

  return (
    <DashboardLayout title="Conductor" subtitle="Task assignment and agent orchestration">
      {/* Stats */}
      <div className={styles.statsGrid}>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}>T</span>
          <div>
            <div className={styles.statValue}>{counts.all}</div>
            <div className={styles.statLabel}>Total Tasks</div>
          </div>
        </div>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}>P</span>
          <div>
            <div className={styles.statValue}>{counts.pending}</div>
            <div className={styles.statLabel}>Pending</div>
          </div>
        </div>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}>R</span>
          <div>
            <div className={styles.statValue}>{counts.in_progress}</div>
            <div className={styles.statLabel}>Running</div>
          </div>
        </div>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}>D</span>
          <div>
            <div className={styles.statValue}>{counts.completed}</div>
            <div className={styles.statLabel}>Done</div>
          </div>
        </div>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}>F</span>
          <div>
            <div className={styles.statValue}>{counts.failed}</div>
            <div className={styles.statLabel}>Failed</div>
          </div>
        </div>
      </div>

      {/* Agents Online */}
      {agents.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>
              Agents <span className={styles.filterCount}>{onlineCount} online</span>
            </h2>
          </div>
          <div className={styles.agentsGrid}>
            {agents.map((agent: ConductorAgent) => (
              <div key={agent.agentId} className={`card ${styles.agentCard}`}>
                <div className={styles.agentHeader}>
                  <span className={`${styles.agentDot} ${styles.agentOnline}`} />
                  <strong>{agent.agentId}</strong>
                </div>
                <div className={styles.agentMeta}>
                  {agent.hostname && <span>Host: {agent.hostname}</span>}
                  {agent.ide && <span>IDE: {agent.ide}</span>}
                  <span>Owner: {agent.apiKeyOwner}</span>
                  <span>Connected: {new Date(agent.connectedAt).toLocaleTimeString()}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tasks Section */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Tasks</h2>
          <div className={styles.headerActions}>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => setShowCreateForm(true)}
            >
              + New Task
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => mutate()}
              disabled={isLoading}
            >
              {isLoading ? 'Loading...' : 'Refresh'}
            </button>
          </div>
        </div>

        {/* Filter Tabs */}
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
          <div className={styles.errorBanner}>Failed to load tasks</div>
        )}

        {filteredTasks.length === 0 && !isLoading ? (
          <div className={`card ${styles.emptyState}`}>
            <span className={styles.emptyIcon}>T</span>
            <p>
              {allTasks.length > 0
                ? 'No tasks match the current filter.'
                : 'No conductor tasks yet.'}
            </p>
            <p className={styles.emptyHint}>
              Create tasks via the dashboard or the <code>cortex_task_create</code> MCP tool.
            </p>
          </div>
        ) : (
          <div className={styles.tasksGrid}>
            {filteredTasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                onSelect={() => setSelectedTask(task)}
                onCancel={() => handleCancel(task.id)}
                onDelete={() => handleDelete(task.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Task Detail Slide-over */}
      {selectedTask && (
        <TaskDetail
          task={selectedTask}
          onClose={() => setSelectedTask(null)}
          onCancel={() => handleCancel(selectedTask.id)}
          onDelete={() => handleDelete(selectedTask.id)}
        />
      )}

      {/* Create Task Modal */}
      {showCreateForm && (
        <CreateTaskForm
          onClose={() => setShowCreateForm(false)}
          onCreated={() => mutate()}
          agents={agents}
        />
      )}
    </DashboardLayout>
  )
}
