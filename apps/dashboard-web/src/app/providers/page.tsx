'use client'

import { useState, useCallback, useEffect } from 'react'
import DashboardLayout from '@/components/layout/DashboardLayout'
import useSWR from 'swr'
import { config } from '@/lib/config'
import styles from './page.module.css'

// ── Types ──
interface ProviderAccount {
  id: string
  name: string
  type: string
  auth_type: string
  api_base: string
  api_key: string | null
  status: string
  capabilities: string[]
  models: string[]
  created_at: string
}

interface Pagination {
  page: number
  limit: number
  total: number
  totalPages: number
}

interface AccountsResponse {
  accounts: ProviderAccount[]
  pagination: Pagination
}

interface TestKeyResult {
  success: boolean
  latency?: number
  chatModels?: string[]
  embedModels?: string[]
  codeModels?: string[]
  totalModels?: number
  error?: string
}

// ── Constants ──
// ── Provider Type Definitions (GoClaw-style) ──
interface ProviderTypeDef {
  id: string
  label: string
  icon: string
  authType: 'oauth' | 'api_key'
  defaultBase: string
  oauthProvider?: string  // for OAuth types: CLIProxy provider name
  description?: string
}

const PROVIDER_TYPES: ProviderTypeDef[] = [
  // OAuth providers
  {
    id: 'chatgpt_oauth',
    label: 'ChatGPT Subscription (OAuth)',
    icon: '🤖',
    authType: 'oauth',
    defaultBase: 'http://llm-proxy:8317/v1',
    oauthProvider: 'openai',
    description: 'Sign in with your ChatGPT account to use your subscription\'s models',
  },
  {
    id: 'gemini_oauth',
    label: 'Google Gemini (OAuth)',
    icon: '✨',
    authType: 'oauth',
    defaultBase: 'http://llm-proxy:8317/v1',
    oauthProvider: 'gemini',
    description: 'Sign in with Google to use Gemini models via CLIProxy',
  },
  {
    id: 'anthropic_oauth',
    label: 'Anthropic Claude (OAuth)',
    icon: '🧩',
    authType: 'oauth',
    defaultBase: 'http://llm-proxy:8317/v1',
    oauthProvider: 'anthropic',
    description: 'Sign in with Anthropic to use Claude models',
  },
  // API Key providers
  {
    id: 'openai_compat',
    label: 'OpenAI Compatible',
    icon: '🔗',
    authType: 'api_key',
    defaultBase: 'https://api.openai.com/v1',
  },
  {
    id: 'gemini',
    label: 'Google Gemini (API Key)',
    icon: '✨',
    authType: 'api_key',
    defaultBase: 'https://generativelanguage.googleapis.com/v1beta',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    icon: '🌐',
    authType: 'api_key',
    defaultBase: 'https://openrouter.ai/api/v1',
  },
  {
    id: 'groq',
    label: 'Groq',
    icon: '⚡',
    authType: 'api_key',
    defaultBase: 'https://api.groq.com/openai/v1',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    icon: '🔍',
    authType: 'api_key',
    defaultBase: 'https://api.deepseek.com/v1',
  },
  {
    id: 'mistral',
    label: 'Mistral AI',
    icon: '🌊',
    authType: 'api_key',
    defaultBase: 'https://api.mistral.ai/v1',
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    icon: '🚀',
    authType: 'api_key',
    defaultBase: 'https://api.x.ai/v1',
  },
  {
    id: 'cohere',
    label: 'Cohere',
    icon: '🧬',
    authType: 'api_key',
    defaultBase: 'https://api.cohere.com/v1',
  },
  {
    id: 'ollama',
    label: 'Ollama (Local)',
    icon: '🦙',
    authType: 'api_key',
    defaultBase: 'http://localhost:11434/v1',
  },
]

const TYPE_ICONS: Record<string, string> = Object.fromEntries(PROVIDER_TYPES.map((t) => [t.id, t.icon]))
const TYPE_LABELS: Record<string, string> = Object.fromEntries(PROVIDER_TYPES.map((t) => [t.id, t.label]))

