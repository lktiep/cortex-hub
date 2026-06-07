'use client'

import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import DashboardLayout from '@/components/layout/DashboardLayout'
import styles from './page.module.css'
import { parseDateSafe } from '@/lib/date'

import useSWR from 'swr'
import { listApiKeys, createApiKey, revokeApiKey, updateApiKey } from '@/lib/api'
import type { ApiKey } from '@/lib/api'
import { KeyRound, ClipboardList, AlertTriangle, XCircle, ICON_INLINE } from '@/lib/icons'

function copyTextFallback(text: string): boolean {
  const textArea = document.createElement('textarea')
  textArea.value = text
  textArea.style.top = '0'
  textArea.style.left = '0'
  textArea.style.position = 'fixed'
  textArea.style.opacity = '0'
  document.body.appendChild(textArea)
  textArea.focus()
  textArea.select()
  let success = false
  try {
    success = document.execCommand('copy')
  } catch (err) {
    console.error('Fallback copy failed:', err)
  }
  document.body.removeChild(textArea)
  return success
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch (e) {
    console.warn('Modern clipboard API failed, trying fallback:', e)
  }
  return copyTextFallback(text)
}

const allPermissions = [
  { id: 'cortex.session.start', label: 'Start Session (session_start)', group: 'Session' },
  { id: 'cortex.session.end', label: 'End Session (session_end)', group: 'Session' },
  { id: 'cortex.changes', label: 'Check Remote Changes (changes)', group: 'Changes' },
  { id: 'cortex.code.search', label: 'Code Search (code_search)', group: 'Code' },
  { id: 'cortex.code.context', label: 'Symbol Context (code_context)', group: 'Code' },
  { id: 'cortex.code.impact', label: 'Blast Radius (code_impact)', group: 'Code' },
  { id: 'cortex.code.reindex', label: 'Trigger Reindex (code_reindex)', group: 'Code' },
  { id: 'cortex.list.repos', label: 'List Repositories (list_repos)', group: 'Code' },
  { id: 'cortex.cypher', label: 'Cypher Graph Queries (cypher)', group: 'Code' },
  { id: 'cortex.detect.changes', label: 'Pre-commit Change Risk (detect_changes)', group: 'Code' },
  { id: 'cortex.memory.store', label: 'Store Memory (memory_store)', group: 'Memory' },
  { id: 'cortex.memory.search', label: 'Search Memory (memory_search)', group: 'Memory' },
  { id: 'cortex.memory.delete', label: 'Delete Memory (memory_delete)', group: 'Memory' },
  { id: 'cortex.knowledge.store', label: 'Store Team Knowledge (knowledge_store)', group: 'Knowledge' },
  { id: 'cortex.knowledge.search', label: 'Search Team Knowledge (knowledge_search)', group: 'Knowledge' },
  { id: 'cortex.quality.report', label: 'Report Quality Gates (quality_report)', group: 'Quality' },
  { id: 'cortex.plan.quality', label: 'Assess Plan Quality (plan_quality)', group: 'Quality' },
  { id: 'cortex.task.create', label: 'Create Task (task_create)', group: 'Tasks' },
  { id: 'cortex.task.pickup', label: 'Pickup Task (task_pickup)', group: 'Tasks' },
  { id: 'cortex.task.accept', label: 'Accept Task (task_accept)', group: 'Tasks' },
  { id: 'cortex.task.update', label: 'Update Task (task_update)', group: 'Tasks' },
  { id: 'cortex.task.list', label: 'List Tasks (task_list)', group: 'Tasks' },
  { id: 'cortex.task.status', label: 'Task Status (task_status)', group: 'Tasks' },
  { id: 'cortex.task.submit.strategy', label: 'Submit Strategy (task_submit_strategy)', group: 'Tasks' },
  { id: 'cortex.health', label: 'Health Diagnostics (health)', group: 'System' },
  { id: 'cortex.tool.stats', label: 'Tool Usage Stats (tool_stats)', group: 'System' },
]

