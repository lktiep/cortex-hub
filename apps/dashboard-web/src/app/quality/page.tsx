'use client'

import { useState, useMemo } from 'react'
import DashboardLayout from '@/components/layout/DashboardLayout'
import useSWR from 'swr'
import {
  getQualityReports,
  getQualityTrends,
  getQualitySummary,
  getQualityLogs,
  type QualityReportRow,
  type QualityTrendData,
  type QueryLog,
} from '@/lib/api'
import styles from './page.module.css'

// ── Grade Utilities ──
const GRADE_COLORS: Record<string, string> = {
  A: '#22c55e',
  B: '#3b82f6',
  C: '#eab308',
  D: '#f97316',
  F: '#ef4444',
}

function gradeColor(grade: string): string {
  return GRADE_COLORS[grade] ?? '#6b7280'
}

function gradeAction(grade: string): string {
  const actions: Record<string, string> = {
    A: 'Proceed immediately',
    B: 'Proceed with minor warnings',
    C: 'Proceed but flag at next gate',
    D: 'Pause — show report, ask user',
    F: 'Stop — must remediate',
  }
  return actions[grade] ?? ''
}

// ── Components ──

function GradeBadge({ grade, size = 'md' }: { grade: string; size?: 'sm' | 'md' | 'lg' | 'hero' }) {
  return (
    <span
      className={`${styles.gradeBadge} ${styles[`grade${size.charAt(0).toUpperCase() + size.slice(1)}`]}`}
      style={{ '--grade-color': gradeColor(grade) } as React.CSSProperties}
    >
      {grade}
    </span>
  )
}

function ScoreRing({ score, label, max = 25 }: { score: number; label: string; max?: number }) {
  const pct = max > 0 ? (score / max) * 100 : 0
  const color = pct >= 90 ? '#22c55e' : pct >= 70 ? '#3b82f6' : pct >= 50 ? '#eab308' : '#ef4444'

  return (
    <div className={styles.scoreRing}>
      <div className={styles.ringTrack}>
        <div
          className={styles.ringFill}
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <div className={styles.ringInfo}>
        <span className={styles.ringScore} style={{ color }}>{score}</span>
        <span className={styles.ringMax}>/{max}</span>
      </div>
      <span className={styles.ringLabel}>{label}</span>
    </div>
  )
}

function TrendChart({ data }: { data: QualityTrendData[] }) {
  if (data.length === 0) {
    return <div className={styles.emptyTrend}>No trend data yet. Reports will appear after quality checks.</div>
  }

  const maxScore = 100
  const chartHeight = 120

  return (
    <div className={styles.trendChart}>
      <div className={styles.trendBars}>
        {data.map((point) => {
          const height = (point.avg_score / maxScore) * chartHeight
          const grade = scoreToGradeLocal(point.avg_score)
          return (
            <div key={point.date} className={styles.trendBar} title={`${point.date}: ${point.avg_score}/100 (${grade})`}>
              <div className={styles.trendBarStack}>
                <div
                  className={styles.trendBarFill}
                  style={{ height: `${height}px`, background: gradeColor(grade) }}
                />
              </div>
              <span className={styles.trendDate}>{point.date.slice(5)}</span>
              <span className={styles.trendScore}>{Math.round(point.avg_score)}</span>
            </div>
          )
        })}
      </div>
      <div className={styles.trendLegend}>
        <span className={styles.trendLegendItem}>
          <span className={styles.trendDot} style={{ background: '#22c55e' }} /> A (90+)
        </span>
        <span className={styles.trendLegendItem}>
          <span className={styles.trendDot} style={{ background: '#3b82f6' }} /> B (80+)
        </span>
        <span className={styles.trendLegendItem}>
          <span className={styles.trendDot} style={{ background: '#eab308' }} /> C (70+)
        </span>
        <span className={styles.trendLegendItem}>
          <span className={styles.trendDot} style={{ background: '#f97316' }} /> D (60+)
        </span>
        <span className={styles.trendLegendItem}>
          <span className={styles.trendDot} style={{ background: '#ef4444' }} /> F (&lt;60)
        </span>
      </div>
    </div>
  )
}

