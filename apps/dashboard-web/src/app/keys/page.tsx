'use client'

import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import DashboardLayout from '@/components/layout/DashboardLayout'
import styles from './page.module.css'
import { parseDateSafe } from '@/lib/date'

import useSWR from 'swr'
import { listApiKeys, createApiKey, revokeApiKey, updateApiKey, getOrganizations } from '@/lib/api'
import type { ApiKey, KeyBindingMode, Organization } from '@/lib/api'
import { KeyRound, ClipboardList, AlertTriangle, XCircle, ICON_INLINE } from '@/lib/icons'
import { copyToClipboard } from '@/lib/clipboard'
import KeyQuickStart from '@/components/KeyQuickStart'
import { MCP_TOOL_PERMISSIONS } from '@cortex/shared-types'
import { permissionsToSave, tickedPermissions } from '@/lib/key-permissions'

const BINDING_NOTE: Record<KeyBindingMode, string> = {
  off: 'A key bound to no organization reaches all of them.',
  warn: 'A key bound to no organization still reaches all of them, and the hub logs a warning for it.',
  required: 'A key bound to no organization is refused (API_KEY_BINDING=required).',
}

/** Organization checkboxes: the key reaches only the ticked ones; none ticked leaves it unbound. */
function OrgPicker({ orgs, selected, onToggle, binding }: {
  orgs: Organization[]
  selected: string[]
  onToggle: (id: string) => void
  binding: KeyBindingMode
}) {
  return (
    <>
      <p className={styles.permHint}>
        The key reaches only the projects of the ticked organizations. {selected.length === 0 && BINDING_NOTE[binding]}
      </p>
      <div className={styles.permGrid}>
        {orgs.map((o) => (
          <label key={o.id} className={styles.permItem}>
            <input
              type="checkbox"
              checked={selected.includes(o.id)}
              onChange={() => onToggle(o.id)}
              style={{ accentColor: 'var(--accent-primary)' }}
            />
            <span>{o.name}</span>
            <span className={styles.permGroup}>{o.project_count} projects</span>
          </label>
        ))}
      </div>
    </>
  )
}

export default function KeysPage() {
  const { data, mutate } = useSWR('api_keys', listApiKeys)
  const keys = data?.keys ?? []
  const binding = data?.binding ?? 'warn'
  const { data: orgData } = useSWR('organizations', getOrganizations)
  const orgs = orgData?.organizations ?? []
  const orgName = (id: string) => orgs.find((o) => o.id === id)?.name ?? id
  const [showCreate, setShowCreate] = useState(false)
  const [newKeyResult, setNewKeyResult] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)

  // Create key form state
  const [keyName, setKeyName] = useState('')
  const [keyScope, setKeyScope] = useState('all')
  const [keyPerms, setKeyPerms] = useState<string[]>(MCP_TOOL_PERMISSIONS.map((p) => p.id))
  const [keyExpiry, setKeyExpiry] = useState('never')
  const [keyOrgs, setKeyOrgs] = useState<string[]>([])

  // Edit key form state
  const [showEdit, setShowEdit] = useState(false)
  const [editTarget, setEditTarget] = useState<ApiKey | null>(null)
  const [editName, setEditName] = useState('')
  const [editScope, setEditScope] = useState('all')
  const [editPerms, setEditPerms] = useState<string[]>([])
  const [editOrgs, setEditOrgs] = useState<string[]>([])
  const [isUpdating, setIsUpdating] = useState(false)

  // Portaling and premium modals state
  const [mounted, setMounted] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    setMounted(true)
  }, [])

  const toggle = (id: string) => (prev: string[]) => prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]

  function togglePerm(id: string) {
    setKeyPerms((prev) => prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id])
  }

  function handleEditClick(key: ApiKey) {
    setEditTarget(key)
    setEditName(key.name)
    setEditScope(key.scope)
    setEditPerms(tickedPermissions(key.permissions))
    setEditOrgs(key.orgs ?? [])
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
        permissions: permissionsToSave(editPerms),
        orgs: editOrgs,
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
        permissions: permissionsToSave(keyPerms),
        expiresInDays: keyExpiry === 'never' ? undefined : parseInt(keyExpiry),
        orgs: keyOrgs,
      })

      setNewKeyResult(result.key)
      setShowCreate(false)
      setKeyName('')
      setKeyOrgs([])
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
              <th>Organizations</th>
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
                <td className={(key.orgs ?? []).length ? undefined : styles.cellMuted}>
                  {(key.orgs ?? []).length
                    ? key.orgs.map(orgName).join(', ')
                    : binding === 'required' ? 'Unbound (refused)' : 'All (unbound)'}
                </td>
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
                <td colSpan={7} className={styles.emptyState}>
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
          <div className={styles.modalContent} style={{ maxWidth: '720px', textAlign: 'center' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 'var(--space-4)', color: 'var(--status-healthy)' }}>
              <KeyRound size={40} strokeWidth={1.5} />
            </div>
            <h2 style={{ marginBottom: 'var(--space-2)' }}>API Key Created</h2>
            <p style={{ color: 'var(--status-warning)', fontSize: '0.875rem', marginBottom: 'var(--space-6)' }}>
              Copy this key now. For security reasons, you won't be able to see it again!
            </p>
            <code className={styles.newKeyValue} style={{ textAlign: 'left', background: 'var(--bg-primary)' }}>{newKeyResult}</code>
            <KeyQuickStart apiKey={newKeyResult} />
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

            <label className={styles.fieldLabel} style={{ marginTop: 'var(--space-5)' }}>Organizations</label>
            <OrgPicker orgs={orgs} selected={keyOrgs} onToggle={(id) => setKeyOrgs(toggle(id))} binding={binding} />

            <label className={styles.fieldLabel} style={{ marginTop: 'var(--space-5)' }}>Permissions</label>
            <p className={styles.permHint}>With every box ticked the key also gets tools added in later versions.</p>
            <div className={styles.permGrid}>
              {MCP_TOOL_PERMISSIONS.map((p) => (
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

            <label className={styles.fieldLabel} style={{ marginTop: 'var(--space-5)' }}>Organizations</label>
            <OrgPicker orgs={orgs} selected={editOrgs} onToggle={(id) => setEditOrgs(toggle(id))} binding={binding} />

            <label className={styles.fieldLabel} style={{ marginTop: 'var(--space-5)' }}>Permissions</label>
            <p className={styles.permHint}>With every box ticked the key also gets tools added in later versions.</p>
            <div className={styles.permGrid}>
              {MCP_TOOL_PERMISSIONS.map((p) => (
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
