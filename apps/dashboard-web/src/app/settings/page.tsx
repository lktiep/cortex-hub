'use client'

import { useState, useEffect } from 'react'
import DashboardLayout from '@/components/layout/DashboardLayout'
import useSWR from 'swr'
import {
  getSettings,
  getHubConfig,
  updateHubConfig,
  getNotificationPreferences,
  updateNotificationPreferences,
  getSystemInfo,
  restartService,
} from '@/lib/api'
import { config, getExternalUrl } from '@/lib/config'
import { Bot, Radio, Package, CheckCircle, XCircle, AlertTriangle, RefreshCw, Hourglass, Dna, type LucideIcon, ICON_INLINE } from '@/lib/icons'
import styles from './page.module.css'

// ── Types ──
type ServiceRowProps = {
  name: string
  url: string
  icon: LucideIcon
}

type DockerServiceProps = {
  containerName: string
  label: string
  icon: LucideIcon
}

// ── Components ──
function ServiceRow({ name, url, icon: Icon }: ServiceRowProps) {
  return (
    <div className={styles.serviceRow}>
      <span className={styles.serviceIcon}><Icon {...ICON_INLINE} /></span>
      <div className={styles.serviceInfo}>
        <span className={styles.serviceName}>{name}</span>
        <code className={styles.serviceUrl}>{url}</code>
      </div>
      <span className={`badge badge-healthy`}>configured</span>
    </div>
  )
}

