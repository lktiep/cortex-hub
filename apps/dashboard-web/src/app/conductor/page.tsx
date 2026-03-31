'use client'

import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
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
type ViewMode = 'list' | 'pipeline'

interface TaskTreeNode {
  task: ConductorTask
  children: TaskTreeNode[]
  depth: number
}

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

/** Parse result JSON into a structured display */
function parseResult(value: string | null): { type: 'empty' } | { type: 'string'; text: string } | { type: 'subtasks'; items: { title?: string; status?: string; message?: string; agent?: string; [k: string]: unknown }[] } | { type: 'object'; summary: { key: string; value: string }[]; raw: string } {
  if (!value) return { type: 'empty' }
  try {
    const parsed = JSON.parse(value)
    if (typeof parsed === 'string') return { type: 'string', text: parsed }
    if (Array.isArray(parsed)) {
      return { type: 'subtasks', items: parsed }
    }
    if (parsed && typeof parsed === 'object') {
      // Check for subtaskResults array
      if (Array.isArray(parsed.subtaskResults)) {
        return { type: 'subtasks', items: parsed.subtaskResults }
      }
      // Flatten object to key-value pairs for display
      const summary: { key: string; value: string }[] = []
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          summary.push({ key: k, value: String(v) })
        } else if (v === null) {
          summary.push({ key: k, value: '—' })
        }
      }
      return { type: 'object', summary, raw: JSON.stringify(parsed, null, 2) }
    }
    return { type: 'string', text: String(parsed) }
  } catch {
    return { type: 'string', text: value }
  }
}

function ResultDisplay({ result }: { result: string | null }) {
  const parsed = parseResult(result)
  if (parsed.type === 'empty') return null
  if (parsed.type === 'string') return <p className={styles.detailText}>{parsed.text}</p>
  if (parsed.type === 'subtasks') {
    return (
      <div className={styles.resultSubtasks}>
        {parsed.items.map((item, i) => (
          <div key={i} className={styles.resultSubtaskCard}>
            <div className={styles.resultSubtaskHeader}>
              <span className={styles.resultSubtaskTitle}>{item.title ?? `Subtask ${i + 1}`}</span>
              {item.status && <StatusBadge status={item.status} />}
            </div>
            {item.message && <p className={styles.resultSubtaskMsg}>{item.message}</p>}
            {item.agent && (
              <code className={styles.resultSubtaskAgent}>{item.agent}</code>
            )}
          </div>
        ))}
      </div>
    )
  }
  // type === 'object'
  return (
    <div>
      {parsed.summary.length > 0 && (
        <div className={styles.resultSummaryGrid}>
          {parsed.summary.map(({ key, value }) => (
            <div key={key} className={styles.resultSummaryItem}>
              <span className={styles.resultSummaryKey}>{key.replace(/_/g, ' ')}</span>
              <span className={styles.resultSummaryValue}>{value}</span>
            </div>
          ))}
        </div>
      )}
      <details className={styles.resultRawToggle}>
        <summary className={styles.resultRawLabel}>Raw JSON</summary>
        <pre className={styles.detailCode}>{parsed.raw}</pre>
      </details>
    </div>
  )
}

