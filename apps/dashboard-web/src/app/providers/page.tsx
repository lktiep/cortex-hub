'use client'

import DashboardLayout from '@/components/layout/DashboardLayout'
import useSWR from 'swr'
import { config } from '@/lib/config'
import styles from './page.module.css'

interface Provider {
  id: string
  name: string
  icon: string
  description: string
  authType: 'oauth' | 'apikey'
  status: 'connected' | 'disconnected' | 'error'
  models: { id: string; owned_by: string }[]
  modelCount: number
  usedBy: string[]
}

async function fetchProviders() {
  const res = await fetch(`${config.api.base}/api/llm/providers`, {
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new Error('Failed to fetch providers')
  return res.json() as Promise<{ providers: Provider[] }>
}

function StatusBadge({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    connected: 'var(--success)',
    disconnected: 'var(--text-tertiary)',
    error: 'var(--danger)',
  }
  return (
    <span
      className={styles.statusBadge}
      style={{ '--badge-color': colorMap[status] || 'var(--text-tertiary)' } as React.CSSProperties}
    >
      <span className={styles.statusDot} />
      {status}
    </span>
  )
}

function ProviderCard({ provider, onReconnect }: { provider: Provider; onReconnect: () => void }) {
  return (
    <div className={`card ${styles.providerCard}`}>
      <div className={styles.providerHeader}>
        <span className={styles.providerIcon}>{provider.icon}</span>
        <div className={styles.providerInfo}>
          <h3 className={styles.providerName}>{provider.name}</h3>
          <p className={styles.providerDesc}>{provider.description}</p>
        </div>
        <StatusBadge status={provider.status} />
      </div>

      {/* Models Section */}
      {provider.status === 'connected' && provider.models.length > 0 && (
        <div className={styles.modelsSection}>
          <h4 className={styles.modelsTitle}>
            Available Models ({provider.modelCount})
          </h4>
          <div className={styles.modelsList}>
            {provider.models.slice(0, 8).map((model) => (
              <span key={model.id} className={styles.modelChip}>
                {model.id}
              </span>
            ))}
            {provider.models.length > 8 && (
              <span className={styles.modelChip} style={{ opacity: 0.6 }}>
                +{provider.models.length - 8} more
              </span>
            )}
          </div>
        </div>
      )}

      {/* Used By Section */}
      {provider.usedBy.length > 0 && (
        <div className={styles.usedBySection}>
          <span className={styles.usedByLabel}>Used by:</span>
          {provider.usedBy.map((service) => (
            <span key={service} className={styles.usedByChip}>
              {service}
            </span>
          ))}
        </div>
      )}

      {/* Actions */}
      <div className={styles.providerActions}>
        {provider.status === 'connected' ? (
          <button className="btn btn-secondary btn-sm">Disconnect</button>
        ) : (
          <button className="btn btn-primary btn-sm" onClick={onReconnect}>
            🔐 Connect
          </button>
        )}
      </div>
    </div>
  )
}

export default function ProvidersPage() {
  const { data, error, isLoading, mutate } = useSWR('llm-providers', fetchProviders, {
    refreshInterval: 30000,
  })

  const handleReconnect = () => {
    // Navigate to setup wizard for re-authentication
    window.location.href = '/setup'
  }

  return (
    <DashboardLayout title="LLM Providers" subtitle="Manage AI provider connections and models">
      {/* Summary Stats */}
      <div className={styles.statsRow}>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statValue}>
            {isLoading ? '...' : data?.providers.filter((p) => p.status === 'connected').length || 0}
          </span>
          <span className={styles.statLabel}>Connected</span>
        </div>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statValue}>
            {isLoading ? '...' : data?.providers.reduce((sum, p) => sum + p.modelCount, 0) || 0}
          </span>
          <span className={styles.statLabel}>Models Available</span>
        </div>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statValue}>
            {isLoading ? '...' : data?.providers.length || 0}
          </span>
          <span className={styles.statLabel}>Providers</span>
        </div>
        <div className={`card ${styles.statCard}`}>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => mutate()}
            disabled={isLoading}
            style={{ width: '100%' }}
          >
            {isLoading ? 'Refreshing...' : '↻ Refresh'}
          </button>
        </div>
      </div>

      {/* Error State */}
      {error && (
        <div className={`card ${styles.errorCard}`}>
          <p>Failed to load providers. Is the backend API running?</p>
          <button className="btn btn-primary btn-sm" onClick={() => mutate()}>
            Retry
          </button>
        </div>
      )}

      {/* Provider Cards */}
      <div className={styles.providersGrid}>
        {isLoading && !data && (
          <>
            {[1, 2, 3].map((i) => (
              <div key={i} className={`card ${styles.providerCard} ${styles.skeleton}`}>
                <div className={styles.skeletonContent} />
              </div>
            ))}
          </>
        )}
        {data?.providers.map((provider) => (
          <ProviderCard key={provider.id} provider={provider} onReconnect={handleReconnect} />
        ))}
      </div>

      {/* Info Section */}
      <section className={styles.infoSection}>
        <h3 className={styles.infoTitle}>How LLM Providers Work</h3>
        <div className={`card ${styles.infoCard}`}>
          <div className={styles.flowDiagram}>
            <span className={styles.flowStep}>Agent / mem0</span>
            <span className={styles.flowArrow}>→</span>
            <span className={styles.flowStep}>CLIProxy :8317</span>
            <span className={styles.flowArrow}>→</span>
            <span className={styles.flowStep}>OpenAI API</span>
          </div>
          <p className={styles.infoText}>
            CLIProxy acts as an OAuth proxy gateway. Agents and services (like mem0) send requests
            to CLIProxy&apos;s OpenAI-compatible API. CLIProxy authenticates using your OAuth tokens
            and forwards requests to the provider.
          </p>
        </div>
      </section>
    </DashboardLayout>
  )
}
