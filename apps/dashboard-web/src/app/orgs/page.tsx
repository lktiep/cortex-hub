'use client'

import { useState, useCallback } from 'react'
import Link from 'next/link'
import DashboardLayout from '@/components/layout/DashboardLayout'
import useSWR from 'swr'
import {
  getOrganizations,
  createOrganization,
  deleteOrganization,
  getProjectsForOrg,
  createProject,
  deleteProject,
  getDashboardOverview,
  type Organization,
  type Project,
  type ProjectSummary,
} from '@/lib/api'
import { Cloud, Link as LinkIcon, Package, Search, Brain, BarChart3, AlertTriangle, Building2, Folder, type LucideIcon, ICON_INLINE } from '@/lib/icons'
import { parseDateSafe, formatTimeAgo } from '@/lib/date'
import styles from './page.module.css'

// ── Helpers ──

function Ico({ icon: Icon }: { icon: LucideIcon }) { return <Icon {...ICON_INLINE} /> }

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toString()
}

function timeAgo(dateStr: string): string {
  return formatTimeAgo(dateStr)
}

function getProviderIcon(provider: string | null): LucideIcon {
  switch (provider) {
    case 'azure': return Cloud
    case 'local': return LinkIcon
    default: return Package
  }
}

function statusBadge(status: string): { label: string; className: string } {
  switch (status) {
    case 'done': return { label: 'Done', className: 'healthy' }
    case 'indexing':
    case 'embedding': return { label: 'Processing', className: 'warning' }
    case 'error': return { label: 'Error', className: 'error' }
    case 'pending': return { label: 'Pending', className: 'muted' }
    default: return { label: '—', className: 'muted' }
  }
}