export default function KeysPage() {
  const { data, mutate } = useSWR('api_keys', listApiKeys)
  const keys = data?.keys ?? []
  const [showCreate, setShowCreate] = useState(false)
  const [newKeyResult, setNewKeyResult] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)

  // Create key form state
  const [keyName, setKeyName] = useState('')
  const [keyScope, setKeyScope] = useState('all')
  const [keyPerms, setKeyPerms] = useState<string[]>(allPermissions.map((p) => p.id))
  const [keyExpiry, setKeyExpiry] = useState('never')

  // Edit key form state
  const [showEdit, setShowEdit] = useState(false)
  const [editTarget, setEditTarget] = useState<ApiKey | null>(null)
  const [editName, setEditName] = useState('')
  const [editScope, setEditScope] = useState('all')
  const [editPerms, setEditPerms] = useState<string[]>([])
  const [isUpdating, setIsUpdating] = useState(false)

  // Portaling and premium modals state
  const [mounted, setMounted] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    setMounted(true)
  }, [])

  function togglePerm(id: string) {
    setKeyPerms((prev) => prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id])
  }

  function handleEditClick(key: ApiKey) {
    setEditTarget(key)
    setEditName(key.name)
    setEditScope(key.scope)
    setEditPerms(key.permissions ?? [])
    setShowEdit(true)
  }

  function toggleEditPerm(id: string) {
    setEditPerms((prev) => prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id])
  }

  async function handleUpdate() {
    if (!editTarget) return
    setIsUpdating(true)
    try {
      await updateApiKey(editTarget.id, {
        name: editName,
        scope: editScope,
        permissions: editPerms,
      })
      setShowEdit(false)
      setEditTarget(null)
      mutate() // Refresh list
    } catch (err) {
      setErrorMessage(`Failed to update key: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsUpdating(false)
    }
  }

  async function handleCreate() {
    setIsCreating(true)
    try {
      const result = await createApiKey({
        name: keyName,
        scope: keyScope,
        permissions: keyPerms,
        expiresInDays: keyExpiry === 'never' ? undefined : parseInt(keyExpiry),
      })

      setNewKeyResult(result.key)
      setShowCreate(false)
      setKeyName('')
      mutate() // Refresh list
    } catch (err) {
      setErrorMessage(`Failed to create key: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsCreating(false)
    }
  }

  function handleRevokeClick(id: string) {
    setRevokeTarget(id)
  }

  async function performRevoke(id: string) {
    setRevokeTarget(null)
    try {
      await revokeApiKey(id)
      mutate() // Refresh list
    } catch (err) {
      setErrorMessage(`Failed to revoke key: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <DashboardLayout title="API Keys" subtitle="Manage authentication keys for MCP access">
      {/* Actions */}
      <div className={styles.actions}>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
          + Create API Key
        </button>
      </div>

      {/* Keys Table */}
      <div className={styles.tableCard}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Key</th>
              <th>Scope</th>
              <th>Created</th>
              <th>Expires</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key.id}>
                <td className={styles.keyName}>{key.name}</td>
                <td><code className={styles.keyPrefix}>{key.prefix}</code></td>
                <td>{key.scope}</td>
                <td className={styles.cellMuted}>
                  {key.createdAt ? parseDateSafe(key.createdAt).toLocaleString() : '—'}
                </td>
                <td className={styles.cellMuted}>
                  {key.expiresAt ? parseDateSafe(key.expiresAt).toLocaleString() : 'Never'}
                </td>
                <td>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => handleEditClick(key)}
                    style={{ marginRight: 'var(--space-2)' }}
                  >
                    Edit
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => handleRevokeClick(key.id)}
                    style={{ color: 'var(--status-error)' }}
                  >
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
            {keys.length === 0 && (
              <tr>
                <td colSpan={6} className={styles.emptyState}>
                  No API keys. Create one to connect your AI agent.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Portals for Modals (to avoid CSS transform stacking context bugs) */}
      {mounted && newKeyResult && createPortal(
        <div className={styles.modal}>
          <div className={styles.modalContent} style={{ maxWidth: '500px', textAlign: 'center' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 'var(--space-4)', color: 'var(--status-healthy)' }}>
              <KeyRound size={40} strokeWidth={1.5} />
            </div>
            <h2 style={{ marginBottom: 'var(--space-2)' }}>API Key Created</h2>
            <p style={{ color: 'var(--status-warning)', fontSize: '0.875rem', marginBottom: 'var(--space-6)' }}>
              Copy this key now. For security reasons, you won't be able to see it again!
            </p>
            <code className={styles.newKeyValue} style={{ textAlign: 'left', background: 'var(--bg-primary)' }}>{newKeyResult}</code>
            <div className={styles.modalActions} style={{ justifyContent: 'center', marginTop: 'var(--space-6)' }}>
              <button
                className="btn btn-ghost"
                onClick={() => setNewKeyResult(null)}
              >
                Close
              </button>
              <button
                className="btn btn-primary"
                onClick={async () => {
                  await copyToClipboard(newKeyResult)
                  setNewKeyResult(null)
                }}
              >
                <ClipboardList {...ICON_INLINE} /> Copy &amp; Close
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {mounted && showCreate && createPortal(
        <div className={styles.modal}>
          <div className={styles.modalContent}>
            <h2 style={{ marginBottom: 'var(--space-6)' }}>New API Key</h2>

            <label className={styles.fieldLabel}>Name</label>
            <input
              className="input"
              placeholder="e.g. my-agent-prod"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
            />

            <label className={styles.fieldLabel} style={{ marginTop: 'var(--space-5)' }}>Scope</label>
            <select
              className="input"
              value={keyScope}
              onChange={(e) => setKeyScope(e.target.value)}
            >
              <option value="all">All Projects</option>
              <option value="org:default">Organization: Default/*</option>
              <option value="org:personal">Organization: Personal/*</option>
            </select>

            <label className={styles.fieldLabel} style={{ marginTop: 'var(--space-5)' }}>Permissions</label>
            <div className={styles.permGrid}>
              {allPermissions.map((p) => (
                <label key={p.id} className={styles.permItem}>
                  <input
                    type="checkbox"
                    checked={keyPerms.includes(p.id)}
                    onChange={() => togglePerm(p.id)}
                    style={{ accentColor: 'var(--accent-primary)' }}
                  />
                  <span>{p.label}</span>
                  <span className={styles.permGroup}>{p.group}</span>
                </label>
              ))}
            </div>

            <label className={styles.fieldLabel} style={{ marginTop: 'var(--space-5)' }}>Expiration</label>
            <select
              className="input"
              value={keyExpiry}
              onChange={(e) => setKeyExpiry(e.target.value)}
            >
              <option value="never">Never</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="365">1 year</option>
            </select>

            <div className={styles.modalActions}>
              <button className="btn btn-ghost" onClick={() => setShowCreate(false)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={!keyName || isCreating}
                onClick={handleCreate}
              >
                {isCreating ? 'Generating...' : 'Generate Key'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {mounted && showEdit && createPortal(
        <div className={styles.modal}>
          <div className={styles.modalContent}>
            <h2 style={{ marginBottom: 'var(--space-6)' }}>Edit API Key</h2>

            <label className={styles.fieldLabel}>Name</label>
            <input
              className="input"
              placeholder="e.g. my-agent-prod"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
            />

            <label className={styles.fieldLabel} style={{ marginTop: 'var(--space-5)' }}>Scope</label>
            <select
              className="input"
              value={editScope}
              onChange={(e) => setEditScope(e.target.value)}
            >
              <option value="all">All Projects</option>
              <option value="org:default">Organization: Default/*</option>
              <option value="org:personal">Organization: Personal/*</option>
            </select>

            <label className={styles.fieldLabel} style={{ marginTop: 'var(--space-5)' }}>Permissions</label>
            <div className={styles.permGrid}>
              {allPermissions.map((p) => (
                <label key={p.id} className={styles.permItem}>
                  <input
                    type="checkbox"
                    checked={editPerms.includes(p.id)}
                    onChange={() => toggleEditPerm(p.id)}
                    style={{ accentColor: 'var(--accent-primary)' }}
                  />
                  <span>{p.label}</span>
                  <span className={styles.permGroup}>{p.group}</span>
                </label>
              ))}
            </div>

            <div className={styles.modalActions} style={{ marginTop: 'var(--space-6)' }}>
              <button className="btn btn-ghost" onClick={() => { setShowEdit(false); setEditTarget(null); }}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={!editName || isUpdating}
                onClick={handleUpdate}
              >
                {isUpdating ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {mounted && revokeTarget && createPortal(
        <div className={styles.modal}>
          <div className={styles.modalContent} style={{ maxWidth: '400px', textAlign: 'center' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 'var(--space-4)', color: 'var(--status-error)' }}>
              <AlertTriangle size={40} />
            </div>
            <h2 style={{ marginBottom: 'var(--space-2)' }}>Revoke API Key</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: 'var(--space-6)' }}>
              Are you sure you want to revoke this key? This action is permanent and cannot be undone.
            </p>
            <div className={styles.modalActions} style={{ justifyContent: 'center' }}>
              <button
                className="btn btn-ghost"
                onClick={() => setRevokeTarget(null)}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                style={{ backgroundColor: 'var(--status-error)', borderColor: 'var(--status-error)' }}
                onClick={() => performRevoke(revokeTarget)}
              >
                Revoke Key
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {mounted && errorMessage && createPortal(
        <div className={styles.modal}>
          <div className={styles.modalContent} style={{ maxWidth: '400px', textAlign: 'center' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 'var(--space-4)', color: 'var(--status-error)' }}>
              <XCircle size={40} />
            </div>
            <h2 style={{ marginBottom: 'var(--space-2)' }}>Error</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: 'var(--space-6)' }}>
              {errorMessage}
            </p>
            <div className={styles.modalActions} style={{ justifyContent: 'center' }}>
              <button className="btn btn-primary" onClick={() => setErrorMessage(null)}>
                OK
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </DashboardLayout>
  )
}