function ConfirmDialog({
  title,
  message,
  confirmText,
  onConfirm,
  onCancel,
}: {
  title: string
  message: string
  confirmText: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const [input, setInput] = useState('')
  const isConfirmed = input === 'CONFIRM'

  return (
    <div className={styles.dialogOverlay}>
      <div className={styles.dialog}>
        <h3 className={styles.dialogTitle}>{title}</h3>
        <p className={styles.dialogMessage}>{message}</p>
        <div className={styles.dialogInput}>
          <label className={styles.dialogLabel}>
            Type <strong>CONFIRM</strong> to proceed:
          </label>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className={styles.confirmInput}
            placeholder="CONFIRM"
            autoFocus
          />
        </div>
        <div className={styles.dialogActions}>
          <button className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={onConfirm}
            disabled={!isConfirmed}
            style={{
              background: isConfirmed ? 'var(--danger)' : undefined,
              borderColor: isConfirmed ? 'var(--danger)' : undefined,
              opacity: isConfirmed ? 1 : 0.5,
            }}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h ${mins}m`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`
  return `${bytes} B`
}

const SERVICE_ICONS: Record<string, LucideIcon> = {
  cliproxy: Bot,
  qdrant: Dna,
  gitnexus: Dna,
  dashboardApi: Radio,
}

const SERVICE_LABELS: Record<string, string> = {
  cliproxy: 'CLIProxy (LLM Gateway)',
  qdrant: 'Qdrant Vector DB',
  gitnexus: 'GitNexus (Code Intelligence)',
  dashboardApi: 'Dashboard API',
}

const NOTIFICATION_LABELS: Record<string, { label: string; description: string }> = {
  agent_disconnect: {
    label: 'Agent Disconnect',
    description: 'Alert when a connected agent goes offline unexpectedly',
  },
  quality_gate_failure: {
    label: 'Quality Gate Failure',
    description: 'Alert when a quality gate check fails (grade D or below)',
  },
  task_assignment: {
    label: 'Task Assignment',
    description: 'Alert when a new task is assigned to an agent',
  },
  session_handoff: {
    label: 'Session Handoff',
    description: 'Alert when a session is handed off between agents',
  },
}

export default function SettingsPage() {
  const { data, error, isLoading } = useSWR('settings', getSettings)
  const { data: hubConfig, mutate: mutateHubConfig } = useSWR('hub-config', getHubConfig)
  const { data: notifPrefs, mutate: mutateNotifPrefs } = useSWR('notif-prefs', getNotificationPreferences)
  const { data: systemInfo } = useSWR('system-info', getSystemInfo, { refreshInterval: 30000 })

  // Dynamic endpoints state to resolve Tailscale/localhost/custom domains
  const [endpoints, setEndpoints] = useState({
    dashboard: 'http://localhost:3000',
    api: 'http://localhost:4000',
    mcp: 'http://localhost:8318',
    llmProxy: 'http://localhost:8317',
  })

  useEffect(() => {
    const dashboard = data?.externalUrls?.dashboard || getExternalUrl('dashboard')
    const api = data?.externalUrls?.api || getExternalUrl('api')
    const mcp = data?.externalUrls?.mcp || getExternalUrl('mcp')
    const llmProxy = data?.externalUrls?.llmProxy || getExternalUrl('cliproxy')
    setEndpoints({ dashboard, api, mcp, llmProxy })
  }, [data])

  const formatLinkText = (url: string) => {
    try {
      const u = new URL(url)
      return u.host
    } catch {
      return url.replace(/^https?:\/\//, '')
    }
  }

  const [showResetDialog, setShowResetDialog] = useState(false)
  const [showClearDialog, setShowClearDialog] = useState(false)
  const [restartingService, setRestartingService] = useState<string | null>(null)
  const [actionStatus, setActionStatus] = useState<{
    type: 'success' | 'error'
    message: string
  } | null>(null)

  // Interface settings state
  const [showConductor, setShowConductor] = useState(true)

  useEffect(() => {
    const val = localStorage.getItem('cortex-show-conductor')
    if (val !== null) {
      setShowConductor(val === 'true')
    }
  }, [])

  const handleToggleConductor = (enabled: boolean) => {
    setShowConductor(enabled)
    localStorage.setItem('cortex-show-conductor', String(enabled))
    window.dispatchEvent(new Event('cortex-config-changed'))
  }

  // Hub config form state
  const [hubName, setHubName] = useState('')
  const [hubDescription, setHubDescription] = useState('')
  const [hubSaving, setHubSaving] = useState(false)
  const [hubDirty, setHubDirty] = useState(false)

  // Sync hub config from API
  useEffect(() => {
    if (hubConfig) {
      setHubName(hubConfig.hub_name ?? 'Cortex Hub')
      setHubDescription(hubConfig.hub_description ?? '')
      setHubDirty(false)
    }
  }, [hubConfig])

  const dockerServices: DockerServiceProps[] = [
    { containerName: 'cortex-llm-proxy', label: 'CLIProxy (LLM)', icon: Bot },
    { containerName: 'cortex-qdrant', label: 'Qdrant Vector DB', icon: Dna },
    { containerName: 'cortex-gitnexus', label: 'GitNexus (Code Intelligence)', icon: Dna },
  ]

  async function handleSaveHubConfig() {
    setHubSaving(true)
    try {
      await updateHubConfig({ hub_name: hubName, hub_description: hubDescription })
      await mutateHubConfig()
      setHubDirty(false)
      setActionStatus({ type: 'success', message: 'Hub configuration saved.' })
    } catch (err) {
      setActionStatus({ type: 'error', message: `Save failed: ${err instanceof Error ? err.message : String(err)}` })
    } finally {
      setHubSaving(false)
    }
  }

  async function handleToggleNotification(key: string, enabled: boolean) {
    try {
      await updateNotificationPreferences({ [key]: enabled })
      await mutateNotifPrefs()
    } catch (err) {
      setActionStatus({ type: 'error', message: `Failed to update: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  async function handleRestart(containerName: string) {
    setRestartingService(containerName)
    try {
      const result = await restartService(containerName)
      setActionStatus({ type: 'success', message: result.message })
    } catch (err) {
      setActionStatus({ type: 'error', message: `Restart failed: ${err instanceof Error ? err.message : String(err)}` })
    } finally {
      setRestartingService(null)
    }
  }

  async function handleResetSetup() {
    setShowResetDialog(false)
    try {
      const res = await fetch(`${config.api.base}/api/setup/reset`, {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) throw new Error('Reset failed')
      localStorage.removeItem('cortex_setup_completed')
      setActionStatus({ type: 'success', message: 'Setup reset. Redirecting to setup wizard...' })
      setTimeout(() => (window.location.href = '/setup'), 1500)
    } catch (err) {
      setActionStatus({
        type: 'error',
        message: `Reset failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      })
    }
  }

  async function handleClearData() {
    setShowClearDialog(false)
    try {
      const res = await fetch(`${config.api.base}/api/setup/clear-data`, {
        method: 'POST',
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) throw new Error('Clear data failed')
      setActionStatus({ type: 'success', message: 'All data cleared successfully.' })
    } catch (err) {
      setActionStatus({
        type: 'error',
        message: `Clear failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      })
    }
  }

  return (
    <DashboardLayout title="Settings" subtitle="Hub configuration, notifications, and system info">
      {/* Action Status Toast */}
      {actionStatus && (
        <div
          className={styles.toast}
          style={{
            borderColor:
              actionStatus.type === 'success' ? 'var(--success)' : 'var(--danger)',
          }}
        >
          <span>
            {actionStatus.type === 'success' ? <CheckCircle {...ICON_INLINE} /> : <XCircle {...ICON_INLINE} />} {actionStatus.message}
          </span>
          <button
            className={styles.toastClose}
            onClick={() => setActionStatus(null)}
          >
            ×
          </button>
        </div>
      )}

      {/* Hub Configuration */}
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Hub Configuration</h2>
        <div className={`card ${styles.hubConfigCard}`}>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Hub Name</label>
            <input
              type="text"
              className={styles.formInput}
              value={hubName}
              onChange={(e) => { setHubName(e.target.value); setHubDirty(true) }}
              placeholder="Cortex Hub"
              maxLength={100}
            />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Description</label>
            <textarea
              className={styles.formTextarea}
              value={hubDescription}
              onChange={(e) => { setHubDescription(e.target.value); setHubDirty(true) }}
              placeholder="A brief description of this hub instance"
              rows={3}
              maxLength={500}
            />
          </div>
          <div className={styles.formActions}>
            <button
              className="btn btn-primary"
              onClick={handleSaveHubConfig}
              disabled={!hubDirty || hubSaving}
            >
              {hubSaving ? 'Saving...' : 'Save Changes'}
            </button>
            {hubDirty && (
              <span className={styles.unsavedHint}>Unsaved changes</span>
            )}
          </div>
        </div>
      </div>

      {/* Notification Preferences */}
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Notification Preferences</h2>
        <div className={`card ${styles.notificationsCard}`}>
          {Object.entries(NOTIFICATION_LABELS).map(([key, { label, description }]) => (
            <div key={key} className={styles.notifRow}>
              <div className={styles.notifInfo}>
                <span className={styles.notifLabel}>{label}</span>
                <span className={styles.notifDesc}>{description}</span>
              </div>
              <label className={styles.toggle}>
                <input
                  type="checkbox"
                  checked={notifPrefs?.[key] ?? true}
                  onChange={(e) => handleToggleNotification(key, e.target.checked)}
                />
                <span className={styles.toggleSlider} />
              </label>
            </div>
          ))}
        </div>
      </div>

      {/* Interface Settings */}
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Interface Settings</h2>
        <div className={`card ${styles.notificationsCard}`}>
          <div className={styles.notifRow}>
            <div className={styles.notifInfo}>
              <span className={styles.notifLabel}>Conductor &amp; Sessions</span>
              <span className={styles.notifDesc}>Show Conductor task wizard and multi-agent Session handoffs in the sidebar</span>
            </div>
            <label className={styles.toggle}>
              <input
                type="checkbox"
                checked={showConductor}
                onChange={(e) => handleToggleConductor(e.target.checked)}
              />
              <span className={styles.toggleSlider} />
            </label>
          </div>
        </div>
      </div>

      {/* System Info */}
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>System Info</h2>
        <div className={`card ${styles.systemInfoCard}`}>
          <div className={styles.systemGrid}>
            <div className={styles.systemItem}>
              <span className={styles.systemLabel}>Hostname</span>
              <code className={styles.systemValue}>{systemInfo?.hostname ?? '...'}</code>
            </div>
            <div className={styles.systemItem}>
              <span className={styles.systemLabel}>Platform</span>
              <code className={styles.systemValue}>{systemInfo ? `${systemInfo.platform} (${systemInfo.arch})` : '...'}</code>
            </div>
            <div className={styles.systemItem}>
              <span className={styles.systemLabel}>Node.js</span>
              <code className={styles.systemValue}>{systemInfo?.nodeVersion ?? '...'}</code>
            </div>
            <div className={styles.systemItem}>
              <span className={styles.systemLabel}>System Uptime</span>
              <code className={styles.systemValue}>{systemInfo ? formatUptime(systemInfo.uptime) : '...'}</code>
            </div>
            <div className={styles.systemItem}>
              <span className={styles.systemLabel}>Process Uptime</span>
              <code className={styles.systemValue}>{systemInfo ? formatUptime(systemInfo.processUptime) : '...'}</code>
            </div>
            <div className={styles.systemItem}>
              <span className={styles.systemLabel}>CPU Cores</span>
              <code className={styles.systemValue}>{systemInfo?.cpuCores ?? '...'}</code>
            </div>
            <div className={styles.systemItem}>
              <span className={styles.systemLabel}>Memory</span>
              <code className={styles.systemValue}>
                {systemInfo ? `${formatBytes(systemInfo.memory.used)} / ${formatBytes(systemInfo.memory.total)} (${systemInfo.memory.percent}%)` : '...'}
              </code>
            </div>
            <div className={styles.systemItem}>
              <span className={styles.systemLabel}>Load Average</span>
              <code className={styles.systemValue}>{systemInfo?.loadAvg?.join(', ') ?? '...'}</code>
            </div>
          </div>
        </div>
      </div>

      {/* Environment Info */}
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Environment</h2>
        <div className={`card ${styles.envCard}`}>
          <div className={styles.envGrid}>
            <div className={styles.envItem}>
              <span className={styles.envLabel}>Mode</span>
              <span
                className={`badge ${data?.environment === 'production' ? 'badge-healthy' : 'badge-warning'}`}
              >
                {isLoading ? '...' : data?.environment ?? 'unknown'}
              </span>
            </div>
            <div className={styles.envItem}>
              <span className={styles.envLabel}>Version</span>
              <code className={styles.envValue}>{data?.version ?? '...'}</code>
            </div>
            <div className={styles.envItem}>
              <span className={styles.envLabel}>Database</span>
              <code className={styles.envValue}>{data?.database ?? '...'}</code>
            </div>
          </div>
        </div>
      </div>

      {/* Tunnel & Endpoints */}
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Endpoints & Remote Access</h2>
        <div className={`card ${styles.tunnelCard}`}>
          <div className={styles.tunnelGrid}>
            <div className={styles.tunnelItem}>
              <span className={styles.tunnelLabel}>Dashboard</span>
              <a
                href={endpoints.dashboard}
                target="_blank"
                rel="noreferrer"
                className={styles.tunnelLink}
              >
                {formatLinkText(endpoints.dashboard)}
              </a>
            </div>
            <div className={styles.tunnelItem}>
              <span className={styles.tunnelLabel}>API</span>
              <a
                href={endpoints.api}
                target="_blank"
                rel="noreferrer"
                className={styles.tunnelLink}
              >
                {formatLinkText(endpoints.api)}
              </a>
            </div>
            <div className={styles.tunnelItem}>
              <span className={styles.tunnelLabel}>MCP</span>
              <a
                href={endpoints.mcp}
                target="_blank"
                rel="noreferrer"
                className={styles.tunnelLink}
              >
                {formatLinkText(endpoints.mcp)}
              </a>
            </div>
            <div className={styles.tunnelItem}>
              <span className={styles.tunnelLabel}>LLM Proxy</span>
              <a
                href={endpoints.llmProxy}
                target="_blank"
                rel="noreferrer"
                className={styles.tunnelLink}
              >
                {formatLinkText(endpoints.llmProxy)}
              </a>
            </div>
          </div>
        </div>
      </div>

      {/* Service Endpoints */}
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Service Endpoints</h2>
        <div className={`card ${styles.servicesCard}`}>
          {error && (
            <div className={styles.errorBanner}>
              <AlertTriangle {...ICON_INLINE} /> Failed to load settings. Is the API running?
            </div>
          )}
          {isLoading && !data ? (
            <div className={styles.loading}>Loading configuration…</div>
          ) : data?.services ? (
            Object.entries(data.services).map(([key, url]) => (
              <ServiceRow
                key={key}
                name={SERVICE_LABELS[key] ?? key}
                url={url}
                icon={SERVICE_ICONS[key] ?? Package}
              />
            ))
          ) : null}
        </div>
      </div>

      {/* Docker Services */}
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Docker Services</h2>
        <div className={`card ${styles.servicesCard}`}>
          {dockerServices.map((svc) => {
            const SvcIcon = svc.icon
            return (
            <div key={svc.containerName} className={styles.serviceRow}>
              <span className={styles.serviceIcon}><SvcIcon {...ICON_INLINE} /></span>
              <div className={styles.serviceInfo}>
                <span className={styles.serviceName}>{svc.label}</span>
                <code className={styles.serviceUrl}>{svc.containerName}</code>
              </div>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => handleRestart(svc.containerName)}
                disabled={restartingService === svc.containerName}
              >
                {restartingService === svc.containerName ? <><Hourglass {...ICON_INLINE} /> Restarting...</> : <><RefreshCw {...ICON_INLINE} /> Restart</>}
              </button>
            </div>
            )
          })}
        </div>
      </div>

      {/* MCP Connection */}
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>MCP Agent Config</h2>
        <div className={`card ${styles.codeCard}`}>
          <p className={styles.codeHint}>
            Copy this snippet into your AI agent&apos;s MCP client configuration:
          </p>
          <pre className={styles.codeBlock}>
{`{
  "mcpServers": {
    "cortex-hub": {
      "url": "${endpoints.mcp.endsWith('/mcp') ? endpoints.mcp : `${endpoints.mcp}/mcp`}",
      "headers": {
        "Authorization": "Bearer <your-api-key>"
      }
    }
  }
}`}
          </pre>
        </div>
      </div>

      {/* Danger Zone */}
      <div className={styles.section}>
        <h2 className={styles.sectionTitle} style={{ color: 'var(--danger)' }}>
          <AlertTriangle {...ICON_INLINE} /> Danger Zone
        </h2>
        <div className={`card ${styles.dangerCard}`}>
          <div className={styles.dangerRow}>
            <div className={styles.dangerInfo}>
              <h4 className={styles.dangerLabel}>Reset Setup Wizard</h4>
              <p className={styles.dangerDesc}>
                Go back through the setup wizard to reconfigure your LLM provider.
                Your API keys and data are preserved.
              </p>
            </div>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setShowResetDialog(true)}
              style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
            >
              Reset Setup
            </button>
          </div>
          <div className={styles.dangerRow}>
            <div className={styles.dangerInfo}>
              <h4 className={styles.dangerLabel}>Clear All Data</h4>
              <p className={styles.dangerDesc}>
                Delete all quality logs, session handoffs, and cached data.
                API keys and provider configuration are kept.
              </p>
            </div>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setShowClearDialog(true)}
              style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
            >
              Clear Data
            </button>
          </div>
        </div>
      </div>

      {/* About */}
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>About</h2>
        <div className={`card ${styles.aboutCard}`}>
          <div className={styles.aboutBrand}>
            <span className={styles.aboutLogo}>◇</span>
            <div>
              <h3 className={styles.aboutName}>Cortex Hub</h3>
              <span className={styles.aboutVersion}>
                v{data?.version ?? '0.1.0'} · Self-hosted MCP Intelligence Platform
              </span>
            </div>
          </div>
          <div className={styles.aboutLinks}>
            <a href="https://github.com/DuyPrX/cortex-hub" target="_blank" rel="noreferrer" className={styles.aboutLink}>
              GitHub
            </a>
            <a href="/docs" className={styles.aboutLink}>
              Documentation
            </a>
            <a href={endpoints.dashboard} className={styles.aboutLink}>
              Dashboard
            </a>
          </div>
        </div>
      </div>

      {/* Dialogs */}
      {showResetDialog && (
        <ConfirmDialog
          title="Reset Setup Wizard"
          message="This will reset the setup wizard so you can reconfigure your LLM provider. Your API keys and data will be preserved."
          confirmText="Reset Setup"
          onConfirm={handleResetSetup}
          onCancel={() => setShowResetDialog(false)}
        />
      )}
      {showClearDialog && (
        <ConfirmDialog
          title="Clear All Data"
          message="This will permanently delete all quality logs, session handoffs, and cached data. This action cannot be undone."
          confirmText="Clear All Data"
          onConfirm={handleClearData}
          onCancel={() => setShowClearDialog(false)}
        />
      )}
    </DashboardLayout>
  )
}
