'use client'

import { useState, useCallback, useEffect } from 'react'
import Link from 'next/link'
import DashboardLayout from '@/components/layout/DashboardLayout'
import useSWR, { useSWRConfig } from 'swr'
import {
  getOrganizations,
  createOrganization,
  deleteOrganization,
  getProjectsForOrg,
  createProject,
  deleteProject,
  moveProject,
  getDashboardOverview,
  type Organization,
  type Project,
  type ProjectSummary,
} from '@/lib/api'
import { Cloud, Link as LinkIcon, Package, Search, Brain, BarChart3, AlertTriangle, Building2, Folder, ArrowLeftRight, type LucideIcon, ICON_INLINE } from '@/lib/icons'
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
  moveTargets,
  isDragging,
  onDragStart,
  onDragEnd,
  onMove,
}: {
  project: Project
  enriched?: ProjectSummary
  onDelete: () => void
  /** Every organization this project could move to; empty when there is only one. */
  moveTargets: Organization[]
  isDragging: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onMove: (target: Organization) => void
}) {
  const [showConfirm, setShowConfirm] = useState(false)

  const gnStatus = enriched ? statusBadge(enriched.gitnexus.status) : null
  const m9Status = enriched ? statusBadge(enriched.mem9.status) : null
  const ProviderIcon = getProviderIcon(project.git_provider)

  return (
    <div
      className={`card ${styles.projectCard} ${isDragging ? styles.dragging : ''}`}
      draggable={moveTargets.length > 0}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        // Firefox starts no drag without data; the project itself travels through page state.
        e.dataTransfer.setData('text/plain', project.id)
        onDragStart()
      }}
      onDragEnd={onDragEnd}
    >
      <div className={styles.projectHeader}>
        <div className={styles.projectHeaderLeft}>
          <span className={styles.providerIcon}><Ico icon={ProviderIcon} /></span>
          <div>
            <h4 className={styles.projectName}>
              <Link href={`/projects?id=${project.id}`} className={styles.projectLink} draggable={false}>
                {project.name}
              </Link>
            </h4>
            <code className={styles.projectSlug}>{project.slug}</code>
          </div>
        </div>
        <div className={styles.projectHeaderActions}>
          {moveTargets.length > 0 && (
            <label className={styles.moveSelect} title="Move to another organization">
              <ArrowLeftRight {...ICON_INLINE} />
              <select
                aria-label={`Move ${project.name} to another organization`}
                value=""
                onChange={(e) => {
                  const target = moveTargets.find((o) => o.id === e.target.value)
                  if (target) onMove(target)
                }}
              >
                <option value="" disabled>Move to…</option>
                {moveTargets.map((o) => (
                  <option key={o.id} value={o.id}>{o.name}</option>
                ))}
              </select>
            </label>
          )}
          <button
            className={styles.deleteBtn}
            onClick={() => setShowConfirm(true)}
            title="Delete project"
          >
            ×
          </button>
        </div>
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

type PendingMove = { project: Project; from: Organization; to: Organization }