/** Build a tree from flat task list using parent_task_id */
function buildTaskTree(tasks: ConductorTask[]): TaskTreeNode[] {
  const taskMap = new Map<string, TaskTreeNode>()
  const roots: TaskTreeNode[] = []

  // Create nodes
  for (const task of tasks) {
    taskMap.set(task.id, { task, children: [], depth: 0 })
  }

  // Link parent → children
  for (const task of tasks) {
    const node = taskMap.get(task.id)!
    if (task.parent_task_id && taskMap.has(task.parent_task_id)) {
      const parent = taskMap.get(task.parent_task_id)!
      node.depth = parent.depth + 1
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }

  // Sort children by priority then created_at
  function sortChildren(nodes: TaskTreeNode[]) {
    nodes.sort((a, b) => a.task.priority - b.task.priority || a.task.created_at.localeCompare(b.task.created_at))
    for (const node of nodes) sortChildren(node.children)
  }
  sortChildren(roots)
  return roots
}

/** Flatten tree into ordered list with depth info for rendering */
function flattenTree(nodes: TaskTreeNode[]): TaskTreeNode[] {
  const result: TaskTreeNode[] = []
  function walk(list: TaskTreeNode[]) {
    for (const node of list) {
      result.push(node)
      walk(node.children)
    }
  }
  walk(nodes)
  return result
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
    <div className={`card ${styles.taskCard} ${styles.taskCardCompact} ${statusClass}`} onClick={onSelect}>
      <div className={styles.taskHeader}>
        <h3 className={styles.taskTitle}>{task.title}</h3>
        <StatusBadge status={task.status} />
      </div>

      <div className={styles.taskCompactMeta}>
        <code className={styles.agentName}>{task.assigned_to_agent ?? 'unassigned'}</code>
        <span className={styles.timestamp}>
          {task.created_at ? formatTimeAgo(task.created_at) : '--'}
        </span>
      </div>
    </div>
  )
}