// ── Fetcher ──
async function fetchAccounts(page = 1, search = ''): Promise<AccountsResponse> {
  const params = new URLSearchParams({ page: String(page), limit: '20' })
  if (search) params.set('search', search)
  const res = await fetch(`${config.api.base}/api/accounts?${params}`, {
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new Error('Failed to fetch accounts')
  return res.json()
}

// ── Components ──
function StatusBadge({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    enabled: 'var(--success)',
    disabled: 'var(--text-tertiary)',
    error: 'var(--danger)',
  }
  return (
    <span
      className={styles.statusBadge}
      style={{ '--badge-color': colorMap[status] || 'var(--text-tertiary)' } as React.CSSProperties}
    >
      <span className={styles.statusDot} />
      {status === 'enabled' ? 'Enabled' : status === 'disabled' ? 'Disabled' : 'Error'}
    </span>
  )
}

// ── Add Provider Dialog (multi-step: Config → Test → Models → Save) ──
type DialogStep = 'config' | 'testing' | 'models' | 'saving'

function AddProviderDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void
  onSaved: () => void
}) {
  const defaultType = PROVIDER_TYPES[0] as ProviderTypeDef
  const [step, setStep] = useState<DialogStep>('config')
  const [selectedType, setSelectedType] = useState<ProviderTypeDef>(defaultType)
  const [name, setName] = useState(defaultType.label)
  const [apiBase, setApiBase] = useState(defaultType.defaultBase)
  const [apiKey, setApiKey] = useState('')
  const [testResult, setTestResult] = useState<TestKeyResult | null>(null)
  const [testError, setTestError] = useState('')

  // Model selection
  const [selectedChatModel, setSelectedChatModel] = useState('')
  const [selectedEmbedModel, setSelectedEmbedModel] = useState('')

  const handleTypeChange = (typeId: string) => {
    const typeDef = PROVIDER_TYPES.find((t) => t.id === typeId)
    if (!typeDef) return
    setSelectedType(typeDef)
    setName(typeDef.label)
    setApiBase(typeDef.defaultBase)
    setTestResult(null)
    setTestError('')
    setApiKey('')
  }

  // Test the key or OAuth connection
  const handleTestKey = async () => {
    setStep('testing')
    setTestError('')
    setTestResult(null)
    try {
      const testType = selectedType.id === 'gemini' ? 'gemini' : 'openai_compat'
      const res = await fetch(`${config.api.base}/api/accounts/test-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: testType,
          apiBase,
          apiKey: selectedType.authType === 'oauth' ? '' : apiKey,
        }),
        signal: AbortSignal.timeout(15000),
      })
      const data = (await res.json()) as TestKeyResult
      if (data.success) {
        setTestResult(data)
        if (data.chatModels?.[0]) setSelectedChatModel(data.chatModels[0])
        if (data.embedModels?.[0]) setSelectedEmbedModel(data.embedModels[0])
        setStep('models')
      } else {
        setTestError(data.error || 'Test failed')
        setStep('config')
      }
    } catch (err) {
      setTestError(String(err))
      setStep('config')
    }
  }

  // Save provider
  const handleSave = async () => {
    setStep('saving')
    try {
      const capabilities = ['chat']
      if (selectedEmbedModel) capabilities.push('embedding')

      const res = await fetch(`${config.api.base}/api/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          type: selectedType.id,
          authType: selectedType.authType,
          apiBase,
          apiKey: selectedType.authType === 'oauth' ? null : apiKey,
          capabilities,
        }),
        signal: AbortSignal.timeout(10000),
      })
      const result = (await res.json()) as { success?: boolean; error?: string }
      if (result.success) {
        onSaved()
      } else {
        setTestError(result.error || 'Failed to save')
        setStep('models')
      }
    } catch (err) {
      setTestError(String(err))
      setStep('models')
    }
  }

  // OAuth flow
  const [oauthUrl, setOauthUrl] = useState('')
  const handleOAuthStart = async () => {
    if (!selectedType.oauthProvider) return
    try {
      const res = await fetch(`${config.api.base}/api/accounts/oauth/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: selectedType.oauthProvider }),
        signal: AbortSignal.timeout(10000),
      })
      const data = (await res.json()) as { success?: boolean; authUrl?: string; error?: string }
      if (data.authUrl) {
        setOauthUrl(data.authUrl)
        window.open(data.authUrl, '_blank', 'width=600,height=700')
      }
    } catch (err) {
      setTestError(String(err))
    }
  }

  // OAuth polling
  const [oauthChecking, setOauthChecking] = useState(false)
  useEffect(() => {
    if (!oauthUrl || oauthChecking || !selectedType.oauthProvider) return
    setOauthChecking(true)
    const provider = selectedType.oauthProvider
    const interval = setInterval(async () => {
      try {
        const res = await fetch(
          `${config.api.base}/api/accounts/oauth/status/${provider}`,
          { signal: AbortSignal.timeout(3000) }
        )
        const data = (await res.json()) as { connected: boolean }
        if (data.connected) {
          clearInterval(interval)
          setOauthChecking(false)
          handleTestKey()
        }
      } catch { /* ignore */ }
    }, 3000)
    return () => { clearInterval(interval); setOauthChecking(false) }
  }, [oauthUrl]) // eslint-disable-line

  const isOAuth = selectedType.authType === 'oauth'

  return (
    <div className={styles.dialogOverlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.dialog}>
        <h3 className={styles.dialogTitle}>
          {step === 'config' && 'Add Provider'}
          {step === 'testing' && '⏳ Testing Connection...'}
          {step === 'models' && '✅ Connected — Select Models'}
          {step === 'saving' && '⏳ Saving...'}
        </h3>

        {step === 'config' && (
          <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: '-0.5rem 0 1rem' }}>
            Configure an LLM provider connection.
          </p>
        )}

        {/* Step 1: Configuration */}
        {(step === 'config' || step === 'testing') && (
          <>
            <div className={styles.dialogField}>
              <label className={styles.dialogLabel}>Provider Type *</label>
              <select
                className={styles.dialogSelect}
                value={selectedType.id}
                onChange={(e) => handleTypeChange(e.target.value)}
                disabled={step === 'testing'}
              >
                <optgroup label="OAuth (CLIProxy)">
                  {PROVIDER_TYPES.filter((t) => t.authType === 'oauth').map((t) => (
                    <option key={t.id} value={t.id}>{t.icon} {t.label}</option>
                  ))}
                </optgroup>
                <optgroup label="API Key">
                  {PROVIDER_TYPES.filter((t) => t.authType === 'api_key').map((t) => (
                    <option key={t.id} value={t.id}>{t.icon} {t.label}</option>
                  ))}
                </optgroup>
              </select>
            </div>

            <div className={styles.dialogField}>
              <label className={styles.dialogLabel}>Display Name</label>
              <input
                className={styles.dialogInput}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. OpenAI (Personal)"
                disabled={step === 'testing'}
              />
            </div>

            {/* OAuth mode */}
            {isOAuth && (
              <>
                {selectedType.description && (
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
                    {selectedType.description}
                  </p>
                )}
                {!oauthUrl ? (
                  <button
                    className="btn btn-primary btn-sm"
                    style={{ width: '100%', marginBottom: '0.75rem' }}
                    onClick={handleOAuthStart}
                    disabled={step === 'testing'}
                  >
                    🔐 Sign in with {selectedType.label.split(' (')[0]}
                  </button>
                ) : (
                  <div style={{ padding: '0.5rem', borderRadius: '8px', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', fontSize: '0.8rem', color: 'var(--accent)', marginBottom: '0.75rem', textAlign: 'center' }}>
                    {oauthChecking ? '⏳ Waiting for OAuth completion...' : '✅ OAuth window opened. Complete login, then click Test.'}
                  </div>
                )}
              </>
            )}

            {/* API Key mode */}
            {!isOAuth && (
              <>
                <div className={styles.dialogField}>
                  <label className={styles.dialogLabel}>API Base URL</label>
                  <input
                    className={styles.dialogInput}
                    value={apiBase}
                    onChange={(e) => setApiBase(e.target.value)}
                    disabled={step === 'testing'}
                  />
                </div>
                <div className={styles.dialogField}>
                  <label className={styles.dialogLabel}>API Key</label>
                  <input
                    className={styles.dialogInput}
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={selectedType.id === 'gemini' ? 'AIza...' : 'sk-...'}
                    disabled={step === 'testing'}
                  />
                </div>
              </>
            )}

            {testError && (
              <div style={{ padding: '0.5rem', borderRadius: '8px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', fontSize: '0.8rem', color: '#ef4444', marginBottom: '0.75rem' }}>
                ❌ {testError}
              </div>
            )}

            <div className={styles.dialogActions}>
              <button className="btn btn-secondary btn-sm" onClick={onClose}>Cancel</button>
              <button
                className="btn btn-primary btn-sm"
                disabled={!name.trim() || step === 'testing' || (!isOAuth && !apiKey.trim())}
                onClick={handleTestKey}
              >
                {step === 'testing' ? '⏳ Testing...' : '🧪 Test Connection'}
              </button>
            </div>
          </>
        )}

        {/* Step 2: Model Selection */}
        {step === 'models' && testResult && (
          <>
            <div style={{ padding: '0.5rem 0.75rem', borderRadius: '8px', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)', fontSize: '0.8rem', color: '#22c55e', marginBottom: '1rem' }}>
              ✅ Connected — {testResult.totalModels} models found ({testResult.latency}ms)
            </div>

            {testResult.chatModels && testResult.chatModels.length > 0 && (
              <div className={styles.dialogField}>
                <label className={styles.dialogLabel}>💬 Chat Model</label>
                <select
                  className={styles.dialogSelect}
                  value={selectedChatModel}
                  onChange={(e) => setSelectedChatModel(e.target.value)}
                >
                  {testResult.chatModels.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
            )}

            {testResult.embedModels && testResult.embedModels.length > 0 && (
              <div className={styles.dialogField}>
                <label className={styles.dialogLabel}>🧠 Embedding Model</label>
                <select
                  className={styles.dialogSelect}
                  value={selectedEmbedModel}
                  onChange={(e) => setSelectedEmbedModel(e.target.value)}
                >
                  <option value="">— Don&apos;t use for embedding —</option>
                  {testResult.embedModels.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
            )}

            {(!testResult.embedModels || testResult.embedModels.length === 0) && (
              <p style={{ fontSize: '0.78rem', color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
                No embedding models available for this provider
              </p>
            )}

            <div className={styles.dialogActions}>
              <button className="btn btn-secondary btn-sm" onClick={() => { setStep('config'); setTestResult(null) }}>
                ← Back
              </button>
              <button className="btn btn-primary btn-sm" onClick={handleSave}>
                Save Provider
              </button>
            </div>
          </>
        )}

        {step === 'saving' && (
          <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
            ⏳ Saving provider...
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main Page ──
export default function ProvidersPage() {
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)

  const { data, error, isLoading, mutate } = useSWR(
    ['provider-accounts', page, search],
    () => fetchAccounts(page, search),
    { refreshInterval: 30000 }
  )

  const showToast = useCallback((type: 'success' | 'error', message: string) => {
    setToast({ type, message })
    setTimeout(() => setToast(null), 4000)
  }, [])

  const handleDelete = useCallback(
    async (id: string, name: string) => {
      if (!confirm(`Delete provider "${name}"?`)) return
      try {
        await fetch(`${config.api.base}/api/accounts/${id}`, {
          method: 'DELETE',
          signal: AbortSignal.timeout(5000),
        })
        showToast('success', `🗑️ Provider "${name}" removed`)
        mutate()
      } catch (err) {
        showToast('error', `❌ ${String(err)}`)
      }
    },
    [mutate, showToast]
  )

  const handleTest = useCallback(
    async (id: string) => {
      setTestingId(id)
      try {
        const res = await fetch(`${config.api.base}/api/accounts/${id}/test`, {
          method: 'POST',
          signal: AbortSignal.timeout(15000),
        })
        const result = (await res.json()) as { success: boolean; totalModels?: number; chatModels?: string[]; embedModels?: string[]; error?: string }
        if (result.success) {
          const parts = []
          if (result.chatModels?.length) parts.push(`${result.chatModels.length} chat`)
          if (result.embedModels?.length) parts.push(`${result.embedModels.length} embed`)
          showToast('success', `✅ Connected — ${parts.join(', ')} models`)
          mutate()
        } else {
          showToast('error', `❌ ${result.error || 'Test failed'}`)
        }
      } catch (err) {
        showToast('error', `❌ ${String(err)}`)
      } finally {
        setTestingId(null)
      }
    },
    [mutate, showToast]
  )

  const handleToggleStatus = useCallback(
    async (id: string, currentStatus: string) => {
      const newStatus = currentStatus === 'enabled' ? 'disabled' : 'enabled'
      try {
        await fetch(`${config.api.base}/api/accounts/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: newStatus }),
          signal: AbortSignal.timeout(5000),
        })
        mutate()
      } catch (err) {
        showToast('error', `❌ ${String(err)}`)
      }
    },
    [mutate, showToast]
  )

  const accounts = data?.accounts ?? []
  const pagination = data?.pagination ?? { page: 1, limit: 20, total: 0, totalPages: 1 }

  return (
    <DashboardLayout title="Providers" subtitle="Manage LLM providers">
      {/* Toast */}
      {toast && (
        <div
          className={styles.toast}
          style={{ borderColor: toast.type === 'success' ? 'var(--success)' : 'var(--danger)' }}
        >
          <span>{toast.message}</span>
          <button className={styles.toastClose} onClick={() => setToast(null)}>×</button>
        </div>
      )}

      {/* Header */}
      <div className={styles.headerRow}>
        <div className={styles.searchWrapper}>
          <span className={styles.searchIcon}>🔍</span>
          <input
            className={styles.searchBar}
            placeholder="Search providers..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1) }}
          />
        </div>
        <div className={styles.headerActions}>
          <button className="btn btn-primary btn-sm" onClick={() => setShowAddDialog(true)}>
            + Add Provider
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => mutate()} disabled={isLoading}>
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className={`card ${styles.errorCard}`}>
          <p>Failed to load providers. Is the backend API running?</p>
          <button className="btn btn-primary btn-sm" onClick={() => mutate()}>Retry</button>
        </div>
      )}

      {/* Table */}
      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>API Base</th>
              <th>API Key</th>
              <th>Capabilities</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && accounts.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-tertiary)' }}>
                  Loading...
                </td>
              </tr>
            ) : accounts.length === 0 ? (
              <tr>
                <td colSpan={7}>
                  <div className={styles.emptyState}>
                    <div className={styles.emptyIcon}>📦</div>
                    <p className={styles.emptyText}>No providers configured yet</p>
                    <button className="btn btn-primary btn-sm" onClick={() => setShowAddDialog(true)}>
                      + Add your first provider
                    </button>
                  </div>
                </td>
              </tr>
            ) : (
              accounts.map((acc) => (
                <tr key={acc.id}>
                  <td>
                    <div className={styles.nameCell}>
                      <span className={styles.nameIcon}>{TYPE_ICONS[acc.type] || '📦'}</span>
                      <div>
                        <div>{acc.name}</div>
                        {acc.auth_type === 'oauth' && (
                          <span style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)' }}>OAuth</span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className={styles.typeBadge}>{TYPE_LABELS[acc.type] || acc.type}</span>
                  </td>
                  <td>
                    <code className={styles.apiBase}>
                      {acc.api_base.length > 30 ? acc.api_base.slice(0, 30) + '...' : acc.api_base}
                    </code>
                  </td>
                  <td>
                    <span className={styles.apiKeyMask}>
                      {acc.auth_type === 'oauth' ? '🔐 OAuth' : acc.api_key ? acc.api_key : '—'}
                    </span>
                  </td>
                  <td>
                    <div className={styles.capChips}>
                      {acc.capabilities.map((cap) => (
                        <span key={cap} className={styles.capChip}>{cap}</span>
                      ))}
                    </div>
                  </td>
                  <td>
                    <StatusBadge status={acc.status} />
                  </td>
                  <td>
                    <div className={styles.actions}>
                      <button
                        className={styles.iconBtn}
                        title="Test Connection"
                        onClick={() => handleTest(acc.id)}
                        disabled={testingId === acc.id}
                      >
                        {testingId === acc.id ? '⏳' : '🧪'}
                      </button>
                      <button
                        className={styles.iconBtn}
                        title={acc.status === 'enabled' ? 'Disable' : 'Enable'}
                        onClick={() => handleToggleStatus(acc.id, acc.status)}
                      >
                        {acc.status === 'enabled' ? '⏸' : '▶'}
                      </button>
                      <button
                        className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                        title="Delete"
                        onClick={() => handleDelete(acc.id, acc.name)}
                      >
                        🗑
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {pagination.total > 0 && (
          <div className={styles.tableFooter}>
            <span>{pagination.total} items</span>
            <div className={styles.pagination}>
              <span>Page {pagination.page} of {pagination.totalPages}</span>
              <button className={styles.pageBtn} disabled={page <= 1} onClick={() => setPage(p => p - 1)}>‹</button>
              <button className={styles.pageBtn} disabled={page >= pagination.totalPages} onClick={() => setPage(p => p + 1)}>›</button>
            </div>
          </div>
        )}
      </div>

      {/* Dialog */}
      {showAddDialog && (
        <AddProviderDialog
          onClose={() => setShowAddDialog(false)}
          onSaved={() => {
            setShowAddDialog(false)
            showToast('success', '✅ Provider added successfully')
            mutate()
          }}
        />
      )}
    </DashboardLayout>
  )
}
