'use client'

import { useState, useMemo } from 'react'
import DashboardLayout from '@/components/layout/DashboardLayout'
import useSWR from 'swr'
import { getQualityLogs, type QueryLog } from '@/lib/api'
import styles from './page.module.css'

// ── Components ──
function StatusBadge({ status }: { status: string }) {
  const variant = status === 'ok' ? 'healthy' : status === 'error' ? 'error' : 'warning'
  return <span className={`badge badge-${variant}`}>{status}</span>
}

function parseParams(params: string | null): { score?: number; details?: string } {
  if (!params) return {}
  try {
    return JSON.parse(params)
  } catch {
    return {}
  }
}

function LogRow({ log }: { log: QueryLog }) {
  const parsed = parseParams(log.params)
  return (
    <tr>
      <td className={styles.cellMono}>{log.agent_id}</td>
      <td>
        <code className={styles.toolName}>{log.tool}</code>
      </td>
      <td className={styles.cellCenter}>
        {parsed.score != null ? (
          <span className={styles.score}>{parsed.score}/100</span>
        ) : (
          <span className={styles.muted}>—</span>
        )}
      </td>
      <td className={styles.cellCenter}>
        {log.latency_ms != null ? (
          <span>{log.latency_ms}ms</span>
        ) : (
          <span className={styles.muted}>—</span>
        )}
      </td>
      <td className={styles.cellCenter}>
        <StatusBadge status={log.status} />
      </td>
      <td className={styles.cellMuted}>
        {log.created_at ? new Date(log.created_at).toLocaleString() : '—'}
      </td>
    </tr>
  )
}

function LatencyBar({ label, value, max }: { label: string; value: number; max: number }) {
  return (
    <div className={styles.latencyBar}>
      <span className={styles.latencyLabel}>{label}</span>
      <div className={styles.latencyTrack}>
        <div
          className={styles.latencyFill}
          style={{ width: `${Math.min((value / max) * 100, 100)}%` }}
        />
      </div>
      <span className={styles.latencyValue}>{value}ms</span>
    </div>
  )
}

