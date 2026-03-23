'use client'

import { useState } from 'react'
import DashboardLayout from '@/components/layout/DashboardLayout'
import useSWR from 'swr'
import {
  getKnowledgeDocuments,
  createKnowledgeDocument,
  deleteKnowledgeDocument,
  getKnowledgeTags,
  type KnowledgeDocument,
} from '@/lib/api'
import styles from './page.module.css'

// ── Create Dialog ──
function CreateDocumentDialog({
  onSubmit,
  onCancel,
}: {
  onSubmit: (data: { title: string; content: string; tags: string[] }) => void
  onCancel: () => void
}) {
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [tagsInput, setTagsInput] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const canSubmit = title.trim().length > 0 && content.trim().length > 0

  async function handleSubmit() {
    setSubmitting(true)
    const tags = tagsInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    onSubmit({ title: title.trim(), content: content.trim(), tags })
  }

  return (
    <div className={styles.dialogOverlay} onClick={onCancel}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.dialogTitle}>New Knowledge Document</h3>

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
          <button className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={handleSubmit}
            disabled={!canSubmit || submitting}
          >
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
}: {
  doc: KnowledgeDocument
  onDelete: (id: string) => void
}) {
  const [confirming, setConfirming] = useState(false)
  let tags: string[] = []
  try {
    tags = JSON.parse(doc.tags) as string[]
  } catch {
    /* ignore */
  }

  return (
    <div className={styles.docCard}>
      <div className={styles.docHeader}>
        <h4 className={styles.docTitle}>{doc.title}</h4>
        <div className={styles.docMeta}>
          <span className={styles.docSource}>{doc.source}</span>
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
            <span key={tag} className={styles.tag}>
              {tag}
            </span>
          ))}
        </div>

        <div className={styles.docStats}>
          <span title="Chunks">{doc.chunk_count} chunks</span>
          <span title="Search hits">{doc.hit_count} hits</span>
          <span title="Created">
            {new Date(doc.created_at).toLocaleDateString()}
          </span>
        </div>

        <div className={styles.docActions}>
          {confirming ? (
            <>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
              <button
                className="btn btn-sm"
                style={{ background: 'var(--danger)', color: '#fff' }}
                onClick={() => onDelete(doc.id)}
              >
                Confirm Delete
              </button>
            </>
          ) : (
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setConfirming(true)}
            >
              Delete
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Main Page ──
export default function KnowledgePage() {
  const [showCreate, setShowCreate] = useState(false)
  const [filterTag, setFilterTag] = useState('')

  const { data, error, isLoading, mutate } = useSWR(
    `knowledge-${filterTag}`,
    () => getKnowledgeDocuments(filterTag ? { tag: filterTag } : undefined),
    { refreshInterval: 15000 }
  )

  const { data: tagsData } = useSWR('knowledge-tags', getKnowledgeTags)

  async function handleCreate(input: {
    title: string
    content: string
    tags: string[]
  }) {
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

  const documents = data?.documents ?? []
  const stats = data?.stats

  return (
    <DashboardLayout
      title="Knowledge Base"
      subtitle="Shared knowledge contributed by agents and humans"
    >
      {/* Stats */}
      {stats && (
        <div className={styles.statsGrid}>
          <div className={styles.statCard}>
            <span className={styles.statValue}>{stats.totalDocs}</span>
            <span className={styles.statLabel}>Documents</span>
          </div>
          <div className={styles.statCard}>
            <span className={styles.statValue}>{stats.totalChunks}</span>
            <span className={styles.statLabel}>Chunks</span>
          </div>
          <div className={styles.statCard}>
            <span className={styles.statValue}>{stats.totalHits}</span>
            <span className={styles.statLabel}>Search Hits</span>
          </div>
        </div>
      )}

      {/* Action Bar */}
      <div className={styles.actionBar}>
        <div className={styles.filters}>
          <select
            className={styles.filterSelect}
            value={filterTag}
            onChange={(e) => setFilterTag(e.target.value)}
          >
            <option value="">All tags</option>
            {(tagsData?.tags ?? []).map((tag) => (
              <option key={tag} value={tag}>
                {tag}
              </option>
            ))}
          </select>
        </div>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => setShowCreate(true)}
        >
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

      {/* Document List */}
      {documents.length === 0 && !isLoading && (
        <div className={styles.emptyState}>
          <p>No knowledge documents yet.</p>
          <p>
            Create one manually or use{' '}
            <code>cortex_knowledge_store</code> from an AI agent.
          </p>
        </div>
      )}

      <div className={styles.docList}>
        {documents.map((doc: KnowledgeDocument) => (
          <DocumentCard
            key={doc.id}
            doc={doc}
            onDelete={handleDelete}
          />
        ))}
      </div>

      {/* Create Dialog */}
      {showCreate && (
        <CreateDocumentDialog
          onSubmit={handleCreate}
          onCancel={() => setShowCreate(false)}
        />
      )}
    </DashboardLayout>
  )
}
