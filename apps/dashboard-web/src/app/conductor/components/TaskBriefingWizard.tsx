'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import {
  type AcceptanceCriterion,
  type ImageAttachment,
  type TaskStrategy,
  getIdeInfo,
} from './shared'
import { StrategyReview } from './StrategyReview'
import {
  createConductorTask,
  getConductorTaskById,
  approveConductorStrategy,
  cancelConductorTask,
  type ConductorAgent,
  type ConductorTask,
} from '@/lib/api'
import styles from './TaskBriefingWizard.module.css'

type WizardStep = 1 | 2 | 3 | 4

export interface TaskPrefill {
  title?: string
  description?: string
  context?: Record<string, unknown>
}

/** Resume a task that's waiting for strategy approval */
export interface ResumeTask {
  task: ConductorTask
  strategy: TaskStrategy
}

interface Props {
  onClose: () => void
  onCreated: () => void
  agents: ConductorAgent[]
  prefill?: TaskPrefill
  resume?: ResumeTask
}



export function TaskBriefingWizard({ onClose, onCreated, agents, prefill, resume }: Props) {
  // ── Step 1: Brief ──
  const [title, setTitle] = useState(resume?.task.title ?? prefill?.title ?? '')
  const [description, setDescription] = useState(resume?.task.description ?? prefill?.description ?? '')
  const [criteria, setCriteria] = useState<AcceptanceCriterion[]>([])
  const [images, setImages] = useState<ImageAttachment[]>([])
  const [priority, setPriority] = useState(resume?.task.priority ?? 5)
  const [tags, setTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // ── Step 2: Assign Lead ──
  const [leadAgent, setLeadAgent] = useState(resume?.task.assigned_to_agent ?? '')

  // ── Step 3: Strategy Review ──
  // If resuming an accepted/analyzing task (no strategy yet), start in analyzing mode
  const resumeIsAnalyzing = resume && !resume.strategy
  const [analyzing, setAnalyzing] = useState(!!resumeIsAnalyzing)
  const [strategy, setStrategy] = useState<TaskStrategy | null>(resume?.strategy && resume.strategy.summary ? resume.strategy : null)
  const [createdTask, setCreatedTask] = useState<ConductorTask | null>(resume?.task ?? null)
  const [progressMessages, setProgressMessages] = useState<string[]>([])
  const [analysisError, setAnalysisError] = useState<string | null>(null)

  // ── Step 4: Pipeline ──
  const [createdTaskIds, setCreatedTaskIds] = useState<string[]>([])

  // ── Wizard state ──
  const [step, setStep] = useState<WizardStep>(resume ? 3 : 1)
  const [submitting, setSubmitting] = useState(false)

  // Ref to abort polling on unmount/retry
  const pollAbortRef = useRef<AbortController | null>(null)

  // Auto-start polling when resuming an accepted/analyzing task
  useEffect(() => {
    if (!resumeIsAnalyzing || !resume?.task.id) return
    const taskId = resume.task.id

    const startPoll = async () => {
      const result = await pollForStrategy(taskId)
      if (result?.type === 'strategy') {
        setStrategy(result.strategy)
        setAnalyzing(false)
      } else if (result?.type === 'completed') {
        setCreatedTaskIds([taskId])
        onCreated()
        setStep(4)
      } else if (result?.type === 'error') {
        setAnalysisError(result.message)
        setAnalyzing(false)
      }
    }
    startPoll()

    return () => { pollAbortRef.current?.abort() }
  }, []) // eslint-disable-line

  // ── Image paste handler ──
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (!item || !item.type.startsWith('image/')) continue
      e.preventDefault()
      const file = item.getAsFile()
      if (!file) continue
      const reader = new FileReader()
      reader.onload = (ev) => {
        const data = ev.target?.result as string
        if (!data) return
        setImages(prev => [...prev, { data, name: file.name || `image-${prev.length + 1}.png` }])
      }
      reader.readAsDataURL(file)
    }
  }, [])

  const handleImageDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const files = e.dataTransfer?.files
    if (!files) return
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      if (!file || !file.type.startsWith('image/')) continue
      const reader = new FileReader()
      reader.onload = (ev) => {
        const data = ev.target?.result as string
        if (!data) return
        setImages(prev => [...prev, { data, name: file.name }])
      }
      reader.readAsDataURL(file)
    }
  }, [])

  // ── Criteria management ──
  const addCriterion = () => {
    setCriteria(prev => [...prev, { id: `c-${Date.now()}`, text: '', completed: false }])
  }
  const updateCriterion = (id: string, text: string) => {
    setCriteria(prev => prev.map(c => c.id === id ? { ...c, text } : c))
  }
  const removeCriterion = (id: string) => {
    setCriteria(prev => prev.filter(c => c.id !== id))
  }

  // ── Tags ──
  const addTag = (tag: string) => {
    const t = tag.trim().toLowerCase()
    if (t && !tags.includes(t)) setTags(prev => [...prev, t])
    setTagInput('')
  }

  // ── Poll for strategy with progress tracking ──
  const pollForStrategy = useCallback(async (taskId: string): Promise<{ type: 'strategy'; strategy: TaskStrategy } | { type: 'completed' } | { type: 'error'; message: string } | null> => {
    const POLL_INTERVAL = 2000
    const TIMEOUT = 5 * 60 * 1000

    const abort = new AbortController()
    pollAbortRef.current = abort

    const startTime = Date.now()
    let lastLogCount = 0

    return new Promise((resolve) => {
      const check = async () => {
        if (abort.signal.aborted) {
          resolve(null)
          return
        }
        if (Date.now() - startTime > TIMEOUT) {
          resolve({ type: 'error', message: `Lead agent "${leadAgent}" did not respond within 5 minutes. The agent may be busy or disconnected.` })
          return
        }
        try {
          const taskData = await getConductorTaskById(taskId)

          // Agent submitted strategy — show for approval
          if (taskData.status === 'strategy_review') {
            const ctx = typeof taskData.context === 'string'
              ? JSON.parse(taskData.context)
              : taskData.context
            if (ctx?.strategy) {
              resolve({ type: 'strategy', strategy: ctx.strategy as TaskStrategy })
              return
            }
          }

          // Agent completed directly — treat as simple pipeline (1 task)
          if (taskData.status === 'completed') {
            resolve({ type: 'completed' })
            return
          }

          // Agent failed
          if (taskData.status === 'failed') {
            resolve({ type: 'error', message: `Lead agent reported task failure. Check agent logs for details.` })
            return
          }

          // Cancelled externally
          if (taskData.status === 'cancelled') {
            resolve({ type: 'error', message: `Task was cancelled.` })
            return
          }

          // Extract progress from task logs (embedded in GET /:id response)
          // We re-fetch to get logs too
          try {
            const fullRes = await fetch(`${window.location.origin}/api/conductor/${taskId}`)
            if (fullRes.ok) {
              const fullData = await fullRes.json() as { task: ConductorTask; logs?: Array<{ action: string; message: string | null }> }
              const logs = fullData.logs ?? []
              const progressLogs = logs.filter(l => l.action === 'progress' && l.message)
              if (progressLogs.length > lastLogCount) {
                const newLogs = progressLogs.slice(lastLogCount)
                lastLogCount = progressLogs.length
                setProgressMessages(prev => [
                  ...prev,
                  ...newLogs.map(l => l.message!),
                ])
              }
            }
          } catch { /* non-critical */ }
        } catch (err) {
          // Network error during poll — don't fail immediately, just log
          console.warn('Poll error:', err)
        }
        setTimeout(check, POLL_INTERVAL)
      }
      check()
    })
  }, [leadAgent])

  // ── Step 2 → 3: Create task and start analysis ──
  const handleAssignAndAnalyze = async () => {
    if (!leadAgent) return
    setStep(3)
    setAnalyzing(true)
    setAnalysisError(null)
    setProgressMessages([])
    setStrategy(null)

    try {
      // Build description with Lead Agent protocol instructions
      const imageMetadata = images.length > 0
        ? { attachments: images.map(img => ({ type: 'image', name: img.name, data: img.data })) }
        : undefined

      const userBrief = [
        description.trim(),
        criteria.filter(c => c.text.trim()).length > 0
          ? '\n\n**Acceptance Criteria:**\n' + criteria.filter(c => c.text.trim()).map(c => `- [ ] ${c.text}`).join('\n')
          : '',
        tags.length > 0 ? `\n\n**Tags:** ${tags.join(', ')}` : '',
      ].join('')

      const agentInstructions = [
        '\n\n---',
        '## Lead Agent Instructions (auto-generated)',
        `You are the **Lead Agent** for this orchestrated task. Your role is to ANALYZE and PLAN, not to implement directly.`,
        '',
        '### Required steps:',
        '1. **Analyze** the task brief above',
        '2. **Call `cortex_task_submit_strategy`** with your proposed strategy:',
        '   - `taskId`: this task ID',
        '   - `summary`: your analysis summary',
        '   - `roles[]`: team roles needed (e.g. ui, backend, review) with agent assignments',
        '   - `subtasks[]`: work items for each role',
        '   - `estimatedEffort`: effort estimate',
        '3. **Wait** for user approval on the dashboard before proceeding',
        '',
        '### Available agents:',
        agents.map(a => `- **${a.agentId}** (${a.ide ?? 'unknown'}) — capabilities: ${a.capabilities?.join(', ') || 'none'}`).join('\n'),
        '',
        '**DO NOT implement the task yourself. DO NOT skip the strategy step.**',
      ].join('\n')

      // Create task or reuse existing one
      let taskId: string
      if (createdTask) {
        taskId = createdTask.id
      } else {
        const res = await createConductorTask({
          title: title.trim(),
          description: userBrief + agentInstructions,
          assignedTo: leadAgent,
          priority,
          agentId: 'dashboard-ui',
          metadata: {
            ...imageMetadata,
            workflow: 'orchestrated',
            phase: 'analyzing',
            acceptanceCriteria: criteria.filter(c => c.text.trim()).map(c => c.text),
            tags,
          },
        })
        setCreatedTask(res.task)
        taskId = res.task.id
      }

      const pollResult = await pollForStrategy(taskId)

      if (pollResult?.type === 'strategy') {
        setStrategy(pollResult.strategy)
        setAnalyzing(false)
      } else if (pollResult?.type === 'completed') {
        // Agent completed directly — show as simple pipeline
        setCreatedTaskIds([taskId])
        onCreated()
        setStep(4)
      } else if (pollResult?.type === 'error') {
        setAnalysisError(pollResult.message)
        setAnalyzing(false)
      } else {
        // Aborted (null) — do nothing, likely retrying
        setAnalyzing(false)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error creating task'
      setAnalysisError(`Failed to create task: ${message}`)
      setAnalyzing(false)
    }
  }

  // ── Retry analysis ──
  const handleRetry = () => {
    // Abort current poll if any
    pollAbortRef.current?.abort()
    // Re-run analysis with same task (avoids creating duplicates)
    handleAssignAndAnalyze()
  }

  // ── Cancel and clean up garbage task ──
  const handleCancel = async () => {
    pollAbortRef.current?.abort()
    if (createdTask) {
      try {
        await cancelConductorTask(createdTask.id)
      } catch { /* ignore if already cancelled */ }
    }
    setCreatedTask(null)
    setAnalysisError(null)
    setStrategy(null)
    setStep(2)
  }

  // ── Step 3 → 4: Approve strategy and create subtask pipeline ──
  const handleApproveStrategy = async (approvedStrategy: TaskStrategy) => {
    if (!createdTask) return
    setSubmitting(true)

    try {
      const taskIds = [createdTask.id]

      // Create subtasks with dependencies:
      // - Implementation tasks: sequential (each depends on previous)
      // - Review/QA tasks: depend on ALL implementation tasks
      const implTaskIds: string[] = []
      const reviewSubtasks: typeof approvedStrategy.subtasks = []
      const implSubtasks: typeof approvedStrategy.subtasks = []

      for (const subtask of approvedStrategy.subtasks) {
        const roleLower = subtask.role.toLowerCase()
        const titleLower = subtask.title.toLowerCase()
        const isReviewQA = roleLower.includes('review') || roleLower.includes('qa') ||
          titleLower.includes('review') || titleLower.includes('qa') || titleLower.includes('audit')
        if (isReviewQA) {
          reviewSubtasks.push(subtask)
        } else {
          implSubtasks.push(subtask)
        }
      }

      // Create implementation tasks sequentially
      let prevTaskId: string | null = null
      for (const subtask of implSubtasks) {
        const role = approvedStrategy.roles.find(r => r.role === subtask.role)
        if (!role?.agent) continue

        const subRes = await createConductorTask({
          title: subtask.title,
          description: [
            subtask.description ?? '',
            `\n\nRole: ${role.label}`,
            `Parent task: ${title.trim()}`,
            `\n\n---`,
            `**IMPORTANT:** When you finish this task, you MUST call \`cortex_task_update\` with the task ID from the \`[Cortex Task ...]\` header and \`status: "completed"\`. Include a \`result\` object summarizing what was done (files changed, key decisions). Do NOT skip this step — the pipeline cannot continue without it.`,
          ].join(''),
          assignedTo: role.agent,
          priority,
          agentId: 'dashboard-ui',
          parentTaskId: createdTask.id,
          dependsOn: prevTaskId ? [prevTaskId] : undefined,
          metadata: {
            role: role.role,
            workflow: 'orchestrated',
            phase: 'execution',
          },
        })
        taskIds.push(subRes.task.id)
        implTaskIds.push(subRes.task.id)
        prevTaskId = subRes.task.id
      }

      // Create review/QA tasks — depend on ALL implementation tasks
      for (const subtask of reviewSubtasks) {
        const role = approvedStrategy.roles.find(r => r.role === subtask.role)
        if (!role?.agent) continue

        const subRes = await createConductorTask({
          title: subtask.title,
          description: [
            subtask.description ?? '',
            `\n\nRole: ${role.label}`,
            `Parent task: ${title.trim()}`,
            `\n\nThis is a QA/Review task. Wait for ALL implementation tasks to complete before starting. Review the combined output of all tasks.`,
            `\n\n---`,
            `**IMPORTANT:** When you finish this task, you MUST call \`cortex_task_update\` with the task ID from the \`[Cortex Task ...]\` header and \`status: "completed"\`. Include a \`result\` object summarizing what was done (files changed, key decisions). Do NOT skip this step — the pipeline cannot continue without it.`,
          ].join(''),
          assignedTo: role.agent,
          priority: Math.max(1, priority - 1),
          agentId: 'dashboard-ui',
          parentTaskId: createdTask.id,
          dependsOn: implTaskIds.length > 0 ? implTaskIds : undefined,
          metadata: {
            role: role.role,
            workflow: 'orchestrated',
            phase: 'review',
          },
        })
        taskIds.push(subRes.task.id)
      }

      // Approve the strategy on backend
      try { await approveConductorStrategy(createdTask.id) } catch { /* non-critical */ }

      setCreatedTaskIds(taskIds)
      onCreated()
      setStep(4)
    } catch (err) {
      console.error('Failed to create subtasks:', err)
    } finally {
      setSubmitting(false)
    }
  }

  // ── Step labels ──
  const stepLabels = ['Brief', 'Lead Agent', 'Strategy', 'Pipeline']
  const priorityLabel = priority <= 3 ? 'Critical' : priority <= 5 ? 'High' : priority <= 7 ? 'Medium' : 'Low'

  return (
    <div className={styles.wizardOverlay} onClick={onClose}>
      <div className={styles.wizardPanel} onClick={(e) => e.stopPropagation()}>
        {/* Step indicator */}
        <div className={styles.stepIndicator}>
          {stepLabels.map((label, i) => (
            <div
              key={label}
              className={`${styles.stepItem} ${step === (i + 1) as WizardStep ? styles.stepItemActive : ''} ${step > i + 1 ? styles.stepItemDone : ''}`}
            >
              <span className={styles.stepNum}>{step > i + 1 ? '✓' : i + 1}</span>
              <span className={styles.stepLabel}>{label}</span>
              {i < stepLabels.length - 1 && <span className={styles.stepLine} />}
            </div>
          ))}
        </div>

        {/* Step 1: Brief */}
        {step === 1 && (
          <div className={styles.wizardBody}>
            <h2 className={styles.wizardTitle}>Describe your task</h2>
            <p className={styles.wizardSubtitle}>Be thorough — the lead agent will use this to plan the work</p>

            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel}>
                Title <span className={styles.fieldRequired}>*</span>
              </label>
              <input
                className={styles.fieldInput}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="What needs to be done?"
                autoFocus
              />
            </div>

            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel}>Description</label>
              <textarea
                ref={textareaRef}
                className={styles.fieldTextarea}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onPaste={handlePaste}
                onDrop={handleImageDrop}
                onDragOver={(e) => e.preventDefault()}
                placeholder="Describe the task in detail. Include context, requirements, and constraints. Paste screenshots with Ctrl+V..."
                rows={6}
              />
              <span className={styles.fieldHint}>Tip: Paste screenshots directly (Ctrl+V) or drag & drop images</span>
            </div>

            {/* Image previews */}
            {images.length > 0 && (
              <div className={styles.imageGrid}>
                {images.map((img, i) => (
                  <div key={i} className={styles.imageThumb}>
                    <img src={img.data} alt={img.name} />
                    <button
                      type="button"
                      className={styles.imageRemove}
                      onClick={() => setImages(prev => prev.filter((_, idx) => idx !== i))}
                    >×</button>
                  </div>
                ))}
              </div>
            )}

            {/* Acceptance Criteria */}
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel}>Acceptance Criteria</label>
              <div className={styles.criteriaList}>
                {criteria.map((c) => (
                  <div key={c.id} className={styles.criterionItem}>
                    <span style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>☐</span>
                    <input
                      className={styles.criterionInput}
                      value={c.text}
                      onChange={(e) => updateCriterion(c.id, e.target.value)}
                      placeholder="e.g., Pipeline nodes should pulse when active"
                    />
                    <button className={styles.criterionRemove} onClick={() => removeCriterion(c.id)}>×</button>
                  </div>
                ))}
                <button className={styles.addCriterionBtn} onClick={addCriterion}>
                  + Add criterion
                </button>
              </div>
            </div>

            {/* Priority */}
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel}>Priority</label>
              <div className={styles.prioritySlider}>
                <input
                  type="range"
                  className={styles.priorityTrack}
                  min={1}
                  max={10}
                  value={priority}
                  onChange={(e) => setPriority(Number(e.target.value))}
                />
                <div>
                  <span className={styles.priorityValue}>{priority}</span>
                  <span className={styles.priorityLabel}>{priorityLabel}</span>
                </div>
              </div>
            </div>

            {/* Tags */}
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel}>Tags</label>
              <div className={styles.tagsList}>
                {tags.map((tag) => (
                  <span key={tag} className={styles.tag}>
                    {tag}
                    <button className={styles.tagRemove} onClick={() => setTags(prev => prev.filter(t => t !== tag))}>×</button>
                  </span>
                ))}
                <input
                  className={styles.tagInput}
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ',') {
                      e.preventDefault()
                      addTag(tagInput)
                    }
                  }}
                  onBlur={() => { if (tagInput) addTag(tagInput) }}
                  placeholder="Add tag..."
                />
              </div>
            </div>

            <div className={styles.wizardActions}>
              <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Cancel</button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!title.trim()}
                onClick={() => setStep(2)}
              >
                Next: Assign Lead →
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Assign Lead Agent */}
        {step === 2 && (
          <div className={styles.wizardBody}>
            <h2 className={styles.wizardTitle}>Assign Lead Agent</h2>
            <p className={styles.wizardSubtitle}>This agent will own and orchestrate the task</p>

            <div className={styles.orchestratorCallout}>
              <span className={styles.orchestratorCalloutIcon}>🎯</span>
              <div className={styles.orchestratorCalloutText}>
                <strong>The lead agent will:</strong> analyze task requirements, propose a strategy with role assignments, and coordinate execution after your approval.
              </div>
            </div>

            <div className={styles.agentGrid}>
              {agents.map((agent) => {
                const { icon, label, colorClass } = getIdeInfo(agent.ide)
                const isSelected = leadAgent === agent.agentId

                return (
                  <div
                    key={agent.agentId}
                    className={`${styles.agentOption} ${isSelected ? styles.agentOptionSelected : ''}`}
                    onClick={() => setLeadAgent(agent.agentId)}
                  >
                    {isSelected && <span className={styles.agentOptionCheck}>✓</span>}
                    <div className={styles.agentOptionHeader}>
                      <span className={`${styles.agentOptionIcon} ${styles[colorClass] || ''}`}>{icon}</span>
                      <div>
                        <div className={styles.agentOptionName}>{agent.agentId}</div>
                        <div className={styles.agentOptionIde}>{label}</div>
                      </div>
                    </div>
                    {agent.capabilities && agent.capabilities.length > 0 && (
                      <div className={styles.agentOptionCaps}>
                        {agent.capabilities.map((cap) => (
                          <span key={cap} className={styles.agentOptionCap}>{cap}</span>
                        ))}
                      </div>
                    )}
                    <div className={styles.agentOptionStatus}>
                      <span className={`${styles.statusDot} ${agent.status === 'busy' ? styles.statusDotBusy : ''}`} />
                      {agent.status === 'idle' ? 'Available' : agent.status === 'busy' ? 'Busy' : 'Online'}
                    </div>
                  </div>
                )
              })}
            </div>

            {agents.length === 0 && (
              <div style={{ textAlign: 'center', padding: 'var(--space-6)', color: 'var(--text-tertiary)' }}>
                No agents online. Tasks will be queued for pickup.
              </div>
            )}

            <div className={styles.wizardActions}>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setStep(1)}>&larr; Back</button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!leadAgent}
                onClick={handleAssignAndAnalyze}
              >
                Assign & Analyze →
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Strategy Review */}
        {step === 3 && (
          <StrategyReview
            analyzing={analyzing}
            strategy={strategy}
            leadAgent={leadAgent}
            agents={agents}
            submitting={submitting}
            progressMessages={progressMessages}
            error={analysisError}
            onApprove={handleApproveStrategy}
            onReject={() => {
              pollAbortRef.current?.abort()
              setStrategy(null)
              setAnalyzing(false)
              setAnalysisError(null)
              setProgressMessages([])
              setStep(2)
            }}
            onRetry={handleRetry}
            onCancel={handleCancel}
            onBack={() => {
              pollAbortRef.current?.abort()
              setAnalyzing(false)
              setStep(2)
            }}
          />
        )}

        {/* Step 4: Pipeline Active */}
        {step === 4 && (
          <div className={styles.wizardBody}>
            <h2 className={styles.wizardTitle}>Pipeline Active</h2>
            <p className={styles.wizardSubtitle}>
              {createdTaskIds.length === 1
                ? 'Task dispatched. Close this wizard and switch to Pipeline view to track progress.'
                : `${createdTaskIds.length} tasks created. Close this wizard and switch to Pipeline view to see the live diagram.`
              }
            </p>
            <div style={{ textAlign: 'center', padding: 'var(--space-6)' }}>
              <div style={{
                width: '64px',
                height: '64px',
                borderRadius: '50%',
                background: 'rgba(16, 185, 129, 0.1)',
                border: '2px solid var(--status-healthy, #10b981)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto var(--space-4)',
                fontSize: '1.5rem',
              }}>
                ✓
              </div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                {createdTaskIds.length === 1
                  ? 'Task is being executed by the assigned agent.'
                  : `Strategy approved. ${createdTaskIds.length - 1} subtasks dispatched to agents.`
                }
              </p>
            </div>
            <div className={styles.wizardActions}>
              <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>
                Close & View Pipeline
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