export default function QualityPage() {
  const { data, error, isLoading, mutate } = useSWR('quality-logs', () => getQualityLogs(200), {
    refreshInterval: 15000,
  })

  const [filterAgent, setFilterAgent] = useState('')
  const [filterTool, setFilterTool] = useState('')
  const [filterStatus, setFilterStatus] = useState<'all' | 'ok' | 'error'>('all')

  const allLogs = data?.logs ?? []

  // Unique agents and tools for filter dropdowns
  const agents = useMemo(() => [...new Set(allLogs.map((l) => l.agent_id))], [allLogs])
  const tools = useMemo(() => [...new Set(allLogs.map((l) => l.tool))], [allLogs])

  // Filtered logs
  const logs = useMemo(() => {
    return allLogs.filter((l) => {
      if (filterAgent && l.agent_id !== filterAgent) return false
      if (filterTool && l.tool !== filterTool) return false
      if (filterStatus !== 'all' && l.status !== filterStatus) return false
      return true
    })
  }, [allLogs, filterAgent, filterTool, filterStatus])

  // Stats
  const totalLogs = logs.length
  const okCount = logs.filter((l) => l.status === 'ok').length
  const errorCount = logs.filter((l) => l.status === 'error').length
  const successRate = totalLogs > 0 ? Math.round((okCount / totalLogs) * 100) : 0

  // Latency percentiles
  const latencies = useMemo(() => {
    const vals = logs
      .map((l) => l.latency_ms)
      .filter((v): v is number => v != null)
      .sort((a, b) => a - b)
    if (vals.length === 0) return { p50: 0, p95: 0, p99: 0, max: 1 }
    const p = (pct: number) => vals[Math.floor(vals.length * pct)] ?? 0
    return { p50: p(0.5), p95: p(0.95), p99: p(0.99), max: Math.max(vals[vals.length - 1] ?? 1, 1) }
  }, [logs])

  // Score distribution
  const scoreDistribution = useMemo(() => {
    const buckets = [0, 0, 0, 0, 0] // 0-20, 21-40, 41-60, 61-80, 81-100
    logs.forEach((l) => {
      const parsed = parseParams(l.params)
      if (parsed.score != null) {
        const idx = Math.min(Math.floor(parsed.score / 20), 4)
        buckets[idx] = (buckets[idx] ?? 0) + 1
      }
    })
    const max = Math.max(...buckets, 1)
    return buckets.map((count, i) => ({
      label: `${i * 20}-${(i + 1) * 20}`,
      count,
      pct: (count / max) * 100,
    }))
  }, [logs])

  // CSV Export
  function handleExport() {
    const header = 'agent_id,tool,score,latency_ms,status,created_at\n'
    const rows = logs
      .map((l) => {
        const parsed = parseParams(l.params)
        return `${l.agent_id},${l.tool},${parsed.score ?? ''},${l.latency_ms ?? ''},${l.status},${l.created_at ?? ''}`
      })
      .join('\n')
    const blob = new Blob([header + rows], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `quality-logs-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <DashboardLayout title="Quality Gates" subtitle="Agent execution logs and quality metrics">
      {/* Stats */}
      <div className={styles.statsGrid}>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}>📊</span>
          <div>
            <div className={styles.statValue}>{totalLogs}</div>
            <div className={styles.statLabel}>Total Executions</div>
          </div>
        </div>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}>✅</span>
          <div>
            <div className={styles.statValue}>{okCount}</div>
            <div className={styles.statLabel}>Passed</div>
          </div>
        </div>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}>❌</span>
          <div>
            <div className={styles.statValue}>{errorCount}</div>
            <div className={styles.statLabel}>Failed</div>
          </div>
        </div>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}>⚡</span>
          <div>
            <div className={styles.statValue}>{successRate}%</div>
            <div className={styles.statLabel}>Success Rate</div>
          </div>
        </div>
      </div>

      {/* Latency & Score Distribution */}
      <div className={styles.insightsGrid}>
        <div className={`card ${styles.insightCard}`}>
          <h3 className={styles.insightTitle}>Latency Percentiles</h3>
          <LatencyBar label="P50" value={latencies.p50} max={latencies.max} />
          <LatencyBar label="P95" value={latencies.p95} max={latencies.max} />
          <LatencyBar label="P99" value={latencies.p99} max={latencies.max} />
        </div>
        <div className={`card ${styles.insightCard}`}>
          <h3 className={styles.insightTitle}>Score Distribution</h3>
          <div className={styles.distChart}>
            {scoreDistribution.map((bucket) => (
              <div key={bucket.label} className={styles.distBar}>
                <div
                  className={styles.distFill}
                  style={{ height: `${bucket.pct}%` }}
                />
                <span className={styles.distLabel}>{bucket.label}</span>
                <span className={styles.distCount}>{bucket.count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Filters + Logs Table */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Execution Log</h2>
          <div className={styles.headerActions}>
            <button className="btn btn-secondary btn-sm" onClick={handleExport}>
              📥 Export CSV
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => mutate()}
              disabled={isLoading}
            >
              {isLoading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className={styles.filterBar}>
          <select
            className={styles.filterSelect}
            value={filterAgent}
            onChange={(e) => setFilterAgent(e.target.value)}
          >
            <option value="">All Agents</option>
            {agents.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <select
            className={styles.filterSelect}
            value={filterTool}
            onChange={(e) => setFilterTool(e.target.value)}
          >
            <option value="">All Tools</option>
            {tools.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <div className={styles.filterTabs}>
            {(['all', 'ok', 'error'] as const).map((s) => (
              <button
                key={s}
                className={`${styles.filterTab} ${filterStatus === s ? styles.filterTabActive : ''}`}
                onClick={() => setFilterStatus(s)}
              >
                {s === 'all' ? 'All' : s === 'ok' ? '✓ OK' : '✗ Error'}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.tableCard}>
          {error && (
            <div className={styles.errorBanner}>⚠️ Failed to load quality logs</div>
          )}
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Tool / Gate</th>
                <th className={styles.cellCenter}>Score</th>
                <th className={styles.cellCenter}>Latency</th>
                <th className={styles.cellCenter}>Status</th>
                <th>Timestamp</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <LogRow key={log.id} log={log} />
              ))}
              {logs.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={6} className={styles.emptyState}>
                    {allLogs.length > 0
                      ? 'No logs match the current filters.'
                      : 'No quality logs yet. Logs appear when agents report quality gate results via MCP.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </DashboardLayout>
  )
}
