'use client'

import { useState, useMemo, useCallback } from 'react'
import DashboardLayout from '@/components/layout/DashboardLayout'
import useSWR from 'swr'
import {
  getTasks,
  getTaskBoard,
  getTaskLogs,
  createTask,
  getSessions,
  type ConductorTask,
  type SessionHandoff,
} from '@/lib/api'
import styles from './page.module.css'

// ── Helpers ──

function TimeAgo({ date }: { date: string }) {
  const now = new Date()
  const past = new Date(date)
  const diff = Math.floor((now.getTime() - past.getTime()) / 1000)
  if (diff < 60) return <span>{diff}s ago</span>
  if (diff < 3600) return <span>{Math.floor(diff / 60)}m ago</span>
  if (diff < 86400) return <span>{Math.floor(diff / 3600)}h ago</span>
  return <span>{Math.floor(diff / 86400)}d ago</span>
}

function PriorityBadge({ priority }: { priority: number }) {
  const label = priority <= 3 ? 'high' : priority <= 6 ? 'medium' : 'low'
  const variant = priority <= 3 ? 'error' : priority <= 6 ? 'warning' : 'healthy'
  return (
    <span className={`badge badge-${variant}`}>
      {label}
    </span>
  )
}

function TaskStatusBadge({ status }: { status: string }) {
  const variant =
    status === 'completed' ? 'healthy'
      : status === 'failed' || status === 'cancelled' ? 'error'
        : status === 'in_progress' || status === 'accepted' ? 'warning'
          : 'warning'
  const labels: Record<string, string> = {
    pending: '⏳ Pending',
    assigned: '📋 Assigned',
    accepted: '✋ Accepted',
    in_progress: '🔄 Active',
    review: '👀 Review',
    completed: '✅ Done',
    failed: '❌ Failed',
    cancelled: '⛔ Cancelled',
  }
  return <span className={`badge badge-${variant}`}>{labels[status] ?? status}</span>
}

function OsBadge({ os }: { os: string }) {
  const icon =
    os?.toLowerCase().includes('darwin') || os?.toLowerCase().includes('mac') ? '🍎'
      : os?.toLowerCase().includes('win') ? '🪟'
        : os?.toLowerCase().includes('linux') ? '🐧'
          : '💻'
  return <span className={styles.osBadge}>{icon}</span>
}

// ── Derive agent from sessions ──
interface AgentInfo {
  name: string
  os: string
  isOnline: boolean
  currentTask: string | null
  sessionCount: number
}

function deriveAgents(sessions: SessionHandoff[]): AgentInfo[] {
  const agentMap = new Map<string, AgentInfo>()
  for (const s of sessions) {
    const name = s.api_key_name || s.from_agent
    if (!name) continue
    const existing = agentMap.get(name)
    if (existing) {
      existing.sessionCount++
      if (s.status === 'claimed' || s.status === 'pending') {
        existing.isOnline = true
        existing.currentTask = s.task_summary
      }
    } else {
      agentMap.set(name, {
        name,
        os: '',
        isOnline: s.status === 'claimed' || s.status === 'pending',
        currentTask: (s.status === 'claimed' || s.status === 'pending') ? s.task_summary : null,
        sessionCount: 1,
      })
    }
  }
  return Array.from(agentMap.values())
}

// ── Agent Card ──

function AgentCard({
  agent,
  isSelected,
  onSelect,
}: {
  agent: AgentInfo
  isSelected: boolean
  onSelect: () => void
}) {
  return (
    <div
      className={`${styles.agentCard} ${isSelected ? styles.agentCardSelected : ''}`}
      onClick={onSelect}
    >
      <div className={styles.agentHeader}>
        <span className={`status-dot ${agent.isOnline ? 'healthy' : 'error'}`} />
        <code className={styles.agentName}>{agent.name}</code>
        {agent.os && <OsBadge os={agent.os} />}
      </div>
      {agent.currentTask && (
        <p className={styles.agentTask}>{agent.currentTask}</p>
      )}
      <div className={styles.agentMeta}>
        <span className={styles.agentMetaItem}>
          {agent.sessionCount} session{agent.sessionCount !== 1 ? 's' : ''}
        </span>
      </div>
    </div>
  )
}

// ── Task Card ──

