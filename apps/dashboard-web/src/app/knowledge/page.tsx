'use client'

import { useState, useMemo } from 'react'
import DashboardLayout from '@/components/layout/DashboardLayout'
import useSWR from 'swr'
import {
  getKnowledgeDocuments,
  createKnowledgeDocument,
  deleteKnowledgeDocument,
  getKnowledgeTags,
  getRecipeStats,
  getAllProjects,
  type KnowledgeDocument,
  type Project,
  type RecipeStats,
} from '@/lib/api'
import { parseDateSafe } from '@/lib/date'
import styles from './page.module.css'

// ── Create Dialog ──
function CreateDocumentDialog({
  projects,
  onSubmit,
  onCancel,
}: {
  projects: Project[]
  onSubmit: (data: { title: string; content: string; tags: string[]; projectId?: string }) => void
  onCancel: () => void
}) {
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [tagsInput, setTagsInput] = useState('')
  const [projectId, setProjectId] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const canSubmit = title.trim().length > 0 && content.trim().length > 0

  async function handleSubmit() {
    setSubmitting(true)
    const tags = tagsInput.split(',').map((t) => t.trim()).filter(Boolean)
    onSubmit({
      title: title.trim(),
      content: content.trim(),
      tags,
      projectId: projectId || undefined,
    })
  }

  return (
    <div className={styles.dialogOverlay} onClick={onCancel}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.dialogTitle}>New Knowledge Document</h3>

        <div className={styles.dialogField}>
          <label className={styles.dialogLabel}>Project</label>
          <select
            className={styles.dialogInput}
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">Global (no project)</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        <div className={styles.dialogField}>
          <label className={styles.dialogLabel}>Title</label>
          <input
            className={styles.dialogInput}
            placeholder="e.g. Deployment checklist for Cloudflare"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
        </div>

        <div className={styles.dialogField}>
          <label className={styles.dialogLabel}>Content</label>
          <textarea
            className={styles.dialogTextarea}
            placeholder="Write the knowledge content here..."
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={12}
          />
        </div>

        <div className={styles.dialogField}>
          <label className={styles.dialogLabel}>Tags (comma-separated)</label>
          <input
            className={styles.dialogInput}
            placeholder="e.g. typescript, deployment, patterns"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
          />
        </div>

        <div className={styles.dialogActions}>
          <button className="btn btn-secondary" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={!canSubmit || submitting}>
            {submitting ? 'Creating...' : 'Create Document'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Document Card ──
function DocumentCard({
  doc,
  onDelete,
  showProject,
  projectName,
  index = 0,
}: {
  doc: KnowledgeDocument
  onDelete: (id: string) => void
  showProject?: boolean
  projectName?: string
  index?: number
}) {
  const [confirming, setConfirming] = useState(false)
  let tags: string[] = []
  try { tags = JSON.parse(doc.tags) as string[] } catch { /* ignore */ }

  return (
    <div className={styles.docCard} style={{ '--stagger-index': index } as React.CSSProperties}>
      <div className={styles.docHeader}>
        <h4 className={styles.docTitle}>{doc.title}</h4>
        <div className={styles.docMeta}>
          {showProject && projectName && (
            <span className={styles.docProject}>{projectName}</span>
          )}
          <span className={styles.docSource}>{doc.source}</span>
          {doc.origin && doc.origin !== 'manual' && (
            <span className={`badge ${doc.origin === 'captured' ? 'badge-info' : doc.origin === 'derived' ? 'badge-healthy' : doc.origin === 'fixed' ? 'badge-warning' : ''}`}>
              {doc.origin}
            </span>
          )}
          {doc.category && doc.category !== 'general' && (
            <span className="badge">{doc.category}</span>
          )}
          {doc.source_agent_id && (
            <span className={styles.docAgent}>{doc.source_agent_id}</span>
          )}
        </div>
      </div>

      {doc.content_preview && (
        <p className={styles.docPreview}>{doc.content_preview}</p>
      )}

      <div className={styles.docFooter}>
        <div className={styles.docTags}>
          {tags.map((tag) => (
            <span key={tag} className={styles.tag}>{tag}</span>
          ))}
        </div>

        <div className={styles.docStats}>
          <span title="Chunks">{doc.chunk_count} chunks</span>
          <span title="Search hits">{doc.hit_count} hits</span>
          {(doc.selection_count ?? 0) > 0 && (
            <span title={`Selected: ${doc.selection_count}, Completed: ${doc.completion_count}, Fallback: ${doc.fallback_count}`}>
              {Math.round(((doc.completion_count ?? 0) / (doc.selection_count ?? 1)) * 100)}% effective
            </span>
          )}
          {doc.generation != null && doc.generation > 0 && (
            <span title="Evolution generation">v{doc.generation}</span>
          )}
          <span title="Created">{parseDateSafe(doc.created_at).toLocaleDateString()}</span>
        </div>

        <div className={styles.docActions}>
          {confirming ? (
            <>
              <button className="btn btn-secondary btn-sm" onClick={() => setConfirming(false)}>Cancel</button>
              <button
                className="btn btn-sm"
                style={{ background: 'var(--danger)', color: '#fff' }}
                onClick={() => onDelete(doc.id)}
              >
                Confirm Delete
              </button>
            </>
          ) : (
            <button className="btn btn-secondary btn-sm" onClick={() => setConfirming(true)}>Delete</button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Project Section ──
function ProjectSection({
  projectName,
  projectId,
  docs,
  onDelete,
  defaultExpanded,
}: {
  projectName: string
  projectId: string | null
  docs: KnowledgeDocument[]
  onDelete: (id: string) => void
  defaultExpanded: boolean
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  return (
    <div className={styles.projectSection}>
      <button className={styles.projectHeader} onClick={() => setExpanded(!expanded)}>
        <span className={styles.projectToggle}>{expanded ? '\u25BC' : '\u25B6'}</span>
        <span className={styles.projectIcon}>{projectId ? '\uD83D\uDCC1' : '\uD83C\uDF10'}</span>
        <span className={styles.projectName}>{projectName}</span>
        <span className={styles.projectCount}>{docs.length} doc{docs.length !== 1 ? 's' : ''}</span>
      </button>

      {expanded && (
        <div className={styles.projectDocs}>
          {docs.map((doc, i) => (
            <DocumentCard key={doc.id} doc={doc} onDelete={onDelete} index={i} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Recipe Health Panel ──
function RecipeHealthPanel({ data }: { data: RecipeStats }) {
  const captureTotal = Object.values(data.capture.stats).reduce((s, n) => s + n, 0)
  const captured = (data.capture.stats.captured ?? 0) + (data.capture.stats.derived ?? 0)
  const errors = data.capture.stats.error ?? 0
  const skipped = data.capture.stats.skipped ?? 0

  const isAlive = captured > 0
  const hasErrors = errors > 0

  const quality = data.quality
  const avgRate = quality.avgEffectiveRate != null ? Math.round(quality.avgEffectiveRate * 100) : null

  return (
    <div className={styles.recipePanel}>
      <div className={styles.recipePanelHeader}>
        <h3 className={styles.recipePanelTitle}>
          Recipe System
          <span className={`${styles.statusDot} ${isAlive ? styles.statusAlive : styles.statusDead}`} />
          <span className={styles.statusLabel}>{isAlive ? 'Active' : 'No captures yet'}</span>
        </h3>
      </div>

      <div className={styles.recipeStatsGrid}>
        {/* Capture Pipeline */}
        <div className={`card ${styles.recipeStatCard}`}>
          <div className={styles.recipeStatHeader}>Capture Pipeline</div>
          <div className={styles.recipeStatRow}>
            <span>Attempts</span>
            <span className="live-value">{captureTotal}</span>
          </div>
          <div className={styles.recipeStatRow}>
            <span>Captured</span>
            <span className="live-value" style={{ color: 'var(--success)' }}>{captured}</span>
          </div>
          <div className={styles.recipeStatRow}>
            <span>Skipped</span>
            <span className="live-value">{skipped}</span>
          </div>
          {hasErrors && (
            <div className={styles.recipeStatRow}>
              <span>Errors</span>
              <span className="live-value" style={{ color: 'var(--danger)' }}>{errors}</span>
            </div>
          )}
        </div>

        {/* Quality Metrics */}
        <div className={`card ${styles.recipeStatCard}`}>
          <div className={styles.recipeStatHeader}>Quality Metrics</div>
          <div className={styles.recipeStatRow}>
            <span>Docs with selections</span>
            <span className="live-value">{quality.selected ?? 0}/{quality.total ?? 0}</span>
          </div>
          <div className={styles.recipeStatRow}>
            <span>Total selections</span>
            <span className="live-value">{quality.totalSelections ?? 0}</span>
          </div>
          <div className={styles.recipeStatRow}>
            <span>Completions</span>
            <span className="live-value" style={{ color: 'var(--success)' }}>{quality.totalCompletions ?? 0}</span>
          </div>
          <div className={styles.recipeStatRow}>
            <span>Fallbacks</span>
            <span className="live-value" style={{ color: quality.totalFallbacks ? 'var(--warning)' : undefined }}>{quality.totalFallbacks ?? 0}</span>
          </div>
          {avgRate != null && (
            <div className={styles.recipeStatRow}>
              <span>Avg effective rate</span>
              <span className="live-value" style={{ color: avgRate > 50 ? 'var(--success)' : 'var(--warning)' }}>{avgRate}%</span>
            </div>
          )}
        </div>

        {/* Origin Distribution */}
        <div className={`card ${styles.recipeStatCard}`}>
          <div className={styles.recipeStatHeader}>Knowledge Origins</div>
          {Object.entries(data.origins).map(([origin, count]) => (
            <div key={origin} className={styles.recipeStatRow}>
              <span className={styles.originLabel}>
                <span className={`${styles.originDot} ${styles['origin_' + origin]}`} />
                {origin}
              </span>
              <span className="live-value">{count}</span>
            </div>
          ))}
          {data.lineage > 0 && (
            <div className={styles.recipeStatRow}>
              <span>Lineage edges</span>
              <span className="live-value">{data.lineage}</span>
            </div>
          )}
        </div>

        {/* Recent Activity */}
        <div className={`card ${styles.recipeStatCard}`}>
          <div className={styles.recipeStatHeader}>Usage (7 days)</div>
          {Object.entries(data.usage).length > 0 ? (
            Object.entries(data.usage).map(([action, count]) => (
              <div key={action} className={styles.recipeStatRow}>
                <span>{action}</span>
                <span className="live-value">{count}</span>
              </div>
            ))
          ) : (
            <div className={styles.recipeStatEmpty}>No usage data yet</div>
          )}
        </div>
      </div>

      {/* Recent Capture Attempts */}
      {data.capture.recent.length > 0 && (
        <details className={styles.recentCaptures}>
          <summary className={styles.recentCapturesSummary}>
            Recent capture attempts ({data.capture.recent.length})
          </summary>
          <div className={styles.captureLogTable}>
            <div className={styles.captureLogHeader}>
              <span>Time</span>
              <span>Source</span>
              <span>Status</span>
              <span>Details</span>
            </div>
            {data.capture.recent.map((entry) => (
              <div key={entry.id} className={`${styles.captureLogRow} ${styles['captureStatus_' + entry.status]}`}>
                <span>{parseDateSafe(entry.created_at).toLocaleString()}</span>
                <span>{entry.source}</span>
                <span className={`badge ${
                  entry.status === 'captured' || entry.status === 'derived' ? 'badge-healthy' :
                  entry.status === 'error' ? 'badge-warning' : ''
                }`}>{entry.status}</span>
                <span className={styles.captureLogDetail}>
                  {entry.title ?? entry.error_message ?? entry.source_id ?? '-'}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}

// ── Main Page ──
export default function KnowledgePage() {
  const [showCreate, setShowCreate] = useState(false)
  const [filterTag, setFilterTag] = useState('')
  const [filterProject, setFilterProject] = useState<string>('all')
  const [viewMode, setViewMode] = useState<'grouped' | 'flat'>('grouped')

  const { data, error, isLoading, mutate } = useSWR(
    `knowledge-${filterTag}-${filterProject}`,
    () => getKnowledgeDocuments({
      tag: filterTag || undefined,
      projectId: filterProject !== 'all' ? (filterProject === 'global' ? undefined : filterProject) : undefined,
    }),
    { refreshInterval: 15000 }
  )

  const { data: tagsData } = useSWR('knowledge-tags', getKnowledgeTags)
  const { data: projectsData } = useSWR('all-projects', getAllProjects)
  const { data: recipeData } = useSWR('recipe-stats', getRecipeStats, { refreshInterval: 30000 })

  const projects = projectsData?.projects ?? []
  const projectMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of projects) map.set(p.id, p.name)
    return map
  }, [projects])

  // Group documents by project
  const grouped = useMemo(() => {
    const docs = data?.documents ?? []
    const groups = new Map<string, { name: string; projectId: string | null; docs: KnowledgeDocument[] }>()

    for (const doc of docs) {
      const pid = doc.project_id
      const key = pid ?? '__global__'

      if (!groups.has(key)) {
        groups.set(key, {
          name: pid ? (projectMap.get(pid) ?? pid) : 'Global Knowledge',
          projectId: pid,
          docs: [],
        })
      }
      groups.get(key)?.docs.push(doc)
    }

    // Sort: global first, then alphabetical
    const sorted = [...groups.values()].sort((a, b) => {
      if (!a.projectId) return -1
      if (!b.projectId) return 1
      return a.name.localeCompare(b.name)
    })

    return sorted
  }, [data?.documents, projectMap])

  // Flat list for flat view
  const allDocs = data?.documents ?? []

  // Stats per project
  const projectStats = useMemo(() => {
    return grouped.map(g => ({
      name: g.name,
      projectId: g.projectId,
      count: g.docs.length,
      chunks: g.docs.reduce((s, d) => s + d.chunk_count, 0),
      hits: g.docs.reduce((s, d) => s + d.hit_count, 0),
    }))
  }, [grouped])

  async function handleCreate(input: { title: string; content: string; tags: string[]; projectId?: string }) {
    try {
      await createKnowledgeDocument(input)
      setShowCreate(false)
      mutate()
    } catch (err) {
      alert(`Failed to create: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteKnowledgeDocument(id)
      mutate()
    } catch (err) {
      alert(`Failed to delete: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const stats = data?.stats

  return (
    <DashboardLayout title="Knowledge Base" subtitle="Shared knowledge organized by project">
      {/* Recipe System Health */}
      {recipeData && <RecipeHealthPanel data={recipeData} />}

      {/* Stats Row */}
      {stats && (
        <div className={styles.statsGrid}>
          <div className={`card ${styles.statCard}`} style={{ '--stagger-index': 0 } as React.CSSProperties}>
            <span className={`${styles.statValue} live-value`}>{stats.totalDocs}</span>
            <span className={styles.statLabel}>Documents</span>
          </div>
          <div className={`card ${styles.statCard}`} style={{ '--stagger-index': 1 } as React.CSSProperties}>
            <span className={`${styles.statValue} live-value`}>{stats.totalChunks}</span>
            <span className={styles.statLabel}>Chunks</span>
          </div>
          <div className={`card ${styles.statCard}`} style={{ '--stagger-index': 2 } as React.CSSProperties}>
            <span className={`${styles.statValue} live-value`}>{stats.totalHits}</span>
            <span className={styles.statLabel}>Search Hits</span>
          </div>
          <div className={`card ${styles.statCard}`} style={{ '--stagger-index': 3 } as React.CSSProperties}>
            <span className={`${styles.statValue} live-value`}>{grouped.length}</span>
            <span className={styles.statLabel}>Projects</span>
          </div>
        </div>
      )}

      {/* Action Bar */}
      <div className={styles.actionBar}>
        <div className={styles.filters}>
          {/* Project filter */}
          <select
            className={styles.filterSelect}
            value={filterProject}
            onChange={(e) => setFilterProject(e.target.value)}
          >
            <option value="all">All projects</option>
            <option value="global">Global only</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>

          {/* Tag filter */}
          <select
            className={styles.filterSelect}
            value={filterTag}
            onChange={(e) => setFilterTag(e.target.value)}
          >
            <option value="">All tags</option>
            {(tagsData?.tags ?? []).map((tag) => (
              <option key={tag} value={tag}>{tag}</option>
            ))}
          </select>

          {/* View mode toggle */}
          <div className={styles.viewToggle}>
            <button
              className={`${styles.viewBtn} ${viewMode === 'grouped' ? styles.viewBtnActive : ''}`}
              onClick={() => setViewMode('grouped')}
              title="Group by project"
            >
              Grouped
            </button>
            <button
              className={`${styles.viewBtn} ${viewMode === 'flat' ? styles.viewBtnActive : ''}`}
              onClick={() => setViewMode('flat')}
              title="Flat list"
            >
              Flat
            </button>
          </div>
        </div>

        <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>
          + New Document
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className={styles.errorBanner}>
          Failed to load knowledge documents. Is the API running?
        </div>
      )}

      {/* Loading */}
      {isLoading && !data && (
        <div className={styles.loading}>Loading knowledge base...</div>
      )}

      {/* Content */}
      {allDocs.length === 0 && !isLoading ? (
        <div className={styles.emptyState}>
          <p>No knowledge documents yet.</p>
          <p>
            Create one manually or use <code>cortex_knowledge_store</code> from an AI agent.
          </p>
        </div>
      ) : viewMode === 'grouped' ? (
        /* Grouped View */
        <div className={styles.groupedList}>
          {/* Project summary bar */}
          {projectStats.length > 1 && (
            <div className={styles.projectSummary}>
              {projectStats.map((ps) => (
                <button
                  key={ps.projectId ?? 'global'}
                  className={styles.projectPill}
                  onClick={() => setFilterProject(ps.projectId ?? 'global')}
                  title={`${ps.count} docs, ${ps.chunks} chunks, ${ps.hits} hits`}
                >
                  <span className={styles.pillIcon}>{ps.projectId ? '\uD83D\uDCC1' : '\uD83C\uDF10'}</span>
                  <span className={styles.pillName}>{ps.name}</span>
                  <span className={styles.pillCount}>{ps.count}</span>
                </button>
              ))}
            </div>
          )}

          {grouped.map((group) => (
            <ProjectSection
              key={group.projectId ?? '__global__'}
              projectName={group.name}
              projectId={group.projectId}
              docs={group.docs}
              onDelete={handleDelete}
              defaultExpanded={grouped.length <= 3}
            />
          ))}
        </div>
      ) : (
        /* Flat View */
        <div className={styles.docList}>
          {allDocs.map((doc: KnowledgeDocument, i: number) => (
            <DocumentCard
              key={doc.id}
              doc={doc}
              onDelete={handleDelete}
              showProject
              projectName={doc.project_id ? (projectMap.get(doc.project_id) ?? doc.project_id) : 'Global'}
              index={i}
            />
          ))}
        </div>
      )}

      {/* Create Dialog */}
      {showCreate && (
        <CreateDocumentDialog
          projects={projects}
          onSubmit={handleCreate}
          onCancel={() => setShowCreate(false)}
        />
      )}
    </DashboardLayout>
  )
}