function DimensionBreakdown({ data }: { data: QualityTrendData[] }) {
  if (data.length === 0) return null

  const latest = data[data.length - 1]
  if (!latest) return null
  return (
    <div className={styles.dimensionGrid}>
      <div className={styles.dimRow}>
        <span className={styles.dimLabel}>Build</span>
        <div className={styles.dimTrack}>
          <div className={styles.dimFill} style={{ width: `${(latest.avg_build / 25) * 100}%`, background: latest.avg_build >= 20 ? '#22c55e' : '#ef4444' }} />
        </div>
        <span className={styles.dimValue}>{Math.round(latest.avg_build)}/25</span>
      </div>
      <div className={styles.dimRow}>
        <span className={styles.dimLabel}>Regression</span>
        <div className={styles.dimTrack}>
          <div className={styles.dimFill} style={{ width: `${(latest.avg_regression / 25) * 100}%`, background: latest.avg_regression >= 20 ? '#22c55e' : '#ef4444' }} />
        </div>
        <span className={styles.dimValue}>{Math.round(latest.avg_regression)}/25</span>
      </div>
      <div className={styles.dimRow}>
        <span className={styles.dimLabel}>Standards</span>
        <div className={styles.dimTrack}>
          <div className={styles.dimFill} style={{ width: `${(latest.avg_standards / 25) * 100}%`, background: latest.avg_standards >= 20 ? '#22c55e' : latest.avg_standards >= 15 ? '#eab308' : '#ef4444' }} />
        </div>
        <span className={styles.dimValue}>{Math.round(latest.avg_standards)}/25</span>
      </div>
      <div className={styles.dimRow}>
        <span className={styles.dimLabel}>Traceability</span>
        <div className={styles.dimTrack}>
          <div className={styles.dimFill} style={{ width: `${(latest.avg_traceability / 25) * 100}%`, background: latest.avg_traceability >= 20 ? '#22c55e' : latest.avg_traceability >= 15 ? '#eab308' : '#ef4444' }} />
        </div>
        <span className={styles.dimValue}>{Math.round(latest.avg_traceability)}/25</span>
      </div>
    </div>
  )
}

function scoreToGradeLocal(score: number): string {
  if (score >= 90) return 'A'
  if (score >= 80) return 'B'
  if (score >= 70) return 'C'
  if (score >= 60) return 'D'
  return 'F'
}

// ── Tab System ──
type TabId = 'overview' | 'reports' | 'logs'

