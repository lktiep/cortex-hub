'use client'

import { useState, useCallback, useEffect, useRef, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import DashboardLayout from '@/components/layout/DashboardLayout'
import useSWR from 'swr'
import {
  getProject, updateProject,
  startIndexing, getIndexStatus, getIndexHistory, cancelIndexing,
  listBranches, getBranchDiff, getBranchIndexSummary, testGitConnection,
  startMemNineEmbedding, buildDocsKnowledge,
  type IndexStatus, type IndexJobSummary, type BranchIndexStatus,
  getProjectState, type ProjectStateResponse,
} from '@/lib/api'
import { parseDateSafe } from '@/lib/date'
import { Link, Cloud, Monitor, Clock, Search, Brain, CheckCircle, XCircle, AlertTriangle, RefreshCw, Rocket, Puzzle, Plug, BookMarked, ClipboardList, BarChart3, Bot, Repeat, Timer, Play, type LucideIcon, ICON_INLINE } from '@/lib/icons'
import styles from './page.module.css'

const GIT_PROVIDERS: { value: string; label: string; icon: LucideIcon }[] = [
  { value: 'github', label: 'GitHub', icon: Link },
  { value: 'gitlab', label: 'GitLab', icon: Link },
  { value: 'bitbucket', label: 'Bitbucket', icon: Link },
  { value: 'azure', label: 'Azure', icon: Cloud },
  { value: 'local', label: 'Local', icon: Monitor },
]

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: LucideIcon }> = {
  pending:   { label: 'Pending',   color: '#888', icon: Clock },
  cloning:   { label: 'Cloning',   color: '#f5a623', icon: Clock },
  analyzing: { label: 'Analyzing', color: '#4a90d9', icon: Search },
  ingesting: { label: 'Ingesting', color: '#9b59b6', icon: Brain },
  done:      { label: 'Done',      color: '#27ae60', icon: CheckCircle },
  error:     { label: 'Error',     color: '#e74c3c', icon: XCircle },
  none:      { label: 'Not indexed', color: '#666', icon: Clock },
}

function Ico({ icon: Icon }: { icon: LucideIcon }) { return <Icon {...ICON_INLINE} /> }

