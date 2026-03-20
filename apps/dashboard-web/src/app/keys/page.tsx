'use client'

import { useState } from 'react'
import DashboardLayout from '@/components/layout/DashboardLayout'
import styles from './page.module.css'

import useSWR from 'swr'
import { listApiKeys, createApiKey, revokeApiKey } from '@/lib/api'

const allPermissions = [
  { id: 'cortex.health', label: 'Health Check', group: 'System' },
  { id: 'cortex.memory.store', label: 'Store Memory', group: 'Memory' },
  { id: 'cortex.memory.search', label: 'Search Memory', group: 'Memory' },
  { id: 'cortex.code.search', label: 'Code Search', group: 'Code' },
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

  function togglePerm(id: string) {
    setKeyPerms((prev) => prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id])
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
      alert(`Failed to create key: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsCreating(false)
    }
  }

  async function handleRevoke(id: string) {
    if (!confirm('Are you sure you want to revoke this key? This action cannot be undone.')) return
    
    try {
      await revokeApiKey(id)
      mutate() // Refresh list
    } catch (err) {
      alert(`Failed to revoke key: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <DashboardLayout title="API Keys" subtitle="Manage authentication keys for MCP access">
      {/* New Key Result */}
      {newKeyResult && (
        <div className={styles.newKeyBanner}>
          <div className={styles.newKeyHeader}>
            <span>🔑</span>
            <strong>API Key Created</strong>
            <span style={{ color: 'var(--status-warning)', fontSize: '0.8125rem' }}>
              Copy now — won't be shown again
            </span>
          </div>
          <code className={styles.newKeyValue}>{newKeyResult}</code>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              navigator.clipboard.writeText(newKeyResult)
              setNewKeyResult(null)
            }}
          >
            📋 Copy & Close
          </button>
        </div>
      )}

      {/* Actions */}
      <div className={styles.actions}>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
          + Create API Key
        </button>
      </div>

      {/* Create Modal */}
      {showCreate && (
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
              <option value="org:yulgang">Organization: Yulgang/*</option>
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
        </div>
      )}

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
                <td className={styles.cellMuted}>{key.createdAt}</td>
                <td className={styles.cellMuted}>{key.expiresAt ?? 'Never'}</td>
                <td>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => handleRevoke(key.id)}
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
    </DashboardLayout>
  )
}
