'use client'

import { useState, useMemo } from 'react'
import DashboardLayout from '@/components/layout/DashboardLayout'
import useSWR from 'swr'
import {
  getConductorAgents,
  getConductorTasks,
  type ConductorAgent,
  type ConductorTask,
} from '@/lib/api'
import styles from './page.module.css'

// ── Types ──
type TaskFilter = 'all' | 'pending' | 'in_progress' | 'completed' | 'assigned'

// ── Helpers ──
function timeAgo(dateStr: string): string {
  const now = new Date()
  const past = new Date(dateStr.endsWith('Z') ? dateStr : dateStr + 'Z')
  const diff = Math.floor((now.getTime() - past.getTime()) / 1000)
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
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

function StatusBadge({ status }: { status: string }) {
  const variant =
    status === 'completed'
      ? 'healthy'
      : status === 'in_progress'
        ? 'warning'
        : status === 'pending'
          ? 'warning'
          : 'error'
  return <span className={`badge badge-${variant}`}>{status}</span>
}

// ── Agent Card ──
function AgentCard({ agent }: { agent: ConductorAgent }) {
  const dotClass =
    agent.status === 'online'
      ? styles.statusDotOnline
      : agent.status === 'idle'
        ? styles.statusDotIdle
        : styles.statusDotOffline

  const statusLabel =
    agent.status === 'online'
      ? 'Online'
      : agent.status === 'idle'
        ? 'Idle'
        : 'Offline'

  // Show up to 5 tools
  const displayTools = agent.toolsUsed.slice(0, 5)
  const extraTools = agent.toolsUsed.length - 5

  return (
    <div className={`card ${styles.agentCard}`}>
      <div className={styles.agentHeader}>
        <span className={`${styles.statusDot} ${dotClass}`} />
        <span className={styles.agentName}>{agent.agentId}</span>
        <span className={styles.agentStatus}>{statusLabel}</span>
      </div>

      {/* Identity info */}
      {(agent.hostname || agent.ide || agent.os) && (
        <div className={styles.agentMetaRow} style={{ fontSize: '0.75rem', opacity: 0.7, marginBottom: 4 }}>
          {agent.hostname && <span>{agent.hostname}</span>}
          {agent.os && <span> · {agent.os}</span>}
          {agent.ide && <span> · {agent.ide}</span>}
        </div>
      )}
      {agent.project && (
        <div className={styles.agentMetaRow} style={{ fontSize: '0.75rem', opacity: 0.7, marginBottom: 4 }}>
          📁 {agent.project}{agent.branch ? ` @ ${agent.branch}` : ''}
        </div>
      )}
      {agent.role && (
        <div className={styles.agentMetaRow} style={{ fontSize: '0.75rem', opacity: 0.6, marginBottom: 4 }}>
          Role: {agent.role}
        </div>
      )}

      <div className={styles.agentMeta}>
        <div className={styles.agentMetaRow}>
          {agent.queryCount} queries · Last seen: <code>{timeAgo(agent.lastActivity)}</code>
        </div>
      </div>

      {/* Active tasks */}
      {agent.activeTasks && agent.activeTasks.length > 0 && (
        <div className={styles.agentProjects}>
          {agent.activeTasks.map((t: { id: string; title: string; status: string }) => (
            <span key={t.id} className={styles.projectTag} title={t.title}>
              🔧 {t.title.substring(0, 30)}{t.title.length > 30 ? '...' : ''} ({t.status})
            </span>
          ))}
        </div>
      )}

      {agent.project && (
        <div className={styles.agentProjects}>
            <span className={styles.projectTag}>
              {agent.project.replace('https://github.com/', '')}
            </span>
        </div>
      )}

      <div className={styles.agentFooter}>
        <div className={styles.toolsList}>
          {displayTools.map((tool) => (
            <span key={tool} className={styles.toolTag}>
              {tool}
            </span>
          ))}
          {extraTools > 0 && (
            <span className={styles.toolTag}>+{extraTools}</span>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Task Card ──
function TaskCard({ task }: { task: ConductorTask }) {
  return (
    <div className={`card ${styles.taskCard}`}>
      <div className={styles.taskHeader}>
        <code className={styles.taskId}>{task.id.slice(0, 12)}</code>
        <StatusBadge status={task.status} />
      </div>

      <p className={styles.taskSummary}>{task.title}</p>
      {task.description && (
        <p className={styles.taskSummary} style={{ fontSize: '0.8rem', opacity: 0.7, marginTop: 2 }}>
          {task.description.substring(0, 120)}{task.description.length > 120 ? '…' : ''}
        </p>
      )}

      <div className={styles.taskMeta}>
        {task.project_id && (
          <div className={styles.taskMetaItem}>
            <span className={styles.taskMetaLabel}>Project</span>
            <span className={styles.taskMetaValue}>{task.project_id}</span>
          </div>
        )}
        <div className={styles.taskMetaItem}>
          <span className={styles.taskMetaLabel}>From</span>
          <span className={styles.taskMetaValue}>
            <code>{task.created_by_agent ?? '--'}</code>
          </span>
        </div>
        <div className={styles.taskMetaItem}>
          <span className={styles.taskMetaLabel}>Assigned</span>
          <span className={styles.taskMetaValue}>
            <code>{task.assigned_to_agent ?? '--'}</code>
          </span>
        </div>
        <div className={styles.taskMetaItem}>
          <span className={styles.taskMetaLabel}>Priority</span>
          <PriorityBadge priority={task.priority} />
        </div>
      </div>

      <div className={styles.taskFooter}>
        <span className={styles.timestamp}>
          {task.created_at ? timeAgo(task.created_at) : '--'}
        </span>
        {task.assigned_to_agent && task.status !== 'pending' && (
          <span className={styles.claimedBy}>
            Assigned to <code>{task.assigned_to_agent}</code>
          </span>
        )}
      </div>
    </div>
  )
}

// ── Main Page ──
export default function ConductorPage() {
  const {
    data: agentData,
    error: agentError,
    isLoading: agentLoading,
    mutate: mutateAgents,
  } = useSWR('conductor-agents', () => getConductorAgents(), {
    refreshInterval: 5000,
  })

  const {
    data: taskData,
    error: taskError,
    isLoading: taskLoading,
    mutate: mutateTasks,
  } = useSWR('conductor-tasks', () => getConductorTasks(100), {
    refreshInterval: 5000,
  })

  const [taskFilter, setTaskFilter] = useState<TaskFilter>('all')

  const agents = agentData?.agents ?? []
  const allTasks = taskData?.tasks ?? []
  const taskStats = taskData?.stats

  const onlineCount = agents.filter((a) => a.status === 'online').length
  const idleCount = agents.filter((a) => a.status === 'idle').length

  const filteredTasks = useMemo(() => {
    if (taskFilter === 'all') return allTasks
    if (taskFilter === 'in_progress') {
      return allTasks.filter((t) => ['assigned', 'accepted', 'in_progress'].includes(t.status))
    }
    return allTasks.filter((t) => t.status === taskFilter)
  }, [allTasks, taskFilter])

  const pendingCount = taskStats?.pending ?? 0
  const activeCount = taskStats?.active ?? 0
  const completedCount = taskStats?.completed ?? 0

  const taskFilterTabs: { key: TaskFilter; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: allTasks.length },
    { key: 'pending', label: 'Pending', count: pendingCount },
    { key: 'in_progress', label: 'Active', count: activeCount },
    { key: 'completed', label: 'Completed', count: completedCount },
  ]

  const isLoading = agentLoading || taskLoading

  return (
    <DashboardLayout
      title="Conductor"
      subtitle="Live agent orchestration and task management"
    >
      {/* Stats */}
      <div className={styles.statsGrid}>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}>&#9679;</span>
          <div>
            <div className={styles.statValue}>{onlineCount}</div>
            <div className={styles.statLabel}>Online Agents</div>
          </div>
        </div>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}>&#9676;</span>
          <div>
            <div className={styles.statValue}>{idleCount}</div>
            <div className={styles.statLabel}>Idle Agents</div>
          </div>
        </div>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}>&#9744;</span>
          <div>
            <div className={styles.statValue}>{pendingCount}</div>
            <div className={styles.statLabel}>Pending Tasks</div>
          </div>
        </div>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}>&#9881;</span>
          <div>
            <div className={styles.statValue}>{activeCount}</div>
            <div className={styles.statLabel}>Active Tasks</div>
          </div>
        </div>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}>&#9745;</span>
          <div>
            <div className={styles.statValue}>{completedCount}</div>
            <div className={styles.statLabel}>Completed</div>
          </div>
        </div>
      </div>

      {/* Active Agents */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Active Agents</h2>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => mutateAgents()}
            disabled={isLoading}
          >
            {agentLoading ? 'Loading...' : 'Refresh'}
          </button>
        </div>

        {agentError && (
          <div className={styles.errorBanner}>Failed to load agents</div>
        )}

        {agents.length === 0 && !agentLoading ? (
          <div className={`card ${styles.emptyState}`}>
            <span className={styles.emptyIcon}>&#9683;</span>
            <p>No active agents in the last 30 minutes.</p>
            <p className={styles.emptyHint}>
              Agents appear when they make API calls via{' '}
              <code>cortex_session_start</code> or other MCP tools.
            </p>
          </div>
        ) : (
          <div className={styles.agentsGrid}>
            {agents.map((agent) => (
              <AgentCard key={agent.agentId} agent={agent} />
            ))}
          </div>
        )}
      </div>

      {/* Tasks */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Task Board</h2>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => mutateTasks()}
            disabled={isLoading}
          >
            {taskLoading ? 'Loading...' : 'Refresh'}
          </button>
        </div>

        {/* Filter tabs */}
        <div className={styles.filterTabs}>
          {taskFilterTabs.map((tab) => (
            <button
              key={tab.key}
              className={`${styles.filterTab} ${taskFilter === tab.key ? styles.filterTabActive : ''}`}
              onClick={() => setTaskFilter(tab.key)}
            >
              {tab.label}
              <span className={styles.filterCount}>{tab.count}</span>
            </button>
          ))}
        </div>

        {taskError && (
          <div className={styles.errorBanner}>Failed to load tasks</div>
        )}

        {filteredTasks.length === 0 && !taskLoading ? (
          <div className={`card ${styles.emptyState}`}>
            <span className={styles.emptyIcon}>&#9776;</span>
            <p>
              {allTasks.length > 0
                ? 'No tasks match the current filter.'
                : 'No tasks yet.'}
            </p>
            <p className={styles.emptyHint}>
              Tasks are created via <code>cortex_task_create</code> MCP tool
              or the dashboard.
            </p>
          </div>
        ) : (
          <div className={styles.tasksGrid}>
            {filteredTasks.map((task) => (
              <TaskCard key={task.id} task={task} />
            ))}
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