function formatRelativeTime(dateStr: string): string {
  const now = Date.now()
  const then = parseDateSafe(dateStr).getTime()
  const diff = now - then
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  const d = parseDateSafe(dateStr)
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function ProjectStatePanel({ projectId }: { projectId: string }) {
  const { data, isLoading, error } = useSWR<ProjectStateResponse>(
    projectId ? `project-state-${projectId}` : null,
    () => getProjectState(projectId),
    { refreshInterval: 15000 }
  )

  if (isLoading) return <div className={`card ${styles.stateCard}`}>Loading memory state...</div>
  if (error) return <div className={`card ${styles.stateCard}`}>Failed to load state</div>

  const memories = data?.memories ?? []

  return (
    <div className={`card ${styles.stateCard}`}>
      <h3 className={styles.infoTitle}><Brain {...ICON_INLINE} /> Project Memory State</h3>
      {memories.length === 0 ? (
        <p className={styles.emptyHint}>No recent progress memories found for this project.</p>
      ) : (
        <div className={styles.stateList}>
          {memories.map((m, i) => (
            <div key={i} className={styles.stateRow}>
              <div className={styles.stateContent}>{m.content}</div>
              <div className={styles.stateMeta}>Score: {m.score !== undefined ? m.score.toFixed(3) : 'N/A'}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function IndexingPanel({ projectId, hasGitUrl }: { projectId: string; hasGitUrl: boolean }) {
  const [branch, setBranch] = useState('')
  const [starting, setStarting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [embeddingBranch, setEmbeddingBranch] = useState<string | null>(null)
  const [historyPage, setHistoryPage] = useState(1)

  const { data: status, mutate: mutateStatus } = useSWR<IndexStatus>(
    `index-status-${projectId}`,
    () => getIndexStatus(projectId),
    { refreshInterval: 5000 }
  )

  const { data: historyData, mutate: mutateHistory } = useSWR(
    `index-history-${projectId}-page-${historyPage}`,
    () => getIndexHistory(projectId, historyPage, 10),
    { refreshInterval: 15000 }
  )

  const { data: branchesData, mutate: mutateBranches } = useSWR(
    hasGitUrl ? `branches-${projectId}` : null,
    () => listBranches(projectId),
    { refreshInterval: 60000 }
  )

  // Auto-set branch when branches load (use first branch as default)
  useEffect(() => {
    const branches = branchesData?.branches ?? []
    if (branches.length > 0 && !branch) {
      // Prefer 'master' or 'main' if available, otherwise first branch
      const defaultBranch = (branches.find((b: string) => b === 'master') ??
                            branches.find((b: string) => b === 'main') ??
                            branches[0]) as string
      setBranch(defaultBranch)
    }
  }, [branchesData, branch])

  const handleRefreshBranches = useCallback(async () => {
    setBranchesLoading(true)
    try {
      await mutateBranches()
    } finally {
      setBranchesLoading(false)
    }
  }, [mutateBranches])

  const { data: branchIndexData } = useSWR(
    `branch-index-${projectId}`,
    () => getBranchIndexSummary(projectId),
    { refreshInterval: 10000 }
  )

  const { data: diffData } = useSWR(
    branch && branch !== 'main' && branch !== 'master' ? `diff-${projectId}-${branch}` : null,
    () => getBranchDiff(projectId, branch),
  )

  const isActive = status && ['pending', 'cloning', 'analyzing', 'ingesting'].includes(status.status)

  // Poll faster when active (1.5s)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    if (isActive) {
      pollRef.current = setInterval(() => { mutateStatus() }, 1500)
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [isActive, mutateStatus])

  const handleStart = useCallback(async () => {
    setStarting(true)
    try {
      await startIndexing(projectId, branch)
      mutateStatus()
      mutateHistory()
    } catch {
      // handled
    } finally {
      setStarting(false)
    }
  }, [projectId, branch, mutateStatus, mutateHistory])

  const handleCancel = useCallback(async () => {
    setCancelling(true)
    try {
      await cancelIndexing(projectId)
      mutateStatus()
      mutateHistory()
    } catch {
      // handled
    } finally {
      setCancelling(false)
    }
  }, [projectId, mutateStatus, mutateHistory])

  const statusInfo = STATUS_CONFIG[status?.status ?? 'none'] ?? { label: 'Unknown', color: '#666', icon: Clock }
  const history = historyData?.jobs ?? []
  const branches = branchesData?.branches ?? []
  const indexedBranches = branchIndexData?.branches ?? []

  const handleRunMem9 = useCallback(async (targetBranch: string) => {
    setEmbeddingBranch(targetBranch)
    try {
      await startMemNineEmbedding(projectId, targetBranch)
      // Refresh branch index data
      if (branchIndexData) {
        // Re-fetch will happen via SWR refreshInterval
      }
    } catch {
      // handled
    } finally {
      setEmbeddingBranch(null)
    }
  }, [projectId, branchIndexData])

  return (
    <div className={`card ${styles.indexingCard}`}>
      <div className={styles.indexingHeader}>
        <h3 className={styles.infoTitle}>
          <Rocket {...ICON_INLINE} /> Code Indexing
        </h3>
        <span className={styles.statusBadge} style={{ background: statusInfo.color }}>
          <Ico icon={statusInfo.icon} /> {statusInfo.label}
        </span>
      </div>

      {/* Current Status */}
      {status && status.status !== 'none' && (
        <div className={styles.indexingStatus}>
          <div className={styles.progressContainer}>
            <div className={styles.progressBar}>
              <div
                className={`${styles.progressFill} ${isActive ? styles.progressAnimated : ''}`}
                style={{ width: `${status.progress ?? 0}%` }}
              />
            </div>
            <span className={styles.progressText}>{status.progress ?? 0}%</span>
          </div>
          <div className={styles.indexingMeta}>
            {status.branch && <span>Branch: <strong>{status.branch}</strong></span>}
            {(status.symbolsFound ?? 0) > 0 && <span><Puzzle {...ICON_INLINE} /> {status.symbolsFound} symbols</span>}
            {(status.totalFiles ?? 0) > 0 && <span>{status.totalFiles} files</span>}
          </div>
          {status.error && (
            <div className={styles.indexingError}>
              <AlertTriangle {...ICON_INLINE} /> {status.error}
            </div>
          )}
          {status.log && (
            <div className={styles.logSection}>
              <button
                className={styles.logToggle}
                onClick={() => setShowLog(!showLog)}
              >
                {showLog ? '▼ Hide Log' : '▶ Show Log'}
              </button>
              {showLog && (
                <pre className={styles.logOutput}>{status.log}</pre>
              )}
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      {hasGitUrl && (
        <div className={styles.indexingActions}>
          <div className={styles.branchInput}>
            <label className={styles.branchLabel}>Branch:</label>
            {branches.length > 0 ? (
              <select
                className={styles.branchField}
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                disabled={isActive}
              >
                {branches.map((b: string) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            ) : (
              <input
                className={styles.branchField}
                type="text"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="main"
                disabled={isActive}
              />
            )}
            <button
              className={styles.refreshBtn}
              onClick={handleRefreshBranches}
              disabled={branchesLoading || isActive}
              title="Refresh branches from remote"
            >
              {branchesLoading ? <Clock {...ICON_INLINE} /> : <RefreshCw {...ICON_INLINE} />}
            </button>
          </div>
          {isActive ? (
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleCancel}
              disabled={cancelling}
              style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
            >
              {cancelling ? 'Cancelling...' : '⏹ Cancel'}
            </button>
          ) : (
            <button
              className="btn btn-primary btn-sm"
              onClick={handleStart}
              disabled={starting || !branch.trim()}
            >
              {starting ? 'Starting...' : <><Rocket {...ICON_INLINE} /> Start Indexing</>}
            </button>
          )}
        </div>
      )}

      {!hasGitUrl && (
        <div className={styles.indexingEmpty}>
          Connect a Git repository first to enable code indexing.
        </div>
      )}

      {/* Branch Diff (when non-main branch selected) */}
      {diffData && diffData.summary && diffData.summary.total > 0 && (
        <div className={styles.diffSection}>
          <button
            className={styles.diffToggle}
            onClick={() => setShowDiff(!showDiff)}
          >
            {showDiff ? '▼' : '▶'} Branch Diff vs {diffData.base ?? 'main'}:
            <span className={styles.diffBadge} style={{ background: '#27ae60' }}>+{diffData.summary.added}</span>
            <span className={styles.diffBadge} style={{ background: '#f5a623' }}>~{diffData.summary.modified}</span>
            <span className={styles.diffBadge} style={{ background: '#e74c3c' }}>-{diffData.summary.deleted}</span>
            <span className={styles.diffTotal}>{diffData.summary.total} files</span>
          </button>
          {showDiff && (
            <div className={styles.diffList}>
              {diffData.diff.slice(0, 50).map((d: { status: string; file: string }, i: number) => (
                <div key={i} className={styles.diffRow}>
                  <span className={styles.diffStatus} data-status={d.status}>
                    {d.status === 'added' ? '+' : d.status === 'deleted' ? '−' : '~'}
                  </span>
                  <span className={styles.diffFile}>{d.file}</span>
                </div>
              ))}
              {diffData.diff.length > 50 && (
                <div className={styles.diffMore}>... and {diffData.diff.length - 50} more files</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Per-Branch Index Status */}
      {indexedBranches.length > 0 && (
        <div className={styles.branchStatusSection}>
          <h4 className={styles.historyTitle}>Indexed Branches</h4>
          <div className={styles.branchStatusGrid}>
            {indexedBranches.map((b: BranchIndexStatus) => {
              const bStatus = STATUS_CONFIG[b.status] ?? { label: b.status, color: '#666', icon: Clock }
              const mem9Status = b.mem9_status ?? 'pending'
              const mem9Done = mem9Status === 'done' && (b.mem9_chunks ?? 0) > 0
              const mem9Running = mem9Status === 'embedding'
              const mem9Pending = !mem9Done && !mem9Running && mem9Status !== 'error'
              const gnDone = b.status === 'done'
              return (
                <div key={b.branch} className={styles.branchStatusCard}>
                  <div className={styles.branchStatusName}>
                    <span className={styles.branchDot} style={{ background: bStatus.color }} />
                    <span className={styles.branchNameText} title={b.branch}>{b.branch}</span>
                  </div>
                  {/* GitNexus row */}
                  <div className={styles.branchStatusMeta}>
                    <span><Ico icon={bStatus.icon} /> {bStatus.label}</span>
                    <span>{b.symbols_found} symbols</span>
                    <span>{b.total_files} files</span>
                  </div>
                  {/* mem9 row */}
                  <div className={styles.branchMem9Row}>
                    <span className={styles.branchMem9Label}><Brain {...ICON_INLINE} /> mem9:</span>
                    {mem9Done && (
                      <span className={styles.branchMem9Badge} data-status="done">
                        <CheckCircle {...ICON_INLINE} /> {b.mem9_chunks} chunks
                      </span>
                    )}
                    {mem9Running && (
                      <span className={styles.branchMem9Badge} data-status="embedding">
                        <span className={styles.mem9ProgressWrap}>
                          <span className={styles.mem9ProgressBar}>
                            <span
                              className={styles.mem9ProgressFill}
                              style={{ width: `${b.mem9_progress ?? 0}%` }}
                            />
                          </span>
                          <span className={styles.mem9ProgressText}>
                            {(b.mem9_progress ?? 0) > 0
                              ? `${b.mem9_progress}% · ${b.mem9_chunks}/${b.mem9_total_chunks}`
                              : <><Clock {...ICON_INLINE} /> Starting...</>}
                          </span>
                        </span>
                      </span>
                    )}
                    {mem9Status === 'error' && (
                      <span className={styles.branchMem9Badge} data-status="error">
                        <XCircle {...ICON_INLINE} /> Error
                      </span>
                    )}
                    {mem9Pending && (
                      <span className={styles.branchMem9Badge} data-status="pending">
                        — Pending
                      </span>
                    )}
                    {gnDone && (mem9Pending || mem9Status === 'error') && (
                      <button
                        className={styles.branchMem9Btn}
                        onClick={() => handleRunMem9(b.branch)}
                        disabled={embeddingBranch === b.branch}
                      >
                        {embeddingBranch === b.branch ? <Clock {...ICON_INLINE} /> : mem9Status === 'error' ? <RefreshCw {...ICON_INLINE} /> : <Play {...ICON_INLINE} />}
                      </button>
                    )}
                    {gnDone && mem9Done && (
                      <button
                        className={styles.branchMem9Btn}
                        onClick={() => handleRunMem9(b.branch)}
                        disabled={embeddingBranch === b.branch}
                        title="Re-run mem9 embedding"
                      >
                        <RefreshCw {...ICON_INLINE} />
                      </button>
                    )}
                  </div>
                  {/* Knowledge docs row */}
                  <div className={styles.branchMem9Row}>
                    <span className={styles.branchMem9Label}><BookMarked {...ICON_INLINE} /> knowledge:</span>
                    {(b.docs_knowledge_count ?? 0) > 0 ? (
                      <span className={styles.branchMem9Badge} data-status="done">
                        <CheckCircle {...ICON_INLINE} /> {b.docs_knowledge_count} items
                      </span>
                    ) : b.docs_knowledge_status === 'processing' ? (
                      <span className={styles.branchMem9Badge} data-status="embedding">
                        <Clock {...ICON_INLINE} /> Building...
                      </span>
                    ) : b.docs_knowledge_status === 'error' ? (
                      <span className={styles.branchMem9Badge} data-status="error">
                        <XCircle {...ICON_INLINE} /> Error
                      </span>
                    ) : (
                      <span className={styles.branchMem9Badge} data-status="pending">
                        — None
                      </span>
                    )}
                  </div>
                  {b.completed_at && (
                    <div className={styles.branchStatusDate}>
                      {formatRelativeTime(b.completed_at)}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* History */}
      {history.length > 0 && (
        <div className={styles.indexingHistory}>
          <div className={styles.historyHeader}>
            <h4 className={styles.historyTitle}>Index History</h4>
            {(historyData?.totalPages ?? 1) > 1 && (
              <span className={styles.historyCount}>{historyData?.total ?? 0} total</span>
            )}
          </div>
          <div className={styles.historyTable}>
            <div className={styles.historyHeaderRow}>
              <span>Branch</span>
              <span>Status</span>
              <span>Commit</span>
              <span>Symbols</span>
              <span>Files</span>
              <span>Time</span>
            </div>
            {history.map((job: IndexJobSummary) => {
              const jobStatus = STATUS_CONFIG[job.status] ?? { label: 'Unknown', color: '#666', icon: Clock }
              const ts = job.completed_at ?? job.started_at ?? job.created_at
              const TriggerIcon = job.triggered_by === 'push' ? RefreshCw : job.triggered_by === 'reindex' ? Repeat : job.triggered_by === 'schedule' ? Timer : Play
              return (
                <div key={job.id} className={styles.historyRow}>
                  <span className={styles.historyBranch}>{job.branch}</span>
                  <span className={styles.historyStatus} style={{ color: jobStatus.color }}>
                    <Ico icon={jobStatus.icon} /> {jobStatus.label}
                  </span>
                  <span className={styles.historyCommit} title={job.commit_message ?? undefined}>
                    {job.commit_hash ? (
                      <>
                        <code className={styles.commitHash}>{job.commit_hash}</code>
                        {job.commit_message && (
                          <span className={styles.commitMsg}>{job.commit_message.slice(0, 40)}{job.commit_message.length > 40 ? '…' : ''}</span>
                        )}
                      </>
                    ) : (
                      <span className={styles.commitEmpty}>—</span>
                    )}
                  </span>
                  <span>{job.symbols_found}</span>
                  <span>{job.total_files}</span>
                  <span className={styles.historyDate} title={parseDateSafe(ts).toLocaleString()}>
                    <span className={styles.triggerIcon}><TriggerIcon {...ICON_INLINE} /></span>
                    {formatRelativeTime(ts)}
                  </span>
                </div>
              )
            })}
          </div>
          {/* Pagination */}
          {(historyData?.totalPages ?? 1) > 1 && (
            <div className={styles.pagination}>
              <button
                className={styles.paginationBtn}
                disabled={historyPage <= 1}
                onClick={() => setHistoryPage(p => Math.max(1, p - 1))}
              >
                ← Prev
              </button>
              <span className={styles.paginationInfo}>
                Page {historyPage} / {historyData?.totalPages ?? 1}
              </span>
              <button
                className={styles.paginationBtn}
                disabled={historyPage >= (historyData?.totalPages ?? 1)}
                onClick={() => setHistoryPage(p => p + 1)}
              >
                Next →
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}


function ProjectContent() {
  const searchParams = useSearchParams()
  const projectId = searchParams.get('id')

  const { data: project, error, isLoading, mutate } = useSWR(
    projectId ? `project-${projectId}` : null,
    () => (projectId ? getProject(projectId) : null),
    { refreshInterval: 30000 }
  )

  const [showEditGit, setShowEditGit] = useState(false)
  const [gitUrl, setGitUrl] = useState('')
  const [gitProvider, setGitProvider] = useState('')
  const [gitUsername, setGitUsername] = useState('')
  const [gitToken, setGitToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message?: string; error?: string } | null>(null)
  const [buildingDocs, setBuildingDocs] = useState(false)
  const [docsResult, setDocsResult] = useState<{ success: boolean; message?: string; error?: string } | null>(null)

  const handleTestConnection = useCallback(async () => {
    if (!projectId) return
    setTesting(true)
    setTestResult(null)
    try {
      const result = await testGitConnection(projectId)
      setTestResult(result)
    } catch (err) {
      setTestResult({ success: false, error: String(err) })
    } finally {
      setTesting(false)
    }
  }, [projectId])

  const handleBuildDocsKnowledge = useCallback(async () => {
    if (!projectId) return
    setBuildingDocs(true)
    setDocsResult(null)
    try {
      const result = await buildDocsKnowledge(projectId)
      if (result.success) {
        setDocsResult({ success: true, message: `${result.docsProcessed}/${result.docsFound} docs → ${result.chunksCreated} knowledge chunks` })
      } else {
        setDocsResult({ success: false, error: result.error ?? 'Unknown error' })
      }
    } catch (err) {
      setDocsResult({ success: false, error: String(err) })
    } finally {
      setBuildingDocs(false)
    }
  }, [projectId])

  const handleSaveGit = useCallback(async () => {
    if (!projectId) return
    setSaving(true)
    try {
      await updateProject(projectId, { gitRepoUrl: gitUrl, gitProvider, gitUsername, gitToken })
      mutate()
      setShowEditGit(false)
    } catch {
      // error handled
    } finally {
      setSaving(false)
    }
  }, [projectId, gitUrl, gitProvider, gitUsername, gitToken, mutate])

  if (!projectId) {
    return (
      <div className={styles.errorBanner}>
        <AlertTriangle {...ICON_INLINE} /> No project ID specified. Navigate from the Organizations page.
      </div>
    )
  }

  if (isLoading) {
    return <div className={styles.loading}>Loading project details...</div>
  }

  if (error || !project) {
    return (
      <div className={styles.errorBanner}>
        <AlertTriangle {...ICON_INLINE} /> Failed to load project. Make sure the backend is running.
      </div>
    )
  }

  const stats = project.stats ?? { apiKeys: 0, queryLogs: 0, sessions: 0 }

  return (
    <>
      {/* Stats */}
      <div className={styles.statsGrid}>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}>⚿</span>
          <div>
            <div className={styles.statValue}>{stats.apiKeys}</div>
            <div className={styles.statLabel}>API Keys</div>
          </div>
        </div>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}><ClipboardList {...ICON_INLINE} /></span>
          <div>
            <div className={styles.statValue}>{stats.queryLogs}</div>
            <div className={styles.statLabel}>Queries</div>
          </div>
        </div>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}>⇄</span>
          <div>
            <div className={styles.statValue}>{stats.sessions}</div>
            <div className={styles.statLabel}>Sessions</div>
          </div>
        </div>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}><Puzzle {...ICON_INLINE} /></span>
          <div>
            <div className={styles.statValue}>{project.indexed_symbols}</div>
            <div className={styles.statLabel}>Indexed Symbols</div>
          </div>
        </div>
      </div>

      {/* Info Grid */}
      <div className={styles.infoGrid}>
        {/* Git Integration */}
        <div className={`card ${styles.infoCard}`}>
          <div className={styles.infoHeader}>
            <h3 className={styles.infoTitle}>Git Integration</h3>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => {
                setGitUrl(project.git_repo_url ?? '')
                setGitProvider(project.git_provider ?? '')
                setGitUsername(project.git_username ?? '')
                setGitToken(project.git_token ?? '')
                setShowEditGit(true)
              }}
            >
              {project.git_repo_url ? 'Edit' : '+ Connect'}
            </button>
          </div>
          {project.git_repo_url ? (
            <div className={styles.gitInfo}>
              <div className={styles.gitRow}>
                <span className={styles.gitLabel}>Provider</span>
                <span className={styles.gitValue}>
                  {(() => { const found = GIT_PROVIDERS.find((p) => p.value === project.git_provider); return found ? <Ico icon={found.icon} /> : <Link {...ICON_INLINE} /> })()}{' '}
                  {GIT_PROVIDERS.find((p) => p.value === project.git_provider)?.label ?? project.git_provider}
                </span>
              </div>
              <div className={styles.gitRow}>
                <span className={styles.gitLabel}>Repository</span>
                <a
                  href={project.git_repo_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.gitLink}
                >
                  {project.git_repo_url}
                </a>
              </div>
              {project.indexed_at && (
                <div className={styles.gitRow}>
                  <span className={styles.gitLabel}>Last Indexed</span>
                  <span className={styles.gitValue}>
                    {parseDateSafe(project.indexed_at).toLocaleString()}
                  </span>
                </div>
              )}
              <div className={styles.gitActions}>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={handleTestConnection}
                  disabled={testing}
                >
                  {testing ? <><Clock {...ICON_INLINE} /> Testing...</> : <><Plug {...ICON_INLINE} /> Test Connection</>}
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={handleBuildDocsKnowledge}
                  disabled={buildingDocs}
                  title="Scan repo docs and build knowledge items"
                >
                  {buildingDocs ? <><Clock {...ICON_INLINE} /> Building...</> : <><BookMarked {...ICON_INLINE} /> Build Knowledge</>}
                </button>
              </div>
              {testResult && (
                <div className={styles.testResult} data-success={testResult.success}>
                  {testResult.success ? <CheckCircle {...ICON_INLINE} /> : <XCircle {...ICON_INLINE} />} {testResult.message ?? testResult.error}
                </div>
              )}
              {docsResult && (
                <div className={styles.testResult} data-success={docsResult.success}>
                  {docsResult.success ? <CheckCircle {...ICON_INLINE} /> : <XCircle {...ICON_INLINE} />} {docsResult.message ?? docsResult.error}
                </div>
              )}
            </div>
          ) : (
            <div className={styles.emptyGit}>
              <span className={styles.emptyGitIcon}><Link {...ICON_INLINE} /></span>
              <p>No git repository connected.</p>
              <p className={styles.emptyGitHint}>
                Connect a repository to enable code indexing and symbol tracking.
              </p>
            </div>
          )}
        </div>

        {/* Project Details */}
        <div className={`card ${styles.infoCard}`}>
          <h3 className={styles.infoTitle}>Project Details</h3>
          <div className={styles.detailList}>
            <div className={styles.detailRow}>
              <span className={styles.detailLabel}>ID</span>
              <code className={styles.detailCode}>{project.id}</code>
            </div>
            <div className={styles.detailRow}>
              <span className={styles.detailLabel}>Organization</span>
              <span className={styles.detailValue}>{project.org_name ?? '—'}</span>
            </div>
            <div className={styles.detailRow}>
              <span className={styles.detailLabel}>Slug</span>
              <code className={styles.detailCode}>{project.slug}</code>
            </div>
            <div className={styles.detailRow}>
              <span className={styles.detailLabel}>Created</span>
              <span className={styles.detailValue}>
                {parseDateSafe(project.created_at).toLocaleString()}
              </span>
            </div>
            <div className={styles.detailRow}>
              <span className={styles.detailLabel}>Updated</span>
              <span className={styles.detailValue}>
                {parseDateSafe(project.updated_at).toLocaleString()}
              </span>
            </div>
            <div className={styles.detailRow}>
              <span className={styles.detailLabel}>Cortex Hub</span>
              <span className={styles.detailValue} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span className={project.enabled !== 0 ? styles.statusEnabled : styles.statusDisabled}>
                  {project.enabled !== 0 ? 'Active' : 'Inactive'}
                </span>
                <button
                  className={`${styles.toggleBtn} ${project.enabled !== 0 ? styles.toggleBtnActive : ''}`}
                  disabled={saving}
                  onClick={async () => {
                    setSaving(true)
                    try {
                      await updateProject(project.id, { enabled: project.enabled === 0 ? 1 : 0 })
                      mutate()
                    } catch {
                      alert('Failed to toggle project status')
                    } finally {
                      setSaving(false)
                    }
                  }}
                  title={project.enabled !== 0 ? 'Deactivate Cortex Hub for this project' : 'Activate Cortex Hub for this project'}
                >
                  {project.enabled !== 0 ? 'Deactivate' : 'Activate'}
                </button>
              </span>
            </div>
          </div>
          {project.description && (
            <div className={styles.description}>
              <h4 className={styles.descLabel}>Description</h4>
              <p className={styles.descText}>{project.description}</p>
            </div>
          )}
        </div>
      </div>

      {/* Indexing Panel */}
      <IndexingPanel projectId={projectId} hasGitUrl={!!project.git_repo_url} />

      {/* Project Memory State */}
      <ProjectStatePanel projectId={projectId} />

      {/* Recent Activity */}
      <div className={`card ${styles.activityCard}`}>
        <h3 className={styles.infoTitle}>Recent Activity</h3>
        {(project as Record<string, unknown>).activity && ((project as Record<string, unknown>).activity as Array<Record<string, unknown>>).length > 0 ? (
          <div className={styles.activityList}>
            {((project as Record<string, unknown>).activity as Array<Record<string, unknown>>).map((item, i) => {
              const isQuery = item.type === 'query'
              return (
                <div key={i} className={styles.activityRow}>
                  <span className={styles.activityIcon}>{isQuery ? <Search {...ICON_INLINE} /> : <Bot {...ICON_INLINE} />}</span>
                  <div className={styles.activityInfo}>
                    <span className={styles.activityDetail}>
                      {isQuery ? (item.detail as string) || 'query' : (item.detail as string) || 'session'}
                    </span>
                    <span className={styles.activityAgent}>
                      {(item.agent_id as string) || 'unknown'}
                      {isQuery && item.latency_ms ? ` · ${item.latency_ms}ms` : ''}
                    </span>
                  </div>
                  <span className={styles.activityTime}>
                    {item.created_at ? parseDateSafe(item.created_at as string).toLocaleString() : ''}
                  </span>
                </div>
              )
            })}
          </div>
        ) : (
          <div className={styles.emptyActivity}>
            <span className={styles.emptyActivityIcon}><BarChart3 {...ICON_INLINE} /></span>
            <p>Activity data will appear here once agents start working in this project scope.</p>
            <p className={styles.emptyActivityHint}>
              Assign this project ID in your MCP config: <code>{project.id}</code>
            </p>
          </div>
        )}
      </div>

      {/* Edit Git Dialog */}
      {showEditGit && (
        <div className={styles.dialogOverlay} onClick={() => setShowEditGit(false)}>
          <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.dialogTitle}>Connect Git Repository</h3>
            <div className={styles.dialogField}>
              <label className={styles.dialogLabel}>Provider</label>
              <div className={styles.providerGrid}>
                {GIT_PROVIDERS.map((p) => (
                  <button
                    key={p.value}
                    className={`${styles.providerBtn} ${gitProvider === p.value ? styles.providerActive : ''}`}
                    onClick={() => setGitProvider(p.value)}
                  >
                    <span><Ico icon={p.icon} /></span>
                    <span>{p.label}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className={styles.dialogField}>
              <label className={styles.dialogLabel}>Repository URL</label>
              <input
                className={styles.dialogInput}
                type="text"
                placeholder="https://github.com/user/repo"
                value={gitUrl}
                onChange={(e) => setGitUrl(e.target.value)}
              />
            </div>
            <div className={styles.dialogField}>
              <label className={styles.dialogLabel}>Git Username (Optional)</label>
              <input
                className={styles.dialogInput}
                type="text"
                placeholder="username"
                value={gitUsername}
                onChange={(e) => setGitUsername(e.target.value)}
              />
            </div>
            <div className={styles.dialogField}>
              <label className={styles.dialogLabel}>Git Token / PAT (Optional)</label>
              <input
                className={styles.dialogInput}
                type="password"
                placeholder="ghp_xxxx or Personal Access Token"
                value={gitToken}
                onChange={(e) => setGitToken(e.target.value)}
              />
            </div>
            <div className={styles.dialogActions}>
              <button className="btn btn-secondary" onClick={() => setShowEditGit(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={handleSaveGit} disabled={saving}>
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export default function ProjectDetailPage() {
  return (
    <DashboardLayout title="Project" subtitle="Project details and analytics">
      <Suspense fallback={<div className={styles.loading}>Loading...</div>}>
        <ProjectContent />
      </Suspense>
    </DashboardLayout>
  )
}