function TaskCard({
  task,
  isSelected,
  onSelect,
}: {
  task: ConductorTask
  isSelected: boolean
  onSelect: () => void
}) {
  return (
    <div
      className={`${styles.taskCard} ${isSelected ? styles.taskCardSelected : ''}`}
      onClick={onSelect}
    >
      <div className={styles.taskCardHeader}>
        <span className={styles.taskTitle}>{task.title}</span>
        <PriorityBadge priority={task.priority} />
      </div>
      {task.assigned_to_agent && (
        <div className={styles.taskAssignee}>
          <span className="status-dot healthy" />
          <code>{task.assigned_to_agent}</code>
        </div>
      )}
      <div className={styles.taskCardFooter}>
        <TaskStatusBadge status={task.status} />
        {task.created_at && (
          <span className={styles.taskTime}>
            <TimeAgo date={task.created_at} />
          </span>
        )}
      </div>
    </div>
  )
}

// ── Task Detail Panel ──

function TaskDetail({
  task,
  onClose,
}: {
  task: ConductorTask
  onClose: () => void
}) {
  const { data: logsData } = useSWR(
    `task-logs-${task.id}`,
    () => getTaskLogs(task.id),
    { refreshInterval: 5000 }
  )
  const logs = logsData?.logs ?? []

  return (
    <div className={styles.detailPanel}>
      <div className={styles.detailHeader}>
        <h3 className={styles.detailTitle}>Task Detail</h3>
        <button className={styles.detailClose} onClick={onClose}>×</button>
      </div>

      <div className={styles.detailBody}>
        {/* Info rows */}
        <div className={styles.detailRow}>
          <span className={styles.detailLabel}>Title</span>
          <span className={styles.detailValue}>{task.title}</span>
        </div>
        <div className={styles.detailRow}>
          <span className={styles.detailLabel}>Status</span>
          <TaskStatusBadge status={task.status} />
        </div>
        <div className={styles.detailRow}>
          <span className={styles.detailLabel}>Priority</span>
          <PriorityBadge priority={task.priority} />
        </div>
        <div className={styles.detailRow}>
          <span className={styles.detailLabel}>Agent</span>
          <code className={styles.detailValue}>{task.assigned_to_agent ?? 'Unassigned'}</code>
        </div>
        <div className={styles.detailRow}>
          <span className={styles.detailLabel}>Created By</span>
          <code className={styles.detailValue}>{task.created_by_agent ?? '—'}</code>
        </div>
        <div className={styles.detailRow}>
          <span className={styles.detailLabel}>Created</span>
          <span className={styles.detailValue}>
            {task.created_at ? new Date(task.created_at).toLocaleString() : '—'}
          </span>
        </div>
        {task.completed_at && (
          <div className={styles.detailRow}>
            <span className={styles.detailLabel}>Completed</span>
            <span className={styles.detailValue}>
              {new Date(task.completed_at).toLocaleString()}
            </span>
          </div>
        )}

        {/* Description */}
        <div className={styles.detailSection}>
          <h4 className={styles.detailSectionTitle}>Description</h4>
          <p className={styles.detailText}>{task.description}</p>
        </div>

        {/* Result */}
        {task.result && (
          <div className={styles.detailSection}>
            <h4 className={styles.detailSectionTitle}>Result</h4>
            <pre className={styles.detailCode}>{task.result}</pre>
          </div>
        )}

        {/* Context */}
        {task.context && task.context !== '{}' && (
          <div className={styles.detailSection}>
            <h4 className={styles.detailSectionTitle}>Context</h4>
            <pre className={styles.detailCode}>{task.context}</pre>
          </div>
        )}

        {/* Activity Log */}
        <div className={styles.detailSection}>
          <h4 className={styles.detailSectionTitle}>Activity Log</h4>
          {logs.length === 0 ? (
            <p className={styles.detailTextMuted}>No activity yet.</p>
          ) : (
            <div className={styles.activityLog}>
              {logs.map((log) => (
                <div key={log.id} className={styles.logEntry}>
                  <div className={styles.logDot} />
                  <div className={styles.logContent}>
                    <span className={styles.logAction}>{log.action}</span>
                    {log.message && <span className={styles.logMessage}>{log.message}</span>}
                    <span className={styles.logTime}>
                      {log.agent_id && <code>{log.agent_id}</code>}
                      {log.created_at && <> · <TimeAgo date={log.created_at} /></>}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Create Task Dialog ──

function CreateTaskDialog({
  agents,
  onClose,
  onCreated,
}: {
  agents: AgentInfo[]
  onClose: () => void
  onCreated: () => void
}) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [assignTo, setAssignTo] = useState('')
  const [priority, setPriority] = useState(5)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSubmit = useCallback(async () => {
    if (!title.trim() || !description.trim()) return
    setIsSubmitting(true)
    try {
      await createTask({
        title: title.trim(),
        description: description.trim(),
        assignTo: assignTo || undefined,
        priority,
      })
      onCreated()
      onClose()
    } catch {
      // error handled by ApiError
    } finally {
      setIsSubmitting(false)
    }
  }, [title, description, assignTo, priority, onCreated, onClose])

  return (
    <div className={styles.dialogOverlay} onClick={onClose}>
      <div className={styles.dialogPanel} onClick={(e) => e.stopPropagation()}>
        <div className={styles.dialogHeader}>
          <h3 className={styles.dialogTitle}>New Task</h3>
          <button className={styles.detailClose} onClick={onClose}>×</button>
        </div>

        <div className={styles.dialogBody}>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Title</label>
            <input
              className="input"
              placeholder="Task title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          </div>

          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Description</label>
            <textarea
              className={`input ${styles.textarea}`}
              placeholder="What should be done?"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
            />
          </div>

          <div className={styles.formRow}>
            <div className={styles.formGroup}>
              <label className={styles.formLabel}>Assign to</label>
              <select
                className="input"
                value={assignTo}
                onChange={(e) => setAssignTo(e.target.value)}
              >
                <option value="">Unassigned</option>
                {agents.map((a) => (
                  <option key={a.name} value={a.name}>{a.name}</option>
                ))}
              </select>
            </div>

            <div className={styles.formGroup}>
              <label className={styles.formLabel}>Priority (1-10)</label>
              <input
                className="input"
                type="number"
                min={1}
                max={10}
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
              />
            </div>
          </div>
        </div>

        <div className={styles.dialogFooter}>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={handleSubmit}
            disabled={isSubmitting || !title.trim() || !description.trim()}
          >
            {isSubmitting ? 'Creating…' : 'Create Task'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Kanban Column ──

function KanbanColumn({
  title,
  icon,
  tasks,
  selectedTaskId,
  onSelectTask,
}: {
  title: string
  icon: string
  tasks: ConductorTask[]
  selectedTaskId: string | null
  onSelectTask: (task: ConductorTask) => void
}) {
  return (
    <div className={styles.kanbanColumn}>
      <div className={styles.kanbanColumnHeader}>
        <span>{icon} {title}</span>
        <span className={styles.kanbanCount}>{tasks.length}</span>
      </div>
      <div className={styles.kanbanColumnBody}>
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            isSelected={task.id === selectedTaskId}
            onSelect={() => onSelectTask(task)}
          />
        ))}
        {tasks.length === 0 && (
          <div className={styles.kanbanEmpty}>No tasks</div>
        )}
      </div>
    </div>
  )
}

// ── Main Page ──

export default function ConductorPage() {
  // Data fetching
  const { data: boardData, mutate: mutateBoard } = useSWR(
    'conductor-board',
    getTaskBoard,
    { refreshInterval: 5000 }
  )
  const { data: allTasksData, mutate: mutateTasks } = useSWR(
    'conductor-tasks',
    () => getTasks(),
    { refreshInterval: 5000 }
  )
  const { data: sessionsData } = useSWR(
    'conductor-sessions',
    () => getSessions(100),
    { refreshInterval: 10000 }
  )

  // State
  const [selectedTask, setSelectedTask] = useState<ConductorTask | null>(null)
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [showCreateDialog, setShowCreateDialog] = useState(false)

  // Derived
  const agents = useMemo(
    () => deriveAgents(sessionsData?.sessions ?? []),
    [sessionsData]
  )

  const allTasks = allTasksData?.tasks ?? []

  // Kanban columns — use board endpoint if available, else derive from allTasks
  const columns = useMemo(() => {
    if (boardData?.columns) {
      return boardData.columns
    }
    // Fallback: group allTasks by status
    const pending: ConductorTask[] = []
    const inProgress: ConductorTask[] = []
    const completed: ConductorTask[] = []
    for (const t of allTasks) {
      if (t.status === 'completed') completed.push(t)
      else if (t.status === 'in_progress' || t.status === 'accepted' || t.status === 'assigned') inProgress.push(t)
      else if (t.status === 'failed' || t.status === 'cancelled') completed.push(t)
      else pending.push(t)
    }
    return { pending, in_progress: inProgress, completed }
  }, [boardData, allTasks])

  // Filter tasks by selected agent
  const filteredColumns = useMemo(() => {
    if (!selectedAgent) return columns
    const filtered: Record<string, ConductorTask[]> = {}
    for (const [key, tasks] of Object.entries(columns)) {
      filtered[key] = tasks.filter(
        (t) => t.assigned_to_agent === selectedAgent || t.created_by_agent === selectedAgent
      )
    }
    return filtered
  }, [columns, selectedAgent])

  // Stats
  const totalTasks = allTasks.length
  const pendingCount = allTasks.filter((t) => t.status === 'pending').length
  const activeCount = allTasks.filter((t) =>
    ['assigned', 'accepted', 'in_progress', 'review'].includes(t.status)
  ).length
  const completedCount = allTasks.filter((t) => t.status === 'completed').length

  const handleRefresh = useCallback(() => {
    mutateBoard()
    mutateTasks()
  }, [mutateBoard, mutateTasks])

  return (
    <DashboardLayout title="Conductor" subtitle="Multi-agent task orchestration board">
      {/* Stats bar */}
      <div className={styles.statsGrid}>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}>🎯</span>
          <div>
            <div className={styles.statValue}>{totalTasks}</div>
            <div className={styles.statLabel}>Total Tasks</div>
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
            <div className={styles.statValue}>{activeCount}</div>
            <div className={styles.statLabel}>Active</div>
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

      {/* 3-panel layout */}
      <div className={styles.conductorGrid}>
        {/* Left: Agents */}
        <div className={styles.agentPanel}>
          <div className={styles.panelHeader}>
            <h2 className={styles.panelTitle}>Active Agents</h2>
            <span className={styles.panelCount}>{agents.length}</span>
          </div>
          <div className={styles.agentList}>
            {agents.length === 0 ? (
              <div className={styles.emptyPanel}>
                <span className={styles.emptyIcon}>🤖</span>
                <p>No agents online</p>
                <p className={styles.emptyHint}>
                  Agents appear when they start sessions via MCP.
                </p>
              </div>
            ) : (
              <>
                {selectedAgent && (
                  <button
                    className={styles.clearFilter}
                    onClick={() => setSelectedAgent(null)}
                  >
                    ✕ Clear filter
                  </button>
                )}
                {agents.map((agent) => (
                  <AgentCard
                    key={agent.name}
                    agent={agent}
                    isSelected={agent.name === selectedAgent}
                    onSelect={() =>
                      setSelectedAgent(agent.name === selectedAgent ? null : agent.name)
                    }
                  />
                ))}
              </>
            )}
          </div>
        </div>

        {/* Center: Kanban */}
        <div className={styles.boardPanel}>
          <div className={styles.panelHeader}>
            <h2 className={styles.panelTitle}>
              Task Board
              {selectedAgent && (
                <span className={styles.filterLabel}> — {selectedAgent}</span>
              )}
            </h2>
            <div className={styles.boardActions}>
              <button className="btn btn-secondary btn-sm" onClick={handleRefresh}>
                Refresh
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => setShowCreateDialog(true)}
              >
                + New Task
              </button>
            </div>
          </div>
          <div className={styles.kanbanBoard}>
            <KanbanColumn
              title="Pending"
              icon="⏳"
              tasks={filteredColumns.pending ?? []}
              selectedTaskId={selectedTask?.id ?? null}
              onSelectTask={setSelectedTask}
            />
            <KanbanColumn
              title="Active"
              icon="🔄"
              tasks={filteredColumns['in_progress'] ?? []}
              selectedTaskId={selectedTask?.id ?? null}
              onSelectTask={setSelectedTask}
            />
            <KanbanColumn
              title="Done"
              icon="✅"
              tasks={filteredColumns['completed'] ?? []}
              selectedTaskId={selectedTask?.id ?? null}
              onSelectTask={setSelectedTask}
            />
          </div>
        </div>

        {/* Right: Detail */}
        <div className={styles.detailPanelContainer}>
          {selectedTask ? (
            <TaskDetail
              task={selectedTask}
              onClose={() => setSelectedTask(null)}
            />
          ) : (
            <div className={styles.emptyPanel}>
              <span className={styles.emptyIcon}>📋</span>
              <p>Select a task</p>
              <p className={styles.emptyHint}>
                Click any task card to view details and activity log.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Create Dialog */}
      {showCreateDialog && (
        <CreateTaskDialog
          agents={agents}
          onClose={() => setShowCreateDialog(false)}
          onCreated={handleRefresh}
        />
      )}
    </DashboardLayout>
  )
}
