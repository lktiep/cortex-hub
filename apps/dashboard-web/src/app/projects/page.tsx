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
} from '@/lib/api'
import styles from './page.module.css'

const GIT_PROVIDERS = [
  { value: 'github', label: 'GitHub', icon: '🐙' },
  { value: 'gitlab', label: 'GitLab', icon: '🦊' },
  { value: 'bitbucket', label: 'Bitbucket', icon: '🪣' },
  { value: 'azure', label: 'Azure', icon: '☁️' },
  { value: 'local', label: 'Local', icon: '💻' },
]

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: string }> = {
  pending:   { label: 'Pending',   color: '#888', icon: '⏳' },
  cloning:   { label: 'Cloning',   color: '#f5a623', icon: '📥' },
  analyzing: { label: 'Analyzing', color: '#4a90d9', icon: '🔍' },
  ingesting: { label: 'Ingesting', color: '#9b59b6', icon: '🧠' },
  done:      { label: 'Done',      color: '#27ae60', icon: '✅' },
  error:     { label: 'Error',     color: '#e74c3c', icon: '❌' },
  none:      { label: 'Not indexed', color: '#666', icon: '—' },
}

function formatRelativeTime(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diff = now - then
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })
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

  const statusInfo = STATUS_CONFIG[status?.status ?? 'none'] ?? { label: 'Unknown', color: '#666', icon: '—' }
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
          🚀 Code Indexing
        </h3>
        <span className={styles.statusBadge} style={{ background: statusInfo.color }}>
          {statusInfo.icon} {statusInfo.label}
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
            {status.branch && <span>📌 Branch: <strong>{status.branch}</strong></span>}
            {(status.symbolsFound ?? 0) > 0 && <span>🧩 {status.symbolsFound} symbols</span>}
            {(status.totalFiles ?? 0) > 0 && <span>📄 {status.totalFiles} files</span>}
          </div>
          {status.error && (
            <div className={styles.indexingError}>
              ⚠️ {status.error}
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
              {branchesLoading ? '⏳' : '🔄'}
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
              {starting ? 'Starting...' : '🚀 Start Indexing'}
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
              const bStatus = STATUS_CONFIG[b.status] ?? { label: b.status, color: '#666', icon: '?' }
              const mem9Status = b.mem9_status ?? 'pending'
              const mem9Done = mem9Status === 'done' && (b.mem9_chunks ?? 0) > 0
              const mem9Running = mem9Status === 'embedding'
              const mem9Pending = !mem9Done && !mem9Running && mem9Status !== 'error'
              const gnDone = b.status === 'done'
              return (
                <div key={b.branch} className={styles.branchStatusCard}>
                  <div className={styles.branchStatusName}>
                    <span className={styles.branchDot} style={{ background: bStatus.color }} />
                    {b.branch}
                  </div>
                  {/* GitNexus row */}
                  <div className={styles.branchStatusMeta}>
                    <span>{bStatus.icon} {bStatus.label}</span>
                    <span>{b.symbols_found} symbols</span>
                    <span>{b.total_files} files</span>
                  </div>
                  {/* mem9 row */}
                  <div className={styles.branchMem9Row}>
                    <span className={styles.branchMem9Label}>🧠 mem9:</span>
                    {mem9Done && (
                      <span className={styles.branchMem9Badge} data-status="done">
                        ✅ {b.mem9_chunks} chunks
                      </span>
                    )}
                    {mem9Running && (
                      <span className={styles.branchMem9Badge} data-status="embedding">
                        ⏳ Embedding...
                      </span>
                    )}
                    {mem9Status === 'error' && (
                      <span className={styles.branchMem9Badge} data-status="error">
                        ❌ Error
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
                        {embeddingBranch === b.branch ? '⏳' : mem9Status === 'error' ? '🔄' : '▶'}
                      </button>
                    )}
                    {gnDone && mem9Done && (
                      <button
                        className={styles.branchMem9Btn}
                        onClick={() => handleRunMem9(b.branch)}
                        disabled={embeddingBranch === b.branch}
                        title="Re-run mem9 embedding"
                      >
                        🔄
                      </button>
                    )}
                  </div>
                  {/* Knowledge docs row */}
                  <div className={styles.branchMem9Row}>
                    <span className={styles.branchMem9Label}>📚 knowledge:</span>
                    {(b.docs_knowledge_count ?? 0) > 0 ? (
                      <span className={styles.branchMem9Badge} data-status="done">
                        ✅ {b.docs_knowledge_count} items
                      </span>
                    ) : b.docs_knowledge_status === 'processing' ? (
                      <span className={styles.branchMem9Badge} data-status="embedding">
                        ⏳ Building...
                      </span>
                    ) : b.docs_knowledge_status === 'error' ? (
                      <span className={styles.branchMem9Badge} data-status="error">
                        ❌ Error
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
              const jobStatus = STATUS_CONFIG[job.status] ?? { label: 'Unknown', color: '#666', icon: '—' }
              const ts = job.completed_at ?? job.started_at ?? job.created_at
              const triggerIcon = job.triggered_by === 'push' ? '🔄' : job.triggered_by === 'reindex' ? '🔁' : job.triggered_by === 'schedule' ? '⏰' : '▶️'
              return (
                <div key={job.id} className={styles.historyRow}>
                  <span className={styles.historyBranch}>{job.branch}</span>
                  <span className={styles.historyStatus} style={{ color: jobStatus.color }}>
                    {jobStatus.icon} {jobStatus.label}
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
                  <span className={styles.historyDate} title={new Date(ts).toLocaleString()}>
                    <span className={styles.triggerIcon}>{triggerIcon}</span>
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
        setDocsResult({ success: true, message: `📚 ${result.docsProcessed}/${result.docsFound} docs → ${result.chunksCreated} knowledge chunks` })
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
        ⚠️ No project ID specified. Navigate from the Organizations page.
      </div>
    )
  }

  if (isLoading) {
    return <div className={styles.loading}>Loading project details...</div>
  }

  if (error || !project) {
    return (
      <div className={styles.errorBanner}>
        ⚠️ Failed to load project. Make sure the backend is running.
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
          <span className={styles.statIcon}>📋</span>
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
          <span className={styles.statIcon}>🧩</span>
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
                  {GIT_PROVIDERS.find((p) => p.value === project.git_provider)?.icon ?? '🔗'}{' '}
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
                    {new Date(project.indexed_at).toLocaleString()}
                  </span>
                </div>
              )}
              <div className={styles.gitActions}>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={handleTestConnection}
                  disabled={testing}
                >
                  {testing ? '⏳ Testing...' : '🔌 Test Connection'}
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={handleBuildDocsKnowledge}
                  disabled={buildingDocs}
                  title="Scan repo docs and build knowledge items"
                >
                  {buildingDocs ? '⏳ Building...' : '📚 Build Knowledge'}
                </button>
              </div>
              {testResult && (
                <div className={styles.testResult} data-success={testResult.success}>
                  {testResult.success ? '✅' : '❌'} {testResult.message ?? testResult.error}
                </div>
              )}
              {docsResult && (
                <div className={styles.testResult} data-success={docsResult.success}>
                  {docsResult.success ? '✅' : '❌'} {docsResult.message ?? docsResult.error}
                </div>
              )}
            </div>
          ) : (
            <div className={styles.emptyGit}>
              <span className={styles.emptyGitIcon}>🔗</span>
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
                {new Date(project.created_at).toLocaleString()}
              </span>
            </div>
            <div className={styles.detailRow}>
              <span className={styles.detailLabel}>Updated</span>
              <span className={styles.detailValue}>
                {new Date(project.updated_at).toLocaleString()}
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


      {/* Recent Activity */}
      <div className={`card ${styles.activityCard}`}>
        <h3 className={styles.infoTitle}>Recent Activity</h3>
        {(project as Record<string, unknown>).activity && ((project as Record<string, unknown>).activity as Array<Record<string, unknown>>).length > 0 ? (
          <div className={styles.activityList}>
            {((project as Record<string, unknown>).activity as Array<Record<string, unknown>>).map((item, i) => {
              const isQuery = item.type === 'query'
              return (
                <div key={i} className={styles.activityRow}>
                  <span className={styles.activityIcon}>{isQuery ? '🔍' : '🤖'}</span>
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
                    {item.created_at ? new Date(item.created_at as string).toLocaleString() : ''}
                  </span>
                </div>
              )
            })}
          </div>
        ) : (
          <div className={styles.emptyActivity}>
            <span className={styles.emptyActivityIcon}>📊</span>
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
                    <span>{p.icon}</span>
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
