'use client'

import { useState } from 'react'
import DashboardLayout from '@/components/layout/DashboardLayout'
import useSWR from 'swr'
import {
  getUsageSummary,
  getUsageByModel,
  getUsageByAgent,
  getUsageHistory,
  getBudget,
  setBudget,
  getToolStats,
} from '@/lib/api'
import styles from './page.module.css'

// ── Helpers ──
function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toString()
}

// ── Budget Alert Component ──
function BudgetAlert() {
  const { data: budget, mutate } = useSWR('budget', getBudget, { refreshInterval: 60000 })
  const [showConfig, setShowConfig] = useState(false)
  const [dailyLimit, setDailyLimit] = useState('')
  const [monthlyLimit, setMonthlyLimit] = useState('')

  if (!budget) return null

  const hasAlerts = budget.dailyAlert || budget.monthlyAlert
  const hasLimits = budget.daily_limit > 0 || budget.monthly_limit > 0

  async function handleSave() {
    await setBudget({
      dailyLimit: Number(dailyLimit) || 0,
      monthlyLimit: Number(monthlyLimit) || 0,
    })
    mutate()
    setShowConfig(false)
  }

  return (
    <>
      {hasAlerts && (
        <div className={styles.budgetAlert}>
          <span>⚠️</span>
          <div>
            {budget.dailyAlert && (
              <p>Daily token usage at {formatNumber(budget.dailyUsed)}/{formatNumber(budget.daily_limit)} ({Math.round(budget.dailyUsed / budget.daily_limit * 100)}%)</p>
            )}
            {budget.monthlyAlert && (
              <p>Monthly token usage at {formatNumber(budget.monthlyUsed)}/{formatNumber(budget.monthly_limit)} ({Math.round(budget.monthlyUsed / budget.monthly_limit * 100)}%)</p>
            )}
          </div>
        </div>
      )}
      <div className={styles.budgetRow}>
        {hasLimits && (
          <div className={styles.budgetBars}>
            {budget.daily_limit > 0 && (
              <div className={styles.budgetBarGroup}>
                <span className={styles.budgetLabel}>Daily: {formatNumber(budget.dailyUsed)} / {formatNumber(budget.daily_limit)}</span>
                <div className={styles.budgetTrack}>
                  <div
                    className={styles.budgetFill}
                    style={{
                      width: `${Math.min(100, (budget.dailyUsed / budget.daily_limit) * 100)}%`,
                      background: budget.dailyAlert ? 'var(--danger)' : 'var(--primary)',
                    }}
                  />
                </div>
              </div>
            )}
            {budget.monthly_limit > 0 && (
              <div className={styles.budgetBarGroup}>
                <span className={styles.budgetLabel}>Monthly: {formatNumber(budget.monthlyUsed)} / {formatNumber(budget.monthly_limit)}</span>
                <div className={styles.budgetTrack}>
                  <div
                    className={styles.budgetFill}
                    style={{
                      width: `${Math.min(100, (budget.monthlyUsed / budget.monthly_limit) * 100)}%`,
                      background: budget.monthlyAlert ? 'var(--danger)' : 'var(--primary)',
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        )}
        <button className="btn btn-secondary btn-sm" onClick={() => {
          setDailyLimit(String(budget.daily_limit || ''))
          setMonthlyLimit(String(budget.monthly_limit || ''))
          setShowConfig(true)
        }}>
          ⚙️ Budget Settings
        </button>
      </div>

      {showConfig && (
        <div className={styles.budgetDialog}>
          <div className={styles.budgetDialogInner}>
            <h3>Token Budget Settings</h3>
            <label>Daily Limit (tokens, 0 = unlimited)</label>
            <input type="number" value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} className={styles.budgetInput} placeholder="e.g. 100000" />
            <label>Monthly Limit (tokens, 0 = unlimited)</label>
            <input type="number" value={monthlyLimit} onChange={(e) => setMonthlyLimit(e.target.value)} className={styles.budgetInput} placeholder="e.g. 1000000" />
            <div className={styles.budgetActions}>
              <button className="btn btn-secondary btn-sm" onClick={() => setShowConfig(false)}>Cancel</button>
              <button className="btn btn-primary btn-sm" onClick={handleSave}>Save</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ── Cortex Tool Savings Component ──
function CortexSavingsSection() {
  const { data: toolStats } = useSWR('tool-stats', () => getToolStats(7), { refreshInterval: 30000 })

  if (!toolStats) return null

  const { summary, tools } = toolStats

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>💎 Cortex Tool Savings (7 days)</h2>
      </div>
      <div className={styles.statsGrid}>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}>💎</span>
          <div>
            <div className={styles.statValue} style={{ color: '#22c55e' }}>{formatNumber(summary.estimatedTokensSaved)}</div>
            <div className={styles.statLabel}>Tokens Saved</div>
          </div>
        </div>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}>🔥</span>
          <div>
            <div className={styles.statValue} style={{ color: '#ef4444' }}>{formatNumber(summary.totalComputeTokens || 0)}</div>
            <div className={styles.statLabel}>Compute Cost</div>
          </div>
        </div>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}>🔧</span>
          <div>
            <div className={styles.statValue}>{formatNumber(summary.totalCalls)}</div>
            <div className={styles.statLabel}>Tool Calls</div>
          </div>
        </div>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}>🤖</span>
          <div>
            <div className={styles.statValue}>{summary.activeAgents}</div>
            <div className={styles.statLabel}>Active Agents</div>
          </div>
        </div>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}>✅</span>
          <div>
            <div className={styles.statValue}>{summary.overallSuccessRate}%</div>
            <div className={styles.statLabel}>Success Rate</div>
          </div>
        </div>
      </div>

      {/* Per-tool breakdown */}
      {tools.length > 0 && (
        <div className={`card ${styles.savingsTable}`}>
          <div className={styles.savingsTableHeader} style={{ gridTemplateColumns: 'minmax(120px, 1fr) 0.8fr 1.2fr 1.2fr 1fr 1fr' }}>
            <span>Tool</span>
            <span>Calls</span>
            <span>Tokens Saved</span>
            <span>Compute</span>
            <span>Latency</span>
            <span>Success</span>
          </div>
          {tools.filter(t => !t.tool.includes('session') && !t.tool.includes('Gate')).slice(0, 12).map((t) => (
            <div key={t.tool} className={styles.savingsTableRow} style={{ gridTemplateColumns: 'minmax(120px, 1fr) 0.8fr 1.2fr 1.2fr 1fr 1fr' }}>
              <code className={styles.savingsToolName}>{t.tool.replace('cortex_', '')}</code>
              <span>{t.totalCalls}</span>
              <span style={{ color: '#22c55e', fontWeight: 600 }}>{formatNumber(t.estimatedTokensSaved)}</span>
              <span style={{ color: (t.computeTokens || 0) > 0 ? '#ef4444' : 'inherit', fontWeight: (t.computeTokens || 0) > 0 ? 600 : 400 }}>{formatNumber(t.computeTokens || 0)}</span>
              <span>{t.avgLatencyMs ? `${t.avgLatencyMs}ms` : '—'}</span>
              <span>{t.successRate}%</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function UsagePage() {
  const { data: summary, isLoading: summaryLoading, mutate: mutateSummary } = useSWR('usage-summary', getUsageSummary, {
    refreshInterval: 30000,
  })
  const { data: byModel, mutate: mutateModel } = useSWR('usage-by-model', getUsageByModel, {
    refreshInterval: 30000,
  })
  const { data: byAgent, mutate: mutateAgent } = useSWR('usage-by-agent', getUsageByAgent, {
    refreshInterval: 30000,
  })
  const { data: historyData, mutate: mutateHistory } = useSWR('usage-history', () => getUsageHistory(90), {
    refreshInterval: 30000,
  })

  const totalRequests = summary?.totalRequests ?? 0
  const totalTokens = summary?.totalTokens ?? 0
  const todayRequests = summary?.todayRequests ?? 0
  const estimatedCost = summary?.estimatedCost ?? 0
  const models = byModel?.models ?? []
  const agents = byAgent?.agents ?? []
  const history = historyData?.history ?? []

  // Pad history to 90 days for heatmap
  const heatmapTrend = (() => {
    const dayMap = new Map(history.map((h) => [h.day, h]))
    const days: { day: string; dateObj: Date; requests: number; tokens: number }[] = []
    for (let i = 89; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const dayStr = d.toISOString().split('T')[0] ?? ''
      const existing = dayMap.get(dayStr)
      days.push({ day: dayStr, dateObj: d, requests: existing?.requests ?? 0, tokens: existing?.tokens ?? 0 })
    }
    return days
  })()

  const dailyTrend14 = heatmapTrend.slice(-14)
  const maxDaily14 = Math.max(...dailyTrend14.map((d) => d.requests), 1)
  const totalModelRequests = models.reduce((s, m) => s + m.requests, 0) || 1

  // Heatmap columns (weeks)
  const maxHeatmapDaily = Math.max(...heatmapTrend.map(d => d.requests), 1)
  const heatmapCols: typeof heatmapTrend[] = []
  for (let i = 0; i < heatmapTrend.length; i += 7) {
    heatmapCols.push(heatmapTrend.slice(i, i + 7))
  }

  function getHeatmapLevel(val: number, max: number) {
    if (val === 0) return 0
    const pct = val / max
    if (pct < 0.25) return 1
    if (pct < 0.5) return 2
    if (pct < 0.75) return 3
    return 4
  }

  function refreshAll() {
    mutateSummary()
    mutateModel()
    mutateAgent()
    mutateHistory()
  }

  return (
    <DashboardLayout title="Usage" subtitle="Token consumption and API request analytics">
      {/* Budget Alert */}
      <BudgetAlert />

      {/* Cortex Tool Savings */}
      <CortexSavingsSection />

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
            <div className={styles.statValue}>{formatNumber(totalTokens)}</div>
            <div className={styles.statLabel}>Total Tokens</div>
          </div>
        </div>
        <div className={`card ${styles.statCard}`}>
          <span className={styles.statIcon}>💰</span>
          <div>
            <div className={styles.statValue}>${estimatedCost.toFixed(2)}</div>
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

      {/* Trend & Heatmap */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Activity Trends</h2>
          <button
            className="btn btn-secondary btn-sm"
            onClick={refreshAll}
            disabled={summaryLoading}
          >
            {summaryLoading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
        
        <div className={`card ${styles.trendCard}`}>
          {/* 14-Day Bar Chart */}
          <div className={styles.trendChart}>
            {dailyTrend14.map((point) => (
              <div key={point.day} className={styles.trendColumn}>
                <span className={styles.trendCount}>{point.requests > 0 ? point.requests : ''}</span>
                <div className={styles.trendBarWrapper}>
                  <div
                    className={styles.trendBar}
                    style={{ height: `${Math.max((point.requests / maxDaily14) * 100, 2)}%` }}
                  />
                </div>
                <span className={styles.trendDay}>
                  {new Date(point.day + 'T12:00:00').toLocaleDateString('en', { weekday: 'narrow' })}
                </span>
                <div className={styles.heatmapTooltip}>
                  <strong>{point.day}</strong>
                  <br />
                  {point.requests} requests ({formatNumber(point.tokens)} tokens)
                </div>
              </div>
            ))}
          </div>

          {/* 90-Day Heatmap Calendar */}
          <div className={styles.heatmapContainer}>
            <div className={styles.heatmapHeader}>
              <h3 className={styles.heatmapTitle}>90-Day History</h3>
              <div className={styles.heatmapLegend}>
                Less
                {[0,1,2,3,4].map(level => (
                  <div key={level} className={`${styles.heatmapCell} ${styles.heatmapLegendCell} ${styles['heatmapLevel' + level]}`} />
                ))}
                More
              </div>
            </div>
            <div className={styles.heatmapGridWrapper}>
              <div className={styles.heatmapGrid}>
                {heatmapCols.map((col, cIdx) => (
                  <div key={cIdx} className={styles.heatmapCol}>
                    {col.map((cell) => {
                      const level = getHeatmapLevel(cell.requests, maxHeatmapDaily)
                      return (
                        <div key={cell.day} className={`${styles.heatmapCell} ${styles['heatmapLevel' + level]}`}>
                          <div className={styles.heatmapTooltip}>
                            <strong>{new Date(cell.day + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</strong>
                            <br />
                            {cell.requests} requests ({formatNumber(cell.tokens)} tokens)
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Model + Agent Grid */}
      <div className={styles.detailsGrid}>
        {/* By Model */}
        <div className={`card ${styles.detailCard}`}>
          <h3 className={styles.detailTitle}>Usage by Model</h3>
          {models.length === 0 && !summaryLoading ? (
            <div className={styles.emptyState}>
              No usage data yet. Data appears when agents make LLM/embedding calls through the gateway.
            </div>
          ) : (
            <div className={styles.modelList}>
              {models.map((m) => {
                const pct = Math.round((m.requests / totalModelRequests) * 100)
                return (
                  <div key={m.model} className={styles.modelRow}>
                    <div className={styles.modelInfo}>
                      <code className={styles.modelName}>{m.model}</code>
                      <span className={styles.modelRequests}>
                        {m.requests} requests · {formatNumber(m.total_tokens)} tokens
                      </span>
                    </div>
                    <div className={styles.modelBarWrapper}>
                      <div
                        className={styles.modelBar}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className={styles.modelPct}>{pct}%</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* By Agent */}
        <div className={`card ${styles.detailCard}`}>
          <h3 className={styles.detailTitle}>Usage by Agent</h3>
          {agents.length === 0 && !summaryLoading ? (
            <div className={styles.emptyState}>No agent activity recorded yet.</div>
          ) : (
            <div className={styles.agentList}>
              {agents.map((a) => (
                <div key={a.agent_id} className={styles.agentRow}>
                  <div className={styles.agentInfo}>
                    <code className={styles.agentName}>{a.agent_id}</code>
                    <span className={styles.agentMeta}>
                      {a.requests} requests · {formatNumber(a.total_tokens)} tokens
                      {a.last_active && (
                        <> · Last: {new Date(a.last_active).toLocaleDateString()}</>
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
          <strong>Powered by LLM Gateway</strong> — all API calls are routed through the centralized
          proxy with automatic usage logging, budget enforcement, and multi-provider fallback.
        </div>
      </div>
    </DashboardLayout>
  )
}