// ── Components ──
function CreateDialog({
  title,
  fields,
  onSubmit,
  onCancel,
  onFieldChange,
}: {
  title: string
  fields: { key: string; label: string; placeholder: string; required?: boolean; type?: string }[]
  onSubmit: (data: Record<string, string>) => void
  onCancel: () => void
  onFieldChange?: (key: string, value: string, setValues: React.Dispatch<React.SetStateAction<Record<string, string>>>) => void
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)

  const canSubmit = fields
    .filter((f) => f.required !== false)
    .every((f) => (values[f.key] ?? '').trim().length > 0)

  async function handleSubmit() {
    setSubmitting(true)
    onSubmit(values)
  }

  return (
    <div className={styles.dialogOverlay} onClick={onCancel}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.dialogTitle}>{title}</h3>
        {fields.map((field) => (
          <div key={field.key} className={styles.dialogField}>
            <label className={styles.dialogLabel}>{field.label}</label>
            {field.type === 'textarea' ? (
              <textarea
                className={styles.dialogInput}
                placeholder={field.placeholder}
                value={values[field.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                rows={3}
              />
            ) : (
              <input
                className={styles.dialogInput}
                type={field.type || "text"}
                placeholder={field.placeholder}
                value={values[field.key] ?? ''}
                onChange={(e) => {
                  const newVal = e.target.value
                  setValues((v) => ({ ...v, [field.key]: newVal }))
                  onFieldChange?.(field.key, newVal, setValues)
                }}
              />
            )}
          </div>
        ))}
        <div className={styles.dialogActions}>
          <button className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={handleSubmit}
            disabled={!canSubmit || submitting}
          >
            {submitting ? 'Creating...' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ProjectCard({
  project,
  enriched,
  onDelete,
}: {
  project: Project
  enriched?: ProjectSummary
  onDelete: () => void
}) {
  const [showConfirm, setShowConfirm] = useState(false)

  const gnStatus = enriched ? statusBadge(enriched.gitnexus.status) : null
  const m9Status = enriched ? statusBadge(enriched.mem9.status) : null
  const ProviderIcon = getProviderIcon(project.git_provider)

  return (
    <div className={`card ${styles.projectCard}`}>
      <div className={styles.projectHeader}>
        <div className={styles.projectHeaderLeft}>
          <span className={styles.providerIcon}><Ico icon={ProviderIcon} /></span>
          <div>
            <h4 className={styles.projectName}>
              <Link href={`/projects?id=${project.id}`} className={styles.projectLink}>
                {project.name}
              </Link>
            </h4>
            <code className={styles.projectSlug}>{project.slug}</code>
          </div>
        </div>
        <button
          className={styles.deleteBtn}
          onClick={() => setShowConfirm(true)}
          title="Delete project"
        >
          ×
        </button>
      </div>

      {/* GitNexus + Mem9 + Knowledge Status */}
      {enriched ? (
        <div className={styles.indexStatusGrid}>
          <div className={styles.indexStatusRow}>
            <span className={styles.indexStatusLabel}><Search {...ICON_INLINE} /> GitNexus</span>
            <span className={`badge badge-${gnStatus!.className}`}>{gnStatus!.label}</span>
            {enriched.gitnexus.status === 'done' && (
              <span className={styles.indexStatusDetail}>
                {formatNumber(enriched.gitnexus.symbols)} symbols · {formatNumber(enriched.gitnexus.files)} files
              </span>
            )}
          </div>
          <div className={styles.indexStatusRow}>
            <span className={styles.indexStatusLabel}><Brain {...ICON_INLINE} /> Mem9</span>
            <span className={`badge badge-${m9Status!.className}`}>{m9Status!.label}</span>
            {(enriched.mem9.status === 'done' || enriched.mem9.chunks > 0) && (
              <span className={styles.indexStatusDetail}>
                {formatNumber(enriched.mem9.chunks)} chunks
              </span>
            )}
          </div>
          <div className={styles.indexStatusRow}>
            <span className={styles.indexStatusLabel}>Knowledge</span>
            {enriched.knowledge.docs > 0 ? (
              <>
                <span className="badge badge-healthy">{enriched.knowledge.docs} docs</span>
                <span className={styles.indexStatusDetail}>
                  {formatNumber(enriched.knowledge.chunks)} chunks
                </span>
              </>
            ) : (
              <span className="badge badge-muted">— None</span>
            )}
          </div>
        </div>
      ) : (
        <div className={styles.projectMeta}>
          {project.git_repo_url ? (
            <span className={styles.projectGit}>
              <LinkIcon {...ICON_INLINE} /> {project.git_provider ?? 'git'}: {project.git_repo_url}
            </span>
          ) : (
            <span className={styles.projectNoGit}>No git repo linked</span>
          )}
          {project.indexed_at && (
            <span className={styles.projectIndexed}>
              <BarChart3 {...ICON_INLINE} /> {project.indexed_symbols} symbols indexed
            </span>
          )}
        </div>
      )}

      {/* Footer */}
      <div className={styles.projectFooter}>
        {enriched?.gitnexus.branch && (
          <span className={styles.branchTag}>⎇ {enriched.gitnexus.branch}</span>
        )}
        {enriched ? (
          <span className={styles.projectMeta2}>
            {enriched.weeklyQueries > 0 ? `${enriched.weeklyQueries} queries` : 'No queries'}
          </span>
        ) : null}
        {enriched?.gitnexus.completedAt ? (
          <span className={styles.projectDate}>Indexed {timeAgo(enriched.gitnexus.completedAt)}</span>
        ) : (
          <span className={styles.projectDate}>Created {parseDateSafe(project.created_at).toLocaleDateString()}</span>
        )}
      </div>

      {showConfirm && (
        <div className={styles.inlineConfirm}>
          <span>Delete this project?</span>
          <button className="btn btn-secondary btn-sm" onClick={() => setShowConfirm(false)}>
            No
          </button>
          <button
            className="btn btn-primary btn-sm"
            style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }}
            onClick={onDelete}
          >
            Yes
          </button>
        </div>
      )}
    </div>
  )
}

function OrgSection({ org, enrichedMap, onDeleted }: { org: Organization; enrichedMap: Map<string, ProjectSummary>; onDeleted: () => void }) {
  const { data: projectData, mutate: mutateProjects } = useSWR(
    `projects-${org.id}`,
    () => getProjectsForOrg(org.id),
    { refreshInterval: 30000 }
  )
  const [showCreateProject, setShowCreateProject] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  const projects = projectData?.projects ?? []

  const handleCreateProject = useCallback(
    async (data: Record<string, string>) => {
      try {
        await createProject(org.id, {
          name: data.name ?? '',
          description: data.description,
          gitRepoUrl: data.gitRepoUrl,
          gitProvider: data.gitProvider,
          gitUsername: data.gitUsername,
          gitToken: data.gitToken,
        })
        setShowCreateProject(false)
        mutateProjects()
      } catch {
        // handled by API module
      }
    },
    [org.id, mutateProjects]
  )

  const handleDeleteProject = useCallback(
    async (projectId: string) => {
      try {
        await deleteProject(projectId)
        mutateProjects()
      } catch {
        // handled
      }
    },
    [mutateProjects]
  )

  const handleDeleteOrg = useCallback(async () => {
    try {
      await deleteOrganization(org.id)
      onDeleted()
    } catch {
      // handled
    }
  }, [org.id, onDeleted])

  return (
    <div className={styles.orgSection}>
      <div className={styles.orgHeader}>
        <div className={styles.orgInfo}>
          <h2 className={styles.orgName}>
            <span className={styles.orgIcon}><Ico icon={Building2} /></span>
            {org.name}
          </h2>
          <span className={styles.orgSlug}>{org.slug}</span>
          {org.description && (
            <p className={styles.orgDesc}>{org.description}</p>
          )}
        </div>
        <div className={styles.orgActions}>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setShowCreateProject(true)}
          >
            + Project
          </button>
          {org.id !== 'org-default' && (
            <button
              className="btn btn-secondary btn-sm"
              style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
              onClick={() => setShowDeleteConfirm(true)}
            >
              Delete Org
            </button>
          )}
        </div>
      </div>

      {/* Projects Grid */}
      {projects.length === 0 ? (
        <div className={styles.emptyProjects}>
          <p>No projects yet.</p>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setShowCreateProject(true)}
          >
            Create first project
          </button>
        </div>
      ) : (
        <div className={styles.projectsGrid}>
          {projects.map((p) => (
            <ProjectCard
              key={p.id}
              project={p}
              enriched={enrichedMap.get(p.id)}
              onDelete={() => handleDeleteProject(p.id)}
            />
          ))}
        </div>
      )}

      {showCreateProject && (
        <CreateDialog
          title={`New Project in ${org.name}`}
          fields={[
            { key: 'name', label: 'Project Name', placeholder: 'my-app', required: true },
            { key: 'description', label: 'Description', placeholder: 'Project description...', type: 'textarea', required: false },
            { key: 'gitRepoUrl', label: 'Git Repository URL', placeholder: 'https://github.com/user/repo', required: false },
            { key: 'gitProvider', label: 'Git Provider', placeholder: 'auto-detected from URL', required: false },
            { key: 'gitUsername', label: 'Git Username (Optional)', placeholder: 'username', required: false },
            { key: 'gitToken', label: 'Git Token / PAT (Optional)', placeholder: 'Personal Access Token', type: 'password', required: false },
          ]}
          onSubmit={handleCreateProject}
          onCancel={() => setShowCreateProject(false)}
          onFieldChange={(key, value, setValues) => {
            if (key === 'gitRepoUrl') {
              const url = value.toLowerCase()
              let provider = ''
              if (url.includes('github.com') || url.includes('github.')) provider = 'github'
              else if (url.includes('gitlab.com') || url.includes('gitlab.')) provider = 'gitlab'
              else if (url.includes('bitbucket.org') || url.includes('bitbucket.')) provider = 'bitbucket'
              else if (url.includes('dev.azure.com') || url.includes('visualstudio.com') || url.includes('azure.')) provider = 'azure'
              else if (url.includes('gitea.') || url.includes('codeberg.org')) provider = 'gitea'
              if (provider) setValues((v) => ({ ...v, gitProvider: provider }))
            }
          }}
        />
      )}

      {showDeleteConfirm && (
        <div className={styles.dialogOverlay} onClick={() => setShowDeleteConfirm(false)}>
          <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.dialogTitle}>Delete Organization</h3>
            <p className={styles.dialogMessage}>
              Delete <strong>{org.name}</strong>? This organization must have no projects.
            </p>
            <div className={styles.dialogActions}>
              <button className="btn btn-secondary" onClick={() => setShowDeleteConfirm(false)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }}
                onClick={handleDeleteOrg}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function OrganizationsPage() {
  const { data, error, isLoading, mutate } = useSWR('organizations', getOrganizations, {
    refreshInterval: 30000,
  })
  const { data: overview } = useSWR('dashboard-overview', getDashboardOverview, {
    refreshInterval: 15000,
  })
  const [showCreateOrg, setShowCreateOrg] = useState(false)

  const orgs = data?.organizations ?? []

  // Build project enrichment map from overview data
  const enrichedMap = new Map<string, ProjectSummary>()
  if (overview?.projects) {
    for (const p of overview.projects) {
      enrichedMap.set(p.id, p)
    }
  }

  const handleCreateOrg = useCallback(
    async (formData: Record<string, string>) => {
      try {
        await createOrganization({
          name: formData.name ?? '',
          description: formData.description,
        })
        setShowCreateOrg(false)
        mutate()
      } catch {
        // api error handling
      }
    },
    [mutate]
  )

  return (
    <DashboardLayout title="Organizations" subtitle="Manage workspaces and project scopes">
      {/* Stats */}
      <div className={styles.statsGrid}>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}><Ico icon={Building2} /></span>
          <div>
            <div className={styles.statValue}>{orgs.length}</div>
            <div className={styles.statLabel}>Organizations</div>
          </div>
        </div>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}><Folder {...ICON_INLINE} /></span>
          <div>
            <div className={styles.statValue}>
              {orgs.reduce((sum, o) => sum + (o.project_count ?? 0), 0)}
            </div>
            <div className={styles.statLabel}>Total Projects</div>
          </div>
        </div>
      </div>

      {/* Action Bar */}
      <div className={styles.actionBar}>
        <h2 className={styles.sectionTitle}>All Organizations</h2>
        <div className={styles.actionButtons}>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => mutate()}
            disabled={isLoading}
          >
            {isLoading ? 'Loading...' : 'Refresh'}
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => setShowCreateOrg(true)}>
            + New Organization
          </button>
        </div>
      </div>

      {error && (
        <div className={styles.errorBanner}>
          <AlertTriangle {...ICON_INLINE} /> Failed to load organizations. Make sure the backend is running.
        </div>
      )}

      {/* Org Sections */}
      {orgs.length === 0 && !isLoading && !error ? (
        <div className={`card ${styles.emptyState}`}>
          <span className={styles.emptyIcon}><Ico icon={Building2} /></span>
          <p>No organizations yet.</p>
          <p className={styles.emptyHint}>
            Create your first organization to start grouping projects.
          </p>
          <button className="btn btn-primary" onClick={() => setShowCreateOrg(true)}>
            Create Organization
          </button>
        </div>
      ) : (
        orgs.map((org) => (
          <OrgSection key={org.id} org={org} enrichedMap={enrichedMap} onDeleted={() => mutate()} />
        ))
      )}

      {/* Create Org Dialog */}
      {showCreateOrg && (
        <CreateDialog
          title="New Organization"
          fields={[
            { key: 'name', label: 'Name', placeholder: 'My Team', required: true },
            { key: 'description', label: 'Description', placeholder: 'Team workspace...', type: 'textarea', required: false },
          ]}
          onSubmit={handleCreateOrg}
          onCancel={() => setShowCreateOrg(false)}
        />
      )}
    </DashboardLayout>
  )
}
