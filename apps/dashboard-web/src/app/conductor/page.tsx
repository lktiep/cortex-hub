'use client'

import { useState, useMemo, useCallback } from 'react'
import { Target } from 'lucide-react'
import DashboardLayout from '@/components/layout/DashboardLayout'
import useSWR from 'swr'
import {
  getConductorTasks,
  getConductorAgents,
  cancelConductorTask,
  deleteConductorTask,
  deletePipeline,
  updateConductorTask,
  type ConductorTask,
  type ConductorAgent,
} from '@/lib/api'
import {
  TaskBriefingWizard,
  PipelineDiagram,
  TaskDetail,
  AgentDetail,
  type StatusFilter,
  type TaskPrefill,
  type ResumeTask,
  type TaskStrategy,
  buildTaskTree,
  flattenTree,
  getIdeInfo,
  getCapColor,
  getResultSummary,
  getTaskDuration,
  parseResult,
  getParticipatingAgents,
  getActiveSubtask,
  getPipelineProgress,
  StatusBadge,
  type TaskTreeNode,
} from './components'
import { SkeletonCircle } from '@/components/ui/Skeleton'
import { NumberTransition } from '@/components/ui/NumberTransition'
import styles from './page.module.css'

// ── Pipeline Card Component ──

/** Individual subtask row inside a pipeline card */
function SubtaskRow({ node, onSelect }: { node: TaskTreeNode; onSelect: () => void }) {
  const { task } = node
  const duration = getTaskDuration(task)
  const statusIcon = task.status === 'completed' ? '✓'
    : task.status === 'in_progress' || task.status === 'analyzing' ? '●'
    : task.status === 'failed' ? '✗'
    : task.status === 'cancelled' ? '—'
    : '○'
  const statusClass = task.status === 'completed' ? styles.subtaskDone
    : task.status === 'in_progress' || task.status === 'analyzing' ? styles.subtaskActive
    : task.status === 'failed' ? styles.subtaskFailed
    : task.status === 'cancelled' ? styles.subtaskCancelled
    : styles.subtaskPending

  return (
    <div className={`${styles.pcSubtaskRow} ${statusClass}`} onClick={onSelect}>
      <span className={styles.pcSubtaskIcon}>{statusIcon}</span>
      <span className={styles.pcSubtaskTitle}>{task.title}</span>
      {task.assigned_to_agent && (
        <code className={styles.pcSubtaskAgent}>{task.assigned_to_agent}</code>
      )}
      {duration && <span className={styles.pcSubtaskDuration}>{duration}</span>}
      <StatusBadge status={task.status} />
    </div>
  )
}