/** Live output panel — polls task logs and auto-scrolls */
function LiveOutput({ taskId, isActive }: { taskId: string; isActive: boolean }) {
  const [logs, setLogs] = useState<{ id: number; message: string; created_at: string }[]>([])
  const scrollRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    if (!isActive && logs.length > 0) return
    let cancelled = false
    const poll = async () => {
      try {
        const res = await fetch(`/api/conductor/${taskId}`)
        if (!res.ok || cancelled) return
        const d = await res.json()
        const progressLogs = (d.logs ?? []).filter((l: { action: string }) => l.action === 'progress')
        if (!cancelled) setLogs(progressLogs)
      } catch { /* ignore */ }
    }
    poll()
    const interval = isActive ? setInterval(poll, 2000) : undefined
    return () => { cancelled = true; if (interval) clearInterval(interval) }
  }, [taskId, isActive])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [logs.length])

  if (logs.length === 0) {
    return (
      <div className={styles.liveOutputEmpty}>
        {isActive ? 'Waiting for output...' : 'No output recorded'}
      </div>
    )
  }

  return (
    <pre ref={scrollRef} className={styles.liveOutput}>
      {logs.map((log) => (
        <div key={log.id} className={styles.liveOutputLine}>
          <span className={styles.liveOutputTime}>
            {new Date(log.created_at).toLocaleTimeString()}
          </span>
          {log.message}
        </div>
      ))}
      {isActive && <span className={styles.liveOutputCursor}>▊</span>}
    </pre>
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
  const isRunning = task.status === 'in_progress' || task.status === 'accepted'

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

          {/* Delegation Flow */}
          {(task.created_by_agent || task.assigned_to_agent || task.completed_by) && (
            <div className={styles.detailSection}>
              <h3 className={styles.detailSectionTitle}>Delegation Flow</h3>
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
            </div>
          )}

          {/* Parent Task Link */}
          {task.parent_task_id && (
            <div className={styles.detailRow}>
              <span className={styles.detailLabel}>Parent Task</span>
              <code className={styles.detailValue}>{task.parent_task_id}</code>
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
              <ResultDisplay result={task.result} />
            </div>
          )}

          {/* Context */}
          {task.context && task.context !== '{}' && (
            <div className={styles.detailSection}>
              <h3 className={styles.detailSectionTitle}>Context</h3>
              <pre className={styles.detailCode}>{formatJson(task.context)}</pre>
            </div>
          )}

          {/* Live Output */}
          <div className={styles.detailSection}>
            <h3 className={styles.detailSectionTitle}>
              {isRunning ? '● Live Output' : 'Output Log'}
            </h3>
            <LiveOutput taskId={task.id} isActive={isRunning} />
          </div>

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

/** Pipeline tree row — shows task with indentation and connector lines */
function PipelineRow({
  node,
  onSelect,
  isLast,
}: {
  node: TaskTreeNode
  onSelect: () => void
  isLast: boolean
}) {
  const { task, children, depth } = node
  const hasChildren = children.length > 0

  const statusColor = task.status === 'completed' ? 'completed'
    : task.status === 'in_progress' ? 'inProgress'
    : task.status === 'failed' ? 'failed' : 'pending'

  return (
    <div
      className={`${styles.pipelineRow} ${depth === 0 ? styles.pipelineRowRoot : ''}`}
      onClick={onSelect}
      style={{ paddingLeft: `${depth * 36 + 20}px` }}
    >
      {/* CSS-drawn connector line */}
      {depth > 0 && (
        <span
          className={`${styles.connector} ${isLast ? styles.connectorLast : styles.connectorMid}`}
          data-status={statusColor}
        />
      )}

      {/* Status dot */}
      <span className={`${styles.pipelineDot} ${
        task.status === 'completed' ? styles.dotCompleted
        : task.status === 'in_progress' ? styles.dotInProgress
        : task.status === 'failed' ? styles.dotFailed
        : styles.dotPending
      }`} />

      {/* Title */}
      <span className={`${styles.pipelineTitle} ${depth === 0 ? styles.pipelineTitleRoot : ''}`}>
        {hasChildren && <span className={styles.pipelineExpandIcon}>▾</span>}
        {task.title}
      </span>

      {/* Agent flow: created_by → assigned_to → completed_by */}
      <span className={styles.pipelineFlow}>
        {task.created_by_agent && (
          <code className={styles.flowAgent}>{task.created_by_agent}</code>
        )}
        {task.assigned_to_agent && (
          <>
            <span className={styles.flowArrow}>→</span>
            <code className={styles.flowAgent}>{task.assigned_to_agent}</code>
          </>
        )}
        {task.completed_by && task.completed_by !== task.assigned_to_agent && (
          <>
            <span className={styles.flowArrow}>→</span>
            <code className={styles.flowAgentDone}>{task.completed_by}</code>
          </>
        )}
      </span>

      <StatusBadge status={task.status} />
    </div>
  )
}

/** Pipeline view — renders task tree with delegation arrows */
function PipelineView({
  tasks,
  onSelectTask,
}: {
  tasks: ConductorTask[]
  onSelectTask: (task: ConductorTask) => void
}) {
  const tree = useMemo(() => buildTaskTree(tasks), [tasks])
  const flat = useMemo(() => flattenTree(tree), [tree])

  if (flat.length === 0) {
    return (
      <div className={`card ${styles.emptyState}`}>
        <p>No tasks with parent-child relationships found.</p>
      </div>
    )
  }

  // Group: root tasks with children first, then orphans
  const withChildren = flat.filter((n) => n.depth === 0 && n.children.length > 0)
  const rootIds = new Set(withChildren.map((n) => n.task.id))
  const pipelineTasks = flat.filter((n) => rootIds.has(n.task.id) || (n.depth > 0 && hasAncestorIn(n, rootIds, flat)))
  const orphans = flat.filter((n) => n.depth === 0 && n.children.length === 0)

  function hasAncestorIn(node: TaskTreeNode, ids: Set<string>, allNodes: TaskTreeNode[]): boolean {
    // Walk up via parent_task_id
    let parentId = node.task.parent_task_id
    while (parentId) {
      if (ids.has(parentId)) return true
      const parent = allNodes.find((n) => n.task.id === parentId)
      parentId = parent?.task.parent_task_id ?? null
    }
    return false
  }

  return (
    <div>
      {/* Pipeline tasks (trees) */}
      {withChildren.length > 0 && (
        <div className={`card ${styles.pipelineCard}`}>
          <div className={styles.pipelineHeader}>
            <h3 className={styles.pipelineHeaderTitle}>Task Pipeline</h3>
            <span className={styles.pipelineHeaderCount}>{pipelineTasks.length} tasks in {withChildren.length} pipelines</span>
          </div>
          {withChildren.map((rootNode) => {
            // Collect this root and all its descendants
            const subtreeFlat = flattenTree([rootNode])
            // Build narrative steps
            const narrativeSteps: string[] = []
            const root = rootNode.task
            if (root.created_by_agent) {
              narrativeSteps.push(`${root.created_by_agent} created "${root.title}"`)
            }
            for (const child of rootNode.children) {
              const t = child.task
              let step = ''
              if (t.created_by_agent) step += `${t.created_by_agent} delegated`
              else step += 'Delegated'
              step += ` → ${t.assigned_to_agent ?? 'unassigned'}`
              if (t.required_capabilities) {
                try {
                  const caps = JSON.parse(t.required_capabilities)
                  if (Array.isArray(caps) && caps.length > 0) step += ` (${caps.join(', ')})`
                } catch { /* ignore */ }
              }
              if (t.status === 'completed' && t.accepted_at && t.completed_at) {
                const dur = Math.round((new Date(t.completed_at).getTime() - new Date(t.accepted_at).getTime()) / 60000)
                step += ` → completed in ${dur}m`
                if (t.completed_by && t.completed_by !== t.assigned_to_agent) {
                  step += ` → reviewed by ${t.completed_by}`
                }
              } else if (t.status === 'in_progress') {
                step += ' → in progress'
              } else if (t.status === 'failed') {
                step += ' → failed'
              } else {
                step += ` → ${t.status}`
              }
              narrativeSteps.push(step)
            }

            return (
              <div key={rootNode.task.id}>
                {subtreeFlat.map((node) => {
                  const siblings = subtreeFlat.filter((n) =>
                    n.depth === node.depth && n.task.parent_task_id === node.task.parent_task_id
                  )
                  const isLast = siblings[siblings.length - 1]?.task.id === node.task.id
                  return (
                    <PipelineRow
                      key={node.task.id}
                      node={node}
                      onSelect={() => onSelectTask(node.task)}
                      isLast={isLast}
                    />
                  )
                })}
                {/* Narrative summary */}
                {narrativeSteps.length > 1 && (
                  <div className={styles.pipelineNarrative}>
                    {narrativeSteps.map((step, i) => (
                      <span key={i} className={styles.narrativeStep}>
                        {i > 0 && <span className={styles.narrativeArrow}> → </span>}
                        {step}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Standalone tasks */}
      {orphans.length > 0 && (
        <div className={`card ${styles.pipelineCard}`} style={{ marginTop: 'var(--space-4)' }}>
          <div className={styles.pipelineHeader}>
            <h3 className={styles.pipelineHeaderTitle}>Standalone Tasks</h3>
            <span className={styles.pipelineHeaderCount}>{orphans.length}</span>
          </div>
          {orphans.map((node) => (
            <PipelineRow
              key={node.task.id}
              node={node}
              onSelect={() => onSelectTask(node.task)}
              isLast
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** Agent detail slide-over panel */
function AgentDetail({
  agent,
  allTasks,
  onClose,
}: {
  agent: ConductorAgent
  allTasks: ConductorTask[]
  onClose: () => void
}) {
  const ideLabel = agent.ide === 'claude-code' ? 'Claude Code' : agent.ide === 'codex' ? 'OpenAI Codex' : agent.ide === 'antigravity' ? 'Antigravity (Gemini)' : agent.ide === 'cursor' ? 'Cursor' : agent.ide ?? 'Unknown'
  const platform = agent.platform ?? (agent.hostname?.includes('Mac') ? 'macOS' : 'unknown')
  const agentTasks = allTasks.filter((t) => t.assigned_to_agent === agent.agentId)
  const currentTask = agentTasks.find((t) => t.status === 'in_progress' || t.status === 'accepted')
  const recentCompleted = agentTasks.filter((t) => t.status === 'completed').slice(0, 5)

  return (
    <div className={styles.detailOverlay} onClick={onClose}>
      <div className={styles.detailPanel} onClick={(e) => e.stopPropagation()}>
        <div className={styles.detailHeader}>
          <h2 className={styles.detailTitle}>Agent Details</h2>
          <button className={styles.detailClose} onClick={onClose}>x</button>
        </div>

        <div className={styles.detailBody}>
          {/* Identity */}
          <div className={styles.agentDetailPanelIdentity}>
            <strong className={styles.agentDetailPanelName}>{agent.agentId}</strong>
            <span className={styles.agentDetailPanelIde}>{ideLabel}</span>
          </div>

          <div className={styles.detailRow}>
            <span className={styles.detailLabel}>Hostname</span>
            <span className={styles.detailValue}>{agent.hostname ?? '-'}</span>
          </div>
          <div className={styles.detailRow}>
            <span className={styles.detailLabel}>Platform</span>
            <span className={styles.detailValue}>{platform}</span>
          </div>
          <div className={styles.detailRow}>
            <span className={styles.detailLabel}>Owner</span>
            <span className={styles.detailValue}>{agent.apiKeyOwner}</span>
          </div>
          <div className={styles.detailRow}>
            <span className={styles.detailLabel}>Status</span>
            <span className={`badge badge-${agent.status === 'busy' ? 'warning' : 'healthy'}`}>
              {agent.status ?? 'online'}
            </span>
          </div>
          <div className={styles.detailRow}>
            <span className={styles.detailLabel}>Connected</span>
            <span className={styles.detailValue}>{new Date(agent.connectedAt).toLocaleString()}</span>
          </div>

          {/* Capabilities */}
          <div className={styles.detailSection}>
            <h3 className={styles.detailSectionTitle}>Capabilities</h3>
            {agent.capabilities && agent.capabilities.length > 0 ? (
              <div className={styles.agentCaps}>
                {agent.capabilities.map((cap) => {
                  const capColor = ['backend','frontend','database','server'].includes(cap) ? styles.capCode
                    : ['review','testing'].includes(cap) ? styles.capReview
                    : ['devops','docker','deploy'].includes(cap) ? styles.capDeploy
                    : ['design'].includes(cap) ? styles.capDesign
                    : ['security'].includes(cap) ? styles.capSecurity : ''
                  return <span key={cap} className={`${styles.capBadge} ${capColor}`}>{cap}</span>
                })}
              </div>
            ) : (
              <span className={styles.agentCapsEmpty}>No capabilities registered</span>
            )}
          </div>

          {/* Current Task */}
          {currentTask && (
            <div className={styles.detailSection}>
              <h3 className={styles.detailSectionTitle}>● Current Task</h3>
              <div className={styles.agentDetailTaskCard}>
                <div className={styles.resultSubtaskHeader}>
                  <span className={styles.resultSubtaskTitle}>{currentTask.title}</span>
                  <StatusBadge status={currentTask.status} />
                </div>
                {currentTask.description && (
                  <p className={styles.resultSubtaskMsg}>{currentTask.description}</p>
                )}
              </div>
            </div>
          )}

          {/* Recent Completed Tasks */}
          {recentCompleted.length > 0 && (
            <div className={styles.detailSection}>
              <h3 className={styles.detailSectionTitle}>Recent Completed ({recentCompleted.length})</h3>
              <div className={styles.resultSubtasks}>
                {recentCompleted.map((t) => (
                  <div key={t.id} className={styles.agentDetailTaskCard}>
                    <div className={styles.resultSubtaskHeader}>
                      <span className={styles.resultSubtaskTitle}>{t.title}</span>
                      <span className={styles.timestamp}>
                        {t.completed_at ? formatTimeAgo(t.completed_at) : '--'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Total stats */}
          <div className={styles.detailSection}>
            <h3 className={styles.detailSectionTitle}>Task Summary</h3>
            <div className={styles.resultSummaryGrid}>
              <div className={styles.resultSummaryItem}>
                <span className={styles.resultSummaryKey}>Total Assigned</span>
                <span className={styles.resultSummaryValue}>{agentTasks.length}</span>
              </div>
              <div className={styles.resultSummaryItem}>
                <span className={styles.resultSummaryKey}>Completed</span>
                <span className={styles.resultSummaryValue}>{agentTasks.filter((t) => t.status === 'completed').length}</span>
              </div>
              <div className={styles.resultSummaryItem}>
                <span className={styles.resultSummaryKey}>In Progress</span>
                <span className={styles.resultSummaryValue}>{agentTasks.filter((t) => t.status === 'in_progress').length}</span>
              </div>
              <div className={styles.resultSummaryItem}>
                <span className={styles.resultSummaryKey}>Failed</span>
                <span className={styles.resultSummaryValue}>{agentTasks.filter((t) => t.status === 'failed').length}</span>
              </div>
            </div>
          </div>
        </div>
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
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [selectedTask, setSelectedTask] = useState<ConductorTask | null>(null)
  const [selectedAgent, setSelectedAgent] = useState<ConductorAgent | null>(null)
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
            {agents.map((agent: ConductorAgent) => {
              const ideIcon = agent.ide === 'claude-code' ? 'C' : agent.ide === 'codex' ? 'X' : agent.ide === 'antigravity' ? 'G' : agent.ide === 'cursor' ? 'Cu' : 'A'
              const ideLabel = agent.ide === 'claude-code' ? 'Claude Code' : agent.ide === 'codex' ? 'OpenAI Codex' : agent.ide === 'antigravity' ? 'Antigravity (Gemini)' : agent.ide === 'cursor' ? 'Cursor' : agent.ide ?? 'Unknown'
              const ideColor = agent.ide === 'claude-code' ? styles.ideBlue : agent.ide === 'codex' ? styles.ideGreen : agent.ide === 'antigravity' ? styles.idePurple : agent.ide === 'cursor' ? styles.ideOrange : ''
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

                  {/* Capabilities */}
                  {agent.capabilities && agent.capabilities.length > 0 ? (
                    <div className={styles.agentCaps}>
                      {agent.capabilities.map((cap) => {
                        const capColor = ['backend','frontend','database','server'].includes(cap) ? styles.capCode
                          : ['review','testing'].includes(cap) ? styles.capReview
                          : ['devops','docker','deploy'].includes(cap) ? styles.capDeploy
                          : ['design'].includes(cap) ? styles.capDesign
                          : ['security'].includes(cap) ? styles.capSecurity : ''
                        return <span key={cap} className={`${styles.capBadge} ${capColor}`}>{cap}</span>
                      })}
                    </div>
                  ) : (
                    <div className={styles.agentCapsEmpty}>No capabilities registered</div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Tasks Section */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Tasks</h2>
          <div className={styles.headerActions}>
            {/* View mode toggle */}
            <div className={styles.viewToggle}>
              <button
                className={`${styles.viewToggleBtn} ${viewMode === 'list' ? styles.viewToggleActive : ''}`}
                onClick={() => setViewMode('list')}
                title="List view"
              >
                List
              </button>
              <button
                className={`${styles.viewToggleBtn} ${viewMode === 'pipeline' ? styles.viewToggleActive : ''}`}
                onClick={() => setViewMode('pipeline')}
                title="Pipeline view"
              >
                Pipeline
              </button>
            </div>
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

        {viewMode === 'pipeline' ? (
          <PipelineView tasks={filteredTasks} onSelectTask={setSelectedTask} />
        ) : filteredTasks.length === 0 && !isLoading ? (
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

      {/* Agent Detail Slide-over */}
      {selectedAgent && (
        <AgentDetail
          agent={selectedAgent}
          allTasks={allTasks}
          onClose={() => setSelectedAgent(null)}
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
