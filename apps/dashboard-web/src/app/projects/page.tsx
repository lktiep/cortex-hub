'use client'

import { useState, useCallback, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import DashboardLayout from '@/components/layout/DashboardLayout'
import useSWR from 'swr'
import { getProject, updateProject } from '@/lib/api'
import styles from './page.module.css'

const GIT_PROVIDERS = [
  { value: 'github', label: 'GitHub', icon: '🐙' },
  { value: 'gitlab', label: 'GitLab', icon: '🦊' },
  { value: 'bitbucket', label: 'Bitbucket', icon: '🪣' },
  { value: 'local', label: 'Local', icon: '💻' },
]

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
  const [saving, setSaving] = useState(false)

  const handleSaveGit = useCallback(async () => {
    if (!projectId) return
    setSaving(true)
    try {
      await updateProject(projectId, { gitRepoUrl: gitUrl, gitProvider })
      mutate()
      setShowEditGit(false)
    } catch {
      // error handled
    } finally {
      setSaving(false)
    }
  }, [projectId, gitUrl, gitProvider, mutate])

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

      {/* Activity placeholder */}
      <div className={`card ${styles.activityCard}`}>
        <h3 className={styles.infoTitle}>Recent Activity</h3>
        <div className={styles.emptyActivity}>
          <span className={styles.emptyActivityIcon}>📊</span>
          <p>Activity data will appear here once agents start working in this project scope.</p>
          <p className={styles.emptyActivityHint}>
            Assign this project ID in your MCP config: <code>{project.id}</code>
          </p>
        </div>
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