/** Rich pipeline card — renders an entire pipeline as one informative card */
function PipelineCard({
  rootNode,
  allNodes,
  onSelectTask,
  onDeletePipeline,
  onShowDiagram,
  onFollowUp,
  onCancel,
}: {
  rootNode: TaskTreeNode
  allNodes: TaskTreeNode[]
  onSelectTask: (task: ConductorTask) => void
  onDeletePipeline: (rootTaskId: string) => void
  onShowDiagram: (rootTaskId: string) => void
  onFollowUp: (task: ConductorTask) => void
  onCancel: (taskId: string) => void
}) {
  const root = rootNode.task
  const hasSubtasks = rootNode.children.length > 0
  const progress = getPipelineProgress(rootNode)
  const agents = getParticipatingAgents(rootNode)
  const activeSubtask = getActiveSubtask(rootNode)
  const duration = getTaskDuration(root)
  const [subtasksExpanded, setSubtasksExpanded] = useState(rootNode.children.length <= 5)
  const [resultExpanded, setResultExpanded] = useState(false)
  const isCompleted = root.status === 'completed'
  const isFailed = root.status === 'failed'
  const isRunning = root.status === 'in_progress' || root.status === 'analyzing' || root.status === 'accepted'
  const isCancellable = ['pending', 'assigned', 'accepted', 'in_progress', 'analyzing'].includes(root.status)

  // Determine card accent class
  const accentClass = isCompleted ? styles.pcCardCompleted
    : isFailed ? styles.pcCardFailed
    : isRunning ? styles.pcCardRunning
    : root.status === 'cancelled' ? styles.pcCardCancelled
    : styles.pcCardPending

  // Subtasks to display
  const subtaskNodes = allNodes.filter(n => n.depth > 0)

  return (
    <div className={`${styles.pcCard} ${accentClass}`}>
      {/* Header */}
      <div className={styles.pcHeader} onClick={() => onSelectTask(root)}>
        <div className={styles.pcHeaderLeft}>
          <span className={`${styles.pcDot} ${
            isCompleted ? styles.pcDotCompleted
            : isRunning ? styles.pcDotRunning
            : isFailed ? styles.pcDotFailed
            : root.status === 'cancelled' ? styles.pcDotCancelled
            : styles.pcDotPending
          }`} />
          <div className={styles.pcTitleBlock}>
            <h3 className={styles.pcTitle}>{root.title}</h3>
            {root.description && (
              <p className={styles.pcDesc}>
                {root.description.slice(0, 160)}{root.description.length > 160 ? '…' : ''}
              </p>
            )}
          </div>
        </div>
        <div className={styles.pcHeaderRight}>
          <StatusBadge status={root.status} />
          {duration && <span className={styles.pcDuration}>⏱ {duration}</span>}
        </div>
      </div>

      {/* Progress bar (only if there are subtasks) */}
      {hasSubtasks && (
        <div className={styles.pcProgressSection}>
          <div className={styles.pcProgressBar}>
            <div
              className={`${styles.pcProgressFill} ${
                progress.failed > 0 ? styles.pcProgressFillFailed
                : progress.percent === 100 ? styles.pcProgressFillComplete
                : styles.pcProgressFillActive
              }`}
              style={{ width: `${progress.percent}%` }}
            />
          </div>
          <span className={styles.pcProgressLabel}>
            {progress.completed}/{progress.total} subtasks
            {progress.failed > 0 && <span className={styles.pcProgressFailed}> · {progress.failed} failed</span>}
          </span>
        </div>
      )}

      {/* Agent Roster */}
      {agents.length > 0 && (
        <div className={styles.pcAgentSection}>
          <span className={styles.pcAgentSectionLabel}>👥 Agents</span>
          <div className={styles.pcAgentRoster}>
            {agents.map(({ agentId, role }) => {
              const { icon, colorClass } = getIdeInfo(agentId)
              const isActive = activeSubtask?.agent === agentId
              return (
                <span
                  key={agentId}
                  className={`${styles.pcAgentPill} ${colorClass ? styles[colorClass] : ''} ${isActive ? styles.pcAgentActive : ''}`}
                  title={`${agentId} (${role})`}
                >
                  <span className={styles.pcAgentPillIcon}>{icon}</span>
                  {agentId}
                  {isActive && <span className={styles.pcAgentActiveDot} />}
                </span>
              )
            })}
          </div>
        </div>
      )}

      {/* Active agent indicator */}
      {activeSubtask && (
        <div className={styles.pcActiveIndicator}>
          <span className={styles.pcActiveIcon}>⚡</span>
          <span className={styles.pcActiveText}>
            <strong>{activeSubtask.agent ?? 'Agent'}</strong> is working on <em>&quot;{activeSubtask.title}&quot;</em>
          </span>
        </div>
      )}

      {/* Subtask list */}
      {hasSubtasks && (
        <div className={styles.pcSubtaskSection}>
          <button
            className={styles.pcSubtaskToggle}
            onClick={() => setSubtasksExpanded(!subtasksExpanded)}
          >
            <span className={`${styles.pcSubtaskChevron} ${subtasksExpanded ? styles.pcSubtaskChevronOpen : ''}`}>▾</span>
            {subtasksExpanded ? 'Subtasks' : `Show ${subtaskNodes.length} subtasks`}
          </button>
          {subtasksExpanded && (
            <div className={styles.pcSubtaskList}>
              {subtaskNodes.map(node => (
                <SubtaskRow
                  key={node.task.id}
                  node={node}
                  onSelect={() => onSelectTask(node.task)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Result preview (completed tasks) */}
      {isCompleted && root.result && (
        <div className={styles.pcResultSection}>
          <button
            className={styles.pcResultToggle}
            onClick={() => setResultExpanded(!resultExpanded)}
          >
            <span className={`${styles.pcSubtaskChevron} ${resultExpanded ? styles.pcSubtaskChevronOpen : ''}`}>▾</span>
            {resultExpanded ? 'Result' : `View result: ${getResultSummary(root.result, 60)}`}
          </button>
          {resultExpanded && (
            <div className={styles.pcResultContent}>
              <PipelineResultSummary result={root.result} />
            </div>
          )}
        </div>
      )}

      {/* Action bar */}
      <div className={styles.pcActionBar}>
        <button
          className={styles.pcActionBtn}
          title="View pipeline diagram"
          onClick={() => onShowDiagram(root.id)}
        >
          🔗 Diagram
        </button>
        {isCompleted && (
          <button
            className={`${styles.pcActionBtn} ${styles.pcActionBtnPrimary}`}
            onClick={() => onFollowUp(root)}
          >
            + Follow-up
          </button>
        )}
        {isCancellable && (
          <button
            className={`${styles.pcActionBtn} ${styles.pcActionBtnWarning}`}
            onClick={() => onCancel(root.id)}
          >
            ⛔ Cancel
          </button>
        )}
        <button
          className={`${styles.pcActionBtn} ${styles.pcActionBtnDanger}`}
          title="Delete pipeline"
          onClick={() => onDeletePipeline(root.id)}
        >
          🗑 Delete
        </button>
      </div>

      {hasSubtasks && (
        <div className={styles.pcBottomEdgeProgress}>
          <div
            className={`${styles.pcBottomEdgeFill} ${
              progress.failed > 0 ? styles.pcProgressFillFailed
              : progress.percent === 100 ? styles.pcProgressFillComplete
              : styles.pcBottomEdgeFillActive
            }`}
            style={{ width: `${progress.percent}%` }}
          />
        </div>
      )}
    </div>
  )
}

/** Human-readable parsed result for inline pipeline display */
function PipelineResultSummary({ result }: { result: string }) {
  const parsed = parseResult(result)
  if (parsed.type === 'empty') return null
  if (parsed.type === 'string') {
    return <div className={styles.pcResultText}>{parsed.text}</div>
  }
  if (parsed.type === 'subtasks') {
    return (
      <div className={styles.pcResultSubtasks}>
        {parsed.items.map((item, i) => (
          <div key={i} className={styles.pcResultSubtaskRow}>
            <span className={styles.pcResultSubtaskIcon}>
              {item.status === 'completed' ? '✓' : item.status === 'failed' ? '✗' : '○'}
            </span>
            <span className={styles.pcResultSubtaskTitle}>
              {item.title ?? `Subtask ${i + 1}`}
            </span>
            {item.agent && <code className={styles.pcResultSubtaskAgent}>{item.agent}</code>}
            {item.message && <span className={styles.pcResultSubtaskMsg}>{item.message}</span>}
          </div>
        ))}
      </div>
    )
  }
  // type === 'object'
  return (
    <div className={styles.pcResultKv}>
      {parsed.summary.map(({ key, value }) => (
        <div key={key} className={styles.pcResultKvRow}>
          <span className={styles.pcResultKvKey}>{key.replace(/_/g, ' ')}</span>
          <span className={styles.pcResultKvValue}>{value}</span>
        </div>
      ))}
    </div>
  )
}

/** Pipeline card grid — renders all tasks as pipeline cards */
function PipelineGrid({
  tasks,
  onSelectTask,
  onDeletePipeline,
  onShowDiagram,
  onFollowUp,
  onCancel,
}: {
  tasks: ConductorTask[]
  onSelectTask: (task: ConductorTask) => void
  onDeletePipeline: (rootTaskId: string) => void
  onShowDiagram: (rootTaskId: string) => void
  onFollowUp: (task: ConductorTask) => void
  onCancel: (taskId: string) => void
}) {
  const tree = useMemo(() => buildTaskTree(tasks), [tasks])

  if (tree.length === 0) {
    return (
      <div className={`card empty-state`}>
        <div className="empty-state-icon" data-section="conductor">
          <Target size={32} strokeWidth={1.5} />
        </div>
        <p className="empty-state-title">No conductor tasks yet</p>
        <p className="empty-state-desc">
          Create tasks via the dashboard or the <code>cortex_task_create</code> MCP tool.
        </p>
      </div>
    )
  }

  // Every root node is a "pipeline" (even standalone tasks)
  return (
    <div className={styles.pcGrid}>
      {tree.map((rootNode) => {
        const subtreeFlat = flattenTree([rootNode])
        return (
          <PipelineCard
            key={rootNode.task.id}
            rootNode={rootNode}
            allNodes={subtreeFlat}
            onSelectTask={onSelectTask}
            onDeletePipeline={onDeletePipeline}
            onShowDiagram={onShowDiagram}
            onFollowUp={onFollowUp}
            onCancel={onCancel}
          />
        )
      })}
    </div>
  )
}

// ── Main Page ──
export default function ConductorPage() {
  const { data, error, isLoading, mutate } = useSWR('conductor-tasks', () => getConductorTasks({ limit: 200 }), {
    refreshInterval: 10000,
  })
  const { data: agentsData } = useSWR('conductor-agents', getConductorAgents, {
    refreshInterval: 5000,
  })

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [selectedTask, setSelectedTask] = useState<ConductorTask | null>(null)
  const [selectedAgent, setSelectedAgent] = useState<ConductorAgent | null>(null)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [taskPrefill, setTaskPrefill] = useState<TaskPrefill | undefined>(undefined)
  const [resumeTask, setResumeTask] = useState<ResumeTask | undefined>(undefined)
  const [diagramPipelineId, setDiagramPipelineId] = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)

  const allTasks = data?.tasks ?? []
  const agents = agentsData?.agents ?? []
  const onlineCount = agentsData?.online ?? agents.length
  const [agentsCollapsed, setAgentsCollapsed] = useState(false)

  const filteredTasks = useMemo(() => {
    return statusFilter === 'all' ? allTasks : allTasks.filter((t) => t.status === statusFilter)
  }, [allTasks, statusFilter])

  const counts = useMemo(() => ({
    all: allTasks.length,
    pending: allTasks.filter((t) => t.status === 'pending').length,
    in_progress: allTasks.filter((t) => t.status === 'in_progress').length,
    completed: allTasks.filter((t) => t.status === 'completed').length,
    failed: allTasks.filter((t) => t.status === 'failed').length,
    cancelled: allTasks.filter((t) => t.status === 'cancelled').length,
  }), [allTasks])

  /** Collect all descendant task IDs for a given parent */
  const getSubtaskIds = useCallback((parentId: string): string[] => {
    const ids: string[] = []
    for (const t of allTasks) {
      if (t.parent_task_id === parentId) {
        ids.push(t.id)
        ids.push(...getSubtaskIds(t.id))
      }
    }
    return ids
  }, [allTasks])

  const handleCancel = useCallback(async (id: string) => {
    const idsToCancel = [id, ...getSubtaskIds(id)]
    const cancellableStatuses = ['pending', 'assigned', 'accepted', 'in_progress', 'analyzing']
    const tasksToCancelIds = idsToCancel.filter((tid) => {
      const t = allTasks.find((task) => task.id === tid)
      return t && cancellableStatuses.includes(t.status)
    })

    mutate((current) => {
      if (!current) return current
      return {
        ...current,
        tasks: current.tasks.map((t) =>
          tasksToCancelIds.includes(t.id) ? { ...t, status: 'cancelled' as ConductorTask['status'] } : t
        ),
      }
    }, false)

    setSelectedTask(null)

    try {
      await Promise.allSettled(tasksToCancelIds.map((tid) => cancelConductorTask(tid)))
    } catch (err) {
      console.error('Failed to cancel task(s):', err)
    }
    mutate()
  }, [allTasks, getSubtaskIds, mutate])

  const handleDelete = useCallback(async (id: string) => {
    try {
      await deleteConductorTask(id)
      mutate()
    } catch (err) {
      console.error('Failed to delete task:', err)
    }
  }, [mutate])

  const handleDeletePipeline = useCallback(async (rootTaskId: string) => {
    try {
      await deletePipeline(rootTaskId, allTasks)
      setDeleteConfirm(null)
      mutate()
    } catch (err) {
      console.error('Failed to delete pipeline:', err)
    }
  }, [allTasks, mutate])

  const handleNewTaskFromOutcome = useCallback((task: ConductorTask) => {
    const resultText = task.result ? getResultSummary(task.result, 2000) : ''
    setTaskPrefill({
      title: `Follow-up: ${task.title}`,
      description: resultText
        ? `## Context\nBased on outcome from task "${task.title}" (${task.id}):\n\n${resultText}`
        : `Follow-up task for: ${task.title}`,
      context: { parentTaskId: task.id, sourceTaskTitle: task.title },
    })
    setSelectedTask(null)
    setShowCreateForm(true)
  }, [])

  const diagramTasks = useMemo(() => {
    if (!diagramPipelineId) return []
    const ids = new Set<string>()
    function collect(parentId: string) {
      ids.add(parentId)
      for (const t of allTasks) {
        if (t.parent_task_id === parentId) collect(t.id)
      }
    }
    collect(diagramPipelineId)
    return allTasks.filter((t) => ids.has(t.id))
  }, [diagramPipelineId, allTasks])

  const filterTabs: { key: StatusFilter; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: counts.all },
    { key: 'pending', label: 'Pending', count: counts.pending },
    { key: 'in_progress', label: 'In Progress', count: counts.in_progress },
    { key: 'completed', label: 'Completed', count: counts.completed },
    { key: 'failed', label: 'Failed', count: counts.failed },
    { key: 'cancelled', label: 'Cancelled', count: counts.cancelled },
  ]

  return (
    <DashboardLayout title="Conductor" subtitle="Task assignment and agent orchestration" section="conductor">
      {/* Stats */}
      <div className={styles.statsGrid}>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}>📋</span>
          <div>
            <div className={styles.statValue}><NumberTransition value={counts.all} /></div>
            <div className={styles.statLabel}>Total</div>
          </div>
        </div>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}>⏳</span>
          <div>
            <div className={styles.statValue}><NumberTransition value={counts.pending} /></div>
            <div className={styles.statLabel}>Pending</div>
          </div>
        </div>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}>⚡</span>
          <div>
            <div className={styles.statValue}><NumberTransition value={counts.in_progress} /></div>
            <div className={styles.statLabel}>Running</div>
          </div>
        </div>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}>✅</span>
          <div>
            <div className={styles.statValue}><NumberTransition value={counts.completed} /></div>
            <div className={styles.statLabel}>Done</div>
          </div>
        </div>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}>❌</span>
          <div>
            <div className={styles.statValue}><NumberTransition value={counts.failed} /></div>
            <div className={styles.statLabel}>Failed</div>
          </div>
        </div>
      </div>

      {/* Agents Online */}
      {agents.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2
              className={`${styles.sectionTitle} ${styles.sectionTitleCollapsible}`}
              onClick={() => setAgentsCollapsed(!agentsCollapsed)}
            >
              <span className={`${styles.collapseIcon} ${agentsCollapsed ? styles.collapseIconClosed : ''}`}>▾</span>
              Agents <span className={styles.filterCount}><NumberTransition value={onlineCount} /> online</span>
            </h2>
          </div>
          {!agentsCollapsed && (
            <div className={styles.agentsGrid}>
              {agents.map((agent: ConductorAgent) => {
                const { icon: ideIcon, label: ideLabel, colorClass } = getIdeInfo(agent.ide)
                const ideColor = colorClass ? styles[colorClass] : ''
                const statusLabel = agent.status === 'idle' ? 'Idle' : agent.status === 'busy' ? 'Busy' : 'Online'
                const statusClass = agent.status === 'idle' ? styles.agentOnline : agent.status === 'busy' ? styles.agentBusy : styles.agentOnline
                const platform = agent.platform ?? (agent.hostname?.includes('Mac') ? 'macOS' : 'unknown')

                return (
                  <div key={agent.agentId} className={`card ${styles.agentCard} ${styles.agentCardClickable}`} onClick={() => setSelectedAgent(agent)}>
                    <div className={styles.agentHeader}>
                      <span className={`${styles.agentIdeIcon} ${ideColor}`}>{ideIcon}</span>
                      <div className={styles.agentIdentity}>
                        <strong className={styles.agentIdText}>{agent.agentId}</strong>
                        <span className={styles.agentIdeLabel}>{ideLabel}</span>
                      </div>
                      <div className={styles.agentStatusBadge}>
                        <span className={`${styles.agentDot} ${statusClass}`} />
                        <span className={styles.agentStatusText}>{statusLabel}</span>
                      </div>
                    </div>

                    <div className={styles.agentDetails}>
                      <div className={styles.agentDetailRow}>
                        <span className={styles.agentDetailLabel}>Host</span>
                        <span className={styles.agentDetailValue}>{agent.hostname ?? '-'}</span>
                      </div>
                      <div className={styles.agentDetailRow}>
                        <span className={styles.agentDetailLabel}>Platform</span>
                        <span className={styles.agentDetailValue}>{platform}</span>
                      </div>
                      <div className={styles.agentDetailRow}>
                        <span className={styles.agentDetailLabel}>Owner</span>
                        <span className={styles.agentDetailValue}>{agent.apiKeyOwner}</span>
                      </div>
                      <div className={styles.agentDetailRow}>
                        <span className={styles.agentDetailLabel}>Connected</span>
                        <span className={styles.agentDetailValue}>{new Date(agent.connectedAt).toLocaleTimeString()}</span>
                      </div>
                    </div>

                    {agent.capabilities && agent.capabilities.length > 0 ? (
                      <div className={styles.agentCaps}>
                        {agent.capabilities.map((cap) => {
                          const capColorClass = getCapColor(cap)
                          return <span key={cap} className={`${styles.capBadge} ${capColorClass ? styles[capColorClass] : ''}`}>{cap}</span>
                        })}
                      </div>
                    ) : (
                      <div className={styles.agentCapsEmpty}>No capabilities registered</div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Pending Strategy / Analyzing Banner */}
      {allTasks.filter(t => t.status === 'strategy_review' || t.status === 'analyzing' || (t.status === 'accepted' && (() => { try { const c = typeof t.context === 'string' ? JSON.parse(t.context) : t.context; return c?.workflow === 'orchestrated' } catch { return false } })())).map(task => {
        const ctx = typeof task.context === 'string' ? (() => { try { return JSON.parse(task.context) } catch { return {} } })() : (task.context ?? {})
        const hasStrategy = task.status === 'strategy_review' && ctx.strategy
        const isAnalyzing = task.status === 'accepted' || task.status === 'analyzing'
        return (
          <div key={task.id} className={`card ${styles.statCard}`} style={{ marginBottom: 'var(--space-3)', cursor: 'pointer', borderLeft: `3px solid ${hasStrategy ? 'var(--status-warning)' : 'var(--primary)'}` }}
            onClick={() => {
              if (hasStrategy) {
                setResumeTask({ task, strategy: ctx.strategy })
              } else {
                setResumeTask({ task, strategy: undefined as unknown as TaskStrategy })
              }
              setShowCreateForm(true)
            }}
          >
            <span style={{ fontSize: '1.25rem' }}>{hasStrategy ? '📋' : '⏳'}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>{task.title}</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                {hasStrategy
                  ? `Strategy ready — click to review & approve (${task.assigned_to_agent})`
                  : `Agent ${task.assigned_to_agent} is analyzing... — click to resume`
                }
              </div>
            </div>
            {hasStrategy
              ? <span className="btn btn-primary btn-sm">Review Strategy →</span>
              : isAnalyzing && <span className="btn btn-secondary btn-sm">Resume →</span>
            }
          </div>
        )
      })}

      {/* Tasks Section */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Tasks</h2>
          <div className={styles.headerActions}>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => { setTaskPrefill(undefined); setShowCreateForm(true) }}
            >
              + New Task
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => mutate()}
              disabled={isLoading}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '32px' }}
            >
              {isLoading ? <SkeletonCircle size={14} /> : '↻'}
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

        {/* Pipeline Cards */}
        <PipelineGrid
          tasks={filteredTasks}
          onSelectTask={setSelectedTask}
          onDeletePipeline={(rootId: string) => setDeleteConfirm(rootId)}
          onShowDiagram={(rootId: string) => setDiagramPipelineId(rootId)}
          onFollowUp={handleNewTaskFromOutcome}
          onCancel={handleCancel}
        />
      </div>

      {/* Pipeline Diagram Modal */}
      {diagramPipelineId && diagramTasks.length > 0 && (
        <div className={styles.diagramModalOverlay} onClick={() => setDiagramPipelineId(null)}>
          <div className={styles.diagramModalPanel} onClick={(e) => e.stopPropagation()}>
            <div className={styles.diagramModalHeader}>
              <h2 className={styles.diagramModalTitle}>
                🔗 Pipeline Diagram
                <span className={styles.diagramModalSubtitle}>
                  {diagramTasks.length} tasks
                </span>
              </h2>
              <button className={styles.detailClose} onClick={() => setDiagramPipelineId(null)}>×</button>
            </div>
            <div className={styles.diagramModalBody}>
              <PipelineDiagram
                tasks={diagramTasks}
                onNodeClick={(task) => { setDiagramPipelineId(null); setSelectedTask(task) }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Delete Pipeline Confirmation */}
      {deleteConfirm && (
        <div className={styles.confirmOverlay} onClick={() => setDeleteConfirm(null)}>
          <div className={styles.confirmPanel} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.confirmTitle}>🗑️ Delete Pipeline</h3>
            <p className={styles.confirmText}>
              This will <strong>cancel all pending/running tasks</strong> and <strong>permanently delete</strong> the entire pipeline including all subtasks.
            </p>
            <p className={styles.confirmText} style={{ color: 'var(--status-error)' }}>
              This action cannot be undone.
            </p>
            <div className={styles.confirmActions}>
              <button className="btn btn-secondary btn-sm" onClick={() => setDeleteConfirm(null)}>
                Cancel
              </button>
              <button
                className="btn btn-sm"
                style={{ background: 'var(--status-error)', color: 'white', border: 'none' }}
                onClick={() => handleDeletePipeline(deleteConfirm)}
              >
                Delete Pipeline
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Task Detail Slide-over */}
      {selectedTask && (
        <TaskDetail
          task={selectedTask}
          onClose={() => setSelectedTask(null)}
          onCancel={() => handleCancel(selectedTask.id)}
          onDelete={() => handleDelete(selectedTask.id)}
          onMarkDone={async () => {
            await updateConductorTask(selectedTask.id, { status: 'completed' })
            setSelectedTask(null)
            mutate()
          }}
          onNewTaskFromOutcome={handleNewTaskFromOutcome}
        />
      )}

      {/* Agent Detail Slide-over */}
      {selectedAgent && (
        <AgentDetail
          agent={selectedAgent}
          allTasks={allTasks}
          onClose={() => setSelectedAgent(null)}
        />
      )}

      {/* New Task Wizard */}
      {showCreateForm && (
        <TaskBriefingWizard
          onClose={() => { setShowCreateForm(false); setTaskPrefill(undefined); setResumeTask(undefined) }}
          onCreated={() => mutate()}
          agents={agents}
          prefill={taskPrefill}
          resume={resumeTask}
        />
      )}
    </DashboardLayout>
  )
}