function MoveDialog({ move, onDone, onCancel }: { move: PendingMove; onDone: () => void; onCancel: () => void }) {
  const { project, from, to } = move
  const [moving, setMoving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleMove() {
    setMoving(true)
    setError(null)
    try {
      await moveProject(project.id, to.id)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Move failed')
      setMoving(false)
    }
  }

  return (
    <div className={styles.dialogOverlay} onClick={moving ? undefined : onCancel}>
      <div
        className={styles.dialog}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="move-project-title"
      >
        <h3 id="move-project-title" className={styles.dialogTitle}>Move project</h3>
        <p className={styles.dialogMessage}>
          Move <strong>{project.name}</strong> from <strong>{from.name}</strong> to <strong>{to.name}</strong>?
        </p>
        <ul className={styles.moveEffects}>
          <li>Searches across repos in <strong>{to.name}</strong> will include it, and <strong>{from.name}</strong> stops seeing it.</li>
          <li>Sessions already open on this project search <strong>{to.name}</strong> from their next call.</li>
          <li>Its index, knowledge, memory and git settings stay attached to it.</li>
        </ul>
        {error && (
          <div className={styles.dialogError}>
            <AlertTriangle {...ICON_INLINE} /> {error}
          </div>
        )}
        <div className={styles.dialogActions}>
          <button className="btn btn-secondary" onClick={onCancel} disabled={moving}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={handleMove} disabled={moving} autoFocus>
            {moving ? 'Moving…' : `Move to ${to.name}`}
          </button>
        </div>
      </div>
    </div>
  )
}

function OrgSection({
  org,
  allOrgs,
  enrichedMap,
  onDeleted,
  dragging,
  onDragStartProject,
  onDragEnd,
  onRequestMove,
}: {
  org: Organization
  allOrgs: Organization[]
  enrichedMap: Map<string, ProjectSummary>
  onDeleted: () => void
  dragging: Project | null
  onDragStartProject: (project: Project) => void
  onDragEnd: () => void
  onRequestMove: (project: Project, target: Organization) => void
}) {
  const { data: projectData, mutate: mutateProjects } = useSWR(
    `projects-${org.id}`,
    () => getProjectsForOrg(org.id),
    { refreshInterval: 30000 }
  )
  const [showCreateProject, setShowCreateProject] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [isOver, setIsOver] = useState(false)

  const projects = projectData?.projects ?? []
  const moveTargets = allOrgs.filter((o) => o.id !== org.id)
  const canDrop = dragging !== null && dragging.org_id !== org.id

  // A drag cancelled with Escape over this section never fires dragleave here.
  useEffect(() => {
    if (!canDrop) setIsOver(false)
  }, [canDrop])

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
    <div
      className={[styles.orgSection, canDrop && styles.dropReady, canDrop && isOver && styles.dropOver]
        .filter(Boolean)
        .join(' ')}
      onDragOver={(e) => {
        if (!canDrop) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (!isOver) setIsOver(true)
      }}
      onDragLeave={(e) => {
        // Crossing into a child card fires dragleave on the section too; only a real exit counts.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setIsOver(false)
      }}
      onDrop={(e) => {
        if (!canDrop || !dragging) return
        e.preventDefault()
        setIsOver(false)
        onRequestMove(dragging, org)
      }}
    >
      {canDrop && dragging && (
        <div className={styles.dropHint} aria-hidden="true">
          <ArrowLeftRight {...ICON_INLINE} /> Drop to move <strong>{dragging.name}</strong> into {org.name}
        </div>
      )}
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
              moveTargets={moveTargets}
              isDragging={dragging?.id === p.id}
              onDragStart={() => onDragStartProject(p)}
              onDragEnd={onDragEnd}
              onMove={(target) => onRequestMove(p, target)}
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
  const { mutate: revalidate } = useSWRConfig()
  const [dragging, setDragging] = useState<Project | null>(null)
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null)

  const orgs = data?.organizations ?? []

  const requestMove = useCallback(
    (project: Project, to: Organization) => {
      setDragging(null)
      const from = orgs.find((o) => o.id === project.org_id)
      if (from && from.id !== to.id) setPendingMove({ project, from, to })
    },
    [orgs]
  )

  const finishMove = useCallback(() => {
    if (pendingMove) {
      void revalidate(`projects-${pendingMove.from.id}`)
      void revalidate(`projects-${pendingMove.to.id}`)
    }
    setPendingMove(null)
    void mutate()
  }, [pendingMove, revalidate, mutate])

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
        <div>
          <h2 className={styles.sectionTitle}>All Organizations</h2>
          {orgs.length > 1 && (
            <p className={styles.moveHint}>
              Drag a project onto another organization to move it, or use <ArrowLeftRight {...ICON_INLINE} /> on its card.
            </p>
          )}
        </div>
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
          <OrgSection
            key={org.id}
            org={org}
            allOrgs={orgs}
            enrichedMap={enrichedMap}
            onDeleted={() => mutate()}
            dragging={dragging}
            onDragStartProject={setDragging}
            onDragEnd={() => setDragging(null)}
            onRequestMove={requestMove}
          />
        ))
      )}

      {pendingMove && (
        <MoveDialog move={pendingMove} onDone={finishMove} onCancel={() => setPendingMove(null)} />
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