export default function QualityPage() {
  const [activeTab, setActiveTab] = useState<TabId>('overview')
  const [filterGrade, setFilterGrade] = useState('')
  const [filterAgent, setFilterAgent] = useState('')
  const [reportPage, setReportPage] = useState(1)
  const [logPage, setLogPage] = useState(1)

  const { data: summaryData } = useSWR('quality-summary', getQualitySummary, { refreshInterval: 15000 })
  const { data: trendsData } = useSWR('quality-trends', () => getQualityTrends(30), { refreshInterval: 30000 })
  const { data: reportsData, mutate: mutateReports } = useSWR(
    ['quality-reports', filterGrade, filterAgent, reportPage],
    () => getQualityReports({ limit: 20, page: reportPage, grade: filterGrade || undefined, agentId: filterAgent || undefined }),
    { refreshInterval: 15000 }
  )
  const { data: logsData } = useSWR(
    ['quality-logs', logPage],
    () => getQualityLogs({ limit: 20, page: logPage }),
    { refreshInterval: 30000 }
  )

  const summary = summaryData?.summary
  const latest = summaryData?.latest
  const trends = trendsData?.trends ?? []
  const reports = reportsData?.reports ?? []
  const reportsTotalPages = reportsData?.totalPages ?? 1
  const reportsTotal = reportsData?.total ?? 0
  const logs = logsData?.logs ?? []
  const logsTotalPages = logsData?.totalPages ?? 1
  const logsTotal = logsData?.total ?? 0

  // Collect unique agent IDs from reports for filter dropdown
  const uniqueAgents = useMemo(() => {
    const set = new Set(reports.map((r: QualityReportRow) => r.agent_id))
    return Array.from(set).sort()
  }, [reports])

  const latestGrade = latest?.grade ?? '—'
  const latestScore = latest?.score_total ?? 0

  // Grade distribution for chart
  const gradeDistribution = useMemo(() => {
    if (!summary) return []
    return [
      { grade: 'A', count: summary.grade_a, color: GRADE_COLORS.A ?? '#22c55e' },
      { grade: 'B', count: summary.grade_b, color: GRADE_COLORS.B ?? '#3b82f6' },
      { grade: 'C', count: summary.grade_c, color: GRADE_COLORS.C ?? '#eab308' },
      { grade: 'D', count: summary.grade_d, color: GRADE_COLORS.D ?? '#f97316' },
      { grade: 'F', count: summary.grade_f, color: GRADE_COLORS.F ?? '#ef4444' },
    ]
  }, [summary])

  const gradeDistMax = Math.max(...gradeDistribution.map(g => g.count), 1)

  return (
    <DashboardLayout title="Quality Gates" subtitle="4-dimension quality scoring with automated enforcement">
      {/* ── Hero Section ── */}
      <div className={styles.heroGrid}>
        {/* Current Grade */}
        <div className={`card ${styles.heroCard}`}>
          <div className={styles.heroGrade}>
            {latest ? (
              <>
                <GradeBadge grade={latestGrade} size="hero" />
                <div className={styles.heroMeta}>
                  <span className={styles.heroScore}>{latestScore}/100</span>
                  <span className={styles.heroAction}>{gradeAction(latestGrade)}</span>
                  <span className={styles.heroTime}>
                    Last: {latest.created_at ? new Date(latest.created_at).toLocaleString() : '—'}
                  </span>
                </div>
              </>
            ) : (
              <div className={styles.heroEmpty}>
                <span className={styles.heroEmptyGrade}>—</span>
                <span className={styles.heroEmptyText}>No quality reports yet</span>
              </div>
            )}
          </div>
        </div>

        {/* 4-Dimension Breakdown */}
        <div className={`card ${styles.heroCard}`}>
          <h3 className={styles.cardTitle}>4-Dimension Breakdown</h3>
          {latest ? (
            <div className={styles.dimensionCards}>
              <ScoreRing score={latest.score_build} label="Build" />
              <ScoreRing score={latest.score_regression} label="Regression" />
              <ScoreRing score={latest.score_standards} label="Standards" />
              <ScoreRing score={latest.score_traceability} label="Traceability" />
            </div>
          ) : (
            <div className={styles.emptyDimensions}>Run a quality gate to see dimension scores</div>
          )}
        </div>

        {/* Stats */}
        <div className={`card ${styles.heroCard}`}>
          <h3 className={styles.cardTitle}>Statistics</h3>
          <div className={styles.miniStats}>
            <div className={styles.miniStat}>
              <span className={styles.miniStatValue}>{summary?.total_reports ?? 0}</span>
              <span className={styles.miniStatLabel}>Total Reports</span>
            </div>
            <div className={styles.miniStat}>
              <span className={styles.miniStatValue} style={{ color: '#22c55e' }}>{summary?.passed_count ?? 0}</span>
              <span className={styles.miniStatLabel}>Passed</span>
            </div>
            <div className={styles.miniStat}>
              <span className={styles.miniStatValue} style={{ color: '#ef4444' }}>{summary?.failed_count ?? 0}</span>
              <span className={styles.miniStatLabel}>Failed</span>
            </div>
            <div className={styles.miniStat}>
              <span className={styles.miniStatValue}>{summary?.avg_score != null ? Math.round(summary.avg_score) : '—'}</span>
              <span className={styles.miniStatLabel}>Avg Score</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Tabs ── */}
      <div className={styles.tabs}>
        {(['overview', 'reports', 'logs'] as const).map(tab => (
          <button
            key={tab}
            className={`${styles.tab} ${activeTab === tab ? styles.tabActive : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'overview' ? 'Trend & Distribution' : tab === 'reports' ? 'Report History' : 'Execution Logs'}
          </button>
        ))}
      </div>

      {/* ── Tab Content ── */}
      {activeTab === 'overview' && (
        <div className={styles.overviewGrid}>
          {/* Trend Chart */}
          <div className={`card ${styles.chartCard}`}>
            <h3 className={styles.cardTitle}>Quality Trend (30 days)</h3>
            <TrendChart data={trends} />
          </div>

          {/* Dimension Averages */}
          <div className={`card ${styles.chartCard}`}>
            <h3 className={styles.cardTitle}>Dimension Averages</h3>
            <DimensionBreakdown data={trends} />
          </div>

          {/* Grade Distribution */}
          <div className={`card ${styles.chartCard}`}>
            <h3 className={styles.cardTitle}>Grade Distribution</h3>
            <div className={styles.gradeDist}>
              {gradeDistribution.map(g => (
                <div key={g.grade} className={styles.gradeDistBar}>
                  <div className={styles.gradeDistFillWrap}>
                    <div
                      className={styles.gradeDistFill}
                      style={{
                        height: `${(g.count / gradeDistMax) * 100}%`,
                        background: g.color,
                      }}
                    />
                  </div>
                  <span className={styles.gradeDistLabel} style={{ color: g.color }}>{g.grade}</span>
                  <span className={styles.gradeDistCount}>{g.count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'reports' && (
        <div className={styles.section}>
          <div className={styles.filterBar}>
            <select
              className={styles.filterSelect}
              value={filterGrade}
              onChange={(e) => { setFilterGrade(e.target.value); setReportPage(1) }}
            >
              <option value="">All Grades</option>
              {['A', 'B', 'C', 'D', 'F'].map(g => (
                <option key={g} value={g}>Grade {g}</option>
              ))}
            </select>
            <select
              className={styles.filterSelect}
              value={filterAgent}
              onChange={(e) => { setFilterAgent(e.target.value); setReportPage(1) }}
            >
              <option value="">All Agents</option>
              {uniqueAgents.map(a => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
            <button className="btn btn-secondary btn-sm" onClick={() => mutateReports()}>
              Refresh
            </button>
          </div>

          <div className={styles.tableCard}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Gate</th>
                  <th>Agent</th>
                  <th className={styles.cellCenter}>Build</th>
                  <th className={styles.cellCenter}>Regr.</th>
                  <th className={styles.cellCenter}>Stds.</th>
                  <th className={styles.cellCenter}>Trace.</th>
                  <th className={styles.cellCenter}>Total</th>
                  <th className={styles.cellCenter}>Grade</th>
                  <th>Timestamp</th>
                </tr>
              </thead>
              <tbody>
                {reports.map((r: QualityReportRow) => (
                  <ReportRow key={r.id} report={r} />
                ))}
                {reports.length === 0 && (
                  <tr>
                    <td colSpan={9} className={styles.emptyState}>
                      No quality reports yet. Reports appear when agents run quality gates via MCP.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {reportsTotalPages > 1 && (
            <div className={styles.pagination}>
              <button
                className={styles.paginationBtn}
                disabled={reportPage <= 1}
                onClick={() => setReportPage(p => Math.max(1, p - 1))}
              >
                ← Prev
              </button>
              <span className={styles.pageInfo}>
                Page {reportPage} of {reportsTotalPages} ({reportsTotal} total)
              </span>
              <button
                className={styles.paginationBtn}
                disabled={reportPage >= reportsTotalPages}
                onClick={() => setReportPage(p => p + 1)}
              >
                Next →
              </button>
            </div>
          )}
        </div>
      )}

      {activeTab === 'logs' && (
        <div className={styles.section}>
          <div className={styles.tableCard}>
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
                {logs.map((log: QueryLog) => (
                  <LegacyLogRow key={log.id} log={log} />
                ))}
                {logs.length === 0 && (
                  <tr>
                    <td colSpan={6} className={styles.emptyState}>
                      No execution logs yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {logsTotalPages > 1 && (
            <div className={styles.pagination}>
              <button
                className={styles.paginationBtn}
                disabled={logPage <= 1}
                onClick={() => setLogPage(p => Math.max(1, p - 1))}
              >
                ← Prev
              </button>
              <span className={styles.pageInfo}>
                Page {logPage} of {logsTotalPages} ({logsTotal} total)
              </span>
              <button
                className={styles.paginationBtn}
                disabled={logPage >= logsTotalPages}
                onClick={() => setLogPage(p => p + 1)}
              >
                Next →
              </button>
            </div>
          )}
        </div>
      )}
    </DashboardLayout>
  )
}

// ── Table Row Components ──

function ReportRow({ report }: { report: QualityReportRow }) {
  return (
    <tr>
      <td><code className={styles.toolName}>{report.gate_name}</code></td>
      <td className={styles.cellMono}>{report.agent_id}</td>
      <td className={styles.cellCenter}>
        <DimScore value={report.score_build} max={25} />
      </td>
      <td className={styles.cellCenter}>
        <DimScore value={report.score_regression} max={25} />
      </td>
      <td className={styles.cellCenter}>
        <DimScore value={report.score_standards} max={25} />
      </td>
      <td className={styles.cellCenter}>
        <DimScore value={report.score_traceability} max={25} />
      </td>
      <td className={styles.cellCenter}>
        <span className={styles.totalScore}>{report.score_total}</span>
      </td>
      <td className={styles.cellCenter}>
        <GradeBadge grade={report.grade} size="sm" />
      </td>
      <td className={styles.cellMuted}>
        {report.created_at ? new Date(report.created_at).toLocaleString() : '—'}
      </td>
    </tr>
  )
}

function DimScore({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? value / max : 0
  const color = pct >= 0.9 ? '#22c55e' : pct >= 0.7 ? '#eab308' : '#ef4444'
  return <span style={{ color, fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: '0.8125rem' }}>{value}</span>
}

function LegacyLogRow({ log }: { log: QueryLog }) {
  const parsed = parseParams(log.params)
  return (
    <tr>
      <td className={styles.cellMono}>{log.agent_id}</td>
      <td><code className={styles.toolName}>{log.tool}</code></td>
      <td className={styles.cellCenter}>
        {parsed.score != null ? (
          <span className={styles.score}>{parsed.score}/100</span>
        ) : (
          <span className={styles.muted}>—</span>
        )}
      </td>
      <td className={styles.cellCenter}>
        {log.latency_ms != null ? <span>{log.latency_ms}ms</span> : <span className={styles.muted}>—</span>}
      </td>
      <td className={styles.cellCenter}>
        <span className={`badge badge-${log.status === 'ok' ? 'healthy' : 'error'}`}>{log.status}</span>
      </td>
      <td className={styles.cellMuted}>
        {log.created_at ? new Date(log.created_at).toLocaleString() : '—'}
      </td>
    </tr>
  )
}

function parseParams(params: string | null): { score?: number; details?: string } {
  if (!params) return {}
  try { return JSON.parse(params) } catch { return {} }
}
