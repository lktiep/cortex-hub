'use client'

import { useMemo } from 'react'
import DashboardLayout from '@/components/layout/DashboardLayout'
import useSWR from 'swr'
import { getQualityLogs } from '@/lib/api'
import styles from './page.module.css'

// ── Types ──
type ModelUsage = {
  model: string
  requests: number
  estimatedTokens: number
  percentage: number
}

type AgentUsage = {
  agent: string
  requests: number
  lastActive: string
}

type DailyPoint = {
  day: string
  count: number
}

// ── Helpers ──
function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toString()
}

function estimateCost(tokens: number): string {
  // Rough estimate: $0.005 per 1K tokens (blended GPT-4o rate)
  const cost = (tokens / 1000) * 0.005
  return cost < 0.01 ? '< $0.01' : `$${cost.toFixed(2)}`
}

export default function UsagePage() {
  // Use quality logs as a proxy for usage data (each log = 1 API call)
  const { data, error, isLoading, mutate } = useSWR('usage-data', () => getQualityLogs(500), {
    refreshInterval: 30000,
  })

  const allLogs = data?.logs ?? []

  // Today's logs
  const today = new Date().toISOString().split('T')[0]
  const todayLogs = allLogs.filter(
    (l) => l.created_at && l.created_at.startsWith(today ?? '')
  )

  // Per-model breakdown (extracted from tool name patterns)
  const modelUsage = useMemo((): ModelUsage[] => {
    const modelMap = new Map<string, number>()
    allLogs.forEach((log) => {
      // Group by tool as proxy for model usage
      const key = log.tool || 'unknown'
      modelMap.set(key, (modelMap.get(key) ?? 0) + 1)
    })
    const total = allLogs.length || 1
    return Array.from(modelMap.entries())
      .map(([model, requests]) => ({
        model,
        requests,
        estimatedTokens: requests * 800, // ~800 tokens per request estimate
        percentage: Math.round((requests / total) * 100),
      }))
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 8)
  }, [allLogs])

  // Per-agent breakdown
  const agentUsage = useMemo((): AgentUsage[] => {
    const agentMap = new Map<string, { count: number; lastActive: string }>()
    allLogs.forEach((log) => {
      const existing = agentMap.get(log.agent_id)
      if (!existing || (log.created_at && log.created_at > existing.lastActive)) {
        agentMap.set(log.agent_id, {
          count: (existing?.count ?? 0) + 1,
          lastActive: log.created_at || '',
        })
      } else {
        existing.count++
      }
    })
    return Array.from(agentMap.entries())
      .map(([agent, data]) => ({
        agent,
        requests: data.count,
        lastActive: data.lastActive,
      }))
      .sort((a, b) => b.requests - a.requests)
  }, [allLogs])

  // 7-day trend
  const dailyTrend = useMemo((): DailyPoint[] => {
    const days: DailyPoint[] = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const dayStr = d.toISOString().split('T')[0] ?? ''
      const count = allLogs.filter(
        (l) => l.created_at && l.created_at.startsWith(dayStr)
      ).length
      days.push({ day: dayStr, count })
    }
    return days
  }, [allLogs])

  const totalRequests = allLogs.length
  const totalTokensEstimate = totalRequests * 800 // rough estimate
  const todayRequests = todayLogs.length
  const maxDaily = Math.max(...dailyTrend.map((d) => d.count), 1)

  return (
    <DashboardLayout title="Usage" subtitle="Token consumption and API request analytics">
      {/* Stats Row */}
      <div className={styles.statsGrid}>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}>📊</span>
          <div>
            <div className={styles.statValue}>{formatNumber(totalRequests)}</div>
            <div className={styles.statLabel}>Total Requests</div>
          </div>
        </div>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}>🔤</span>
          <div>
            <div className={styles.statValue}>{formatNumber(totalTokensEstimate)}</div>
            <div className={styles.statLabel}>Est. Tokens</div>
          </div>
        </div>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}>💰</span>
          <div>
            <div className={styles.statValue}>{estimateCost(totalTokensEstimate)}</div>
            <div className={styles.statLabel}>Est. Cost</div>
          </div>
        </div>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}>📅</span>
          <div>
            <div className={styles.statValue}>{todayRequests}</div>
            <div className={styles.statLabel}>Today</div>
          </div>
        </div>
      </div>

      {/* 7-Day Trend */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>7-Day Trend</h2>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => mutate()}
            disabled={isLoading}
          >
            {isLoading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
        <div className={`card ${styles.trendCard}`}>
          <div className={styles.trendChart}>
            {dailyTrend.map((point) => (
              <div key={point.day} className={styles.trendColumn}>
                <span className={styles.trendCount}>{point.count}</span>
                <div className={styles.trendBarWrapper}>
                  <div
                    className={styles.trendBar}
                    style={{ height: `${(point.count / maxDaily) * 100}%` }}
                  />
                </div>
                <span className={styles.trendDay}>
                  {new Date(point.day + 'T12:00:00').toLocaleDateString('en', { weekday: 'short' })}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Model + Agent Grid */}
      <div className={styles.detailsGrid}>
        {/* By Model/Tool */}
        <div className={`card ${styles.detailCard}`}>
          <h3 className={styles.detailTitle}>Usage by Tool</h3>
          {error && (
            <div className={styles.errorBanner}>⚠️ Failed to load usage data</div>
          )}
          {modelUsage.length === 0 && !isLoading ? (
            <div className={styles.emptyState}>
              No usage data yet. Data appears when agents make API calls.
            </div>
          ) : (
            <div className={styles.modelList}>
              {modelUsage.map((m) => (
                <div key={m.model} className={styles.modelRow}>
                  <div className={styles.modelInfo}>
                    <code className={styles.modelName}>{m.model}</code>
                    <span className={styles.modelRequests}>
                      {m.requests} requests · ~{formatNumber(m.estimatedTokens)} tokens
                    </span>
                  </div>
                  <div className={styles.modelBarWrapper}>
                    <div
                      className={styles.modelBar}
                      style={{ width: `${m.percentage}%` }}
                    />
                  </div>
                  <span className={styles.modelPct}>{m.percentage}%</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* By Agent */}
        <div className={`card ${styles.detailCard}`}>
          <h3 className={styles.detailTitle}>Usage by Agent</h3>
          {agentUsage.length === 0 && !isLoading ? (
            <div className={styles.emptyState}>No agent activity recorded yet.</div>
          ) : (
            <div className={styles.agentList}>
              {agentUsage.map((a) => (
                <div key={a.agent} className={styles.agentRow}>
                  <div className={styles.agentInfo}>
                    <code className={styles.agentName}>{a.agent}</code>
                    <span className={styles.agentMeta}>
                      {a.requests} requests
                      {a.lastActive && (
                        <> · Last: {new Date(a.lastActive).toLocaleDateString()}</>
                      )}
                    </span>
                  </div>
                  <span className={styles.agentCount}>
                    {formatNumber(a.requests)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Info Banner */}
      <div className={`card ${styles.infoCard}`}>
        <span className={styles.infoIcon}>💡</span>
        <div className={styles.infoContent}>
          <strong>Usage estimates</strong> are based on quality log data. For accurate token tracking,
          the backend needs to be deployed with the <code>/api/usage</code> endpoints that parse
          CLIProxy response headers.
        </div>
      </div>
    </DashboardLayout>
  )
}
