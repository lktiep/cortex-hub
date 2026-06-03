'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import DashboardLayout from '@/components/layout/DashboardLayout'
import { getExternalUrl } from '@/lib/config'
import useSWR from 'swr'
import {
  checkHealth,
  getDashboardOverview,
  getActivityFeed,
  getSystemMetrics,
  getConductorAgents,
  getRecipeStats,
  type SystemMetrics,
} from '@/lib/api'
import {
  STAT_ICONS,
  GAUGE_ICONS,
  INTEL_ICONS,
} from '@/lib/icons'
import { Server, Bot } from 'lucide-react'
import { Skeleton, SkeletonText, SkeletonCircle } from '@/components/ui/Skeleton'
import { NumberTransition } from '@/components/ui/NumberTransition'
import { MetricCard } from '@/components/ui/MetricCard'
import { GaugeChart } from '@/components/ui/GaugeChart'
import { ActivityFeed } from '@/components/ui/ActivityFeed'
import { StatusDot } from '@/components/ui/StatusDot'
import styles from './page.module.css'

// ── Utilities ──

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toString()
}

// ── Skeleton Loaders ──

function ActivitySkeleton() {
  return (
    <div className={styles.activitySkeletonList}>
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className={styles.activitySkeletonRow} style={{ animationDelay: `${i * 80}ms` }}>
          <SkeletonCircle size={20} />
          <div className={styles.activitySkeletonContent}>
            <SkeletonText width="70%" height="0.75rem" />
            <SkeletonText width="40%" height="0.625rem" />
          </div>
          <SkeletonText width={40} height="0.625rem" />
        </div>
      ))}
    </div>
  )
}

function GaugeSkeleton() {
  return (
    <div className={styles.gaugeSkeletonCard}>
      <Skeleton width={100} height={100} className={styles.gaugeSkeletonRing} />
      <SkeletonText width={40} height="0.75rem" />
      <SkeletonText width={60} height="0.625rem" />
    </div>
  )
}

function IntelCardSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className={`card ${styles.intelCard} ${styles.intelCardSkeleton}`}>
      <div className={styles.intelHeader}>
        <SkeletonText width={120} height="0.8125rem" />
      </div>
      <div className={styles.intelGrid}>
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className={styles.intelStat}>
            <SkeletonText width={48} height="1.5rem" />
            <SkeletonText width={40} height="0.625rem" />
          </div>
        ))}
      </div>
    </div>
  )
}

function ContainersSkeleton() {
  return (
    <div className={`card ${styles.containersCard}`}>
      <div className={styles.containersHeader}>
        <span>Container</span><span>CPU</span><span>Memory</span><span>Status</span>
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className={styles.containerRow} style={{ animationDelay: `${i * 60}ms` }}>
          <div className={styles.containerInfo}>
            <SkeletonCircle size={8} />
            <SkeletonText width={80} height="0.75rem" />
          </div>
          <SkeletonText width={32} height="0.75rem" />
          <SkeletonText width={64} height="0.75rem" />
          <SkeletonText width={48} height="0.6875rem" />
        </div>
      ))}
    </div>
  )
}

// ── Container Row ──

function ContainerRow({ container }: { container: SystemMetrics['containers'][0] }) {
  const isRunning = container.status === 'running'
  const statusClass = isRunning ? 'healthy' : container.status === 'exited' ? 'error' : 'warning'
  return (
    <div className={styles.containerRow}>
      <div className={styles.containerInfo}>
        <StatusDot variant={statusClass} />
        <span className={styles.containerName}>{container.name.replace('cortex-', '')}</span>
      </div>
      <span className={styles.containerCpu}>{isRunning ? container.cpu : '—'}</span>
      <span className={styles.containerMem}>{isRunning ? container.memory : '—'}</span>
      <span className={styles.containerUptime}>{container.uptime}</span>
    </div>
  )
}

// ── Service Mini Card ──

function ServiceMini({ name, status }: { name: string; status: string }) {
  if (status === 'loading') {
    return (
      <div className={styles.serviceMini}>
        <SkeletonCircle size={8} />
        <span className={styles.serviceMiniName}><SkeletonText width={48} /></span>
      </div>
    )
  }
  const cls = status === 'ok' ? 'healthy' : status === 'error' ? 'error' : 'warning'
  return (
    <div className={styles.serviceMini}>
      <StatusDot variant={cls} />
      <span className={styles.serviceMiniName}>{name}</span>
    </div>
  )
}

// ══════════════════════════════════════════════
//  Main Dashboard
// ══════════════════════════════════════════════

export default function DashboardPage() {
  const { data: healthData, error: healthError, mutate, isLoading } = useSWR('health', checkHealth, {
    refreshInterval: 30000,
  })
  const { data: overview } = useSWR('dashboard-overview', getDashboardOverview, {
    refreshInterval: 15000,
  })
  const { data: activityData } = useSWR('activity', () => getActivityFeed(15), {
    refreshInterval: 15000,
  })
  const { data: systemData } = useSWR('system-metrics', getSystemMetrics, {
    refreshInterval: 5000,
  })
  const { data: agentsData } = useSWR('dashboard-agents', getConductorAgents, {
    refreshInterval: 10000,
  })
  const { data: recipeData } = useSWR('recipe-stats', getRecipeStats, {
    refreshInterval: 30000,
  })
  const onlineAgents = agentsData?.agents?.length ?? 0

  const svcMap = healthData?.services as Record<string, string> | undefined

  // Dynamic MCP URL state to resolve Tailscale/localhost
  const [mcpUrl, setMcpUrl] = useState('https://cortex-mcp.jackle.dev')

  useEffect(() => {
    setMcpUrl(getExternalUrl('mcp'))
  }, [])

  return (
    <DashboardLayout title="Dashboard" subtitle="System overview and project health">

      {/* ── Hero Stats Bar (4 per row) ── */}
      <div className={styles.heroBar}>
        <MetricCard index={0} Icon={STAT_ICONS.projects} value={overview ? <NumberTransition value={overview.projects.length} /> : <SkeletonText width={40} />} label="Projects" trendValue={12} sparklineData={[4, 5, 4, 6, 8, 10, Number(overview?.projects.length || 10)]} color="#4a90d9" />
        <MetricCard index={1} Icon={STAT_ICONS.agents} value={overview ? <NumberTransition value={overview.totalAgents} format={formatNumber} /> : <SkeletonText width={40} />} label="Active Sessions" trendValue={5} sparklineData={[2, 3, 3, 5, 6, 7, Number(overview?.totalAgents || 7)]} color="#9b59b6" />
        <MetricCard index={2} Icon={Bot} value={<NumberTransition value={onlineAgents} />} label="Agents Online" trendValue={0} sparklineData={[1, 2, 2, 3, 3, 3, onlineAgents]} color="#10b981" />
        <MetricCard index={3} Icon={STAT_ICONS.queries} value={overview ? <NumberTransition value={overview.today.queries} format={formatNumber} /> : <SkeletonText width={40} />} label="Queries Today" trendValue={-2} sparklineData={[120, 150, 110, 140, 90, 80, Number(overview?.today.queries || 90)]} color="#f5a623" />
        <MetricCard index={4} Icon={STAT_ICONS.tokensSaved} value={overview ? <NumberTransition value={overview.tokenSavings?.totalTokensSaved ?? 0} format={formatNumber} /> : <SkeletonText width={40} />} label="Tokens Saved" trendValue={8} sparklineData={[1000, 1200, 1100, 1500, 1800, 2100, Number(overview?.tokenSavings?.totalTokensSaved || 2200)]} color="#22c55e" />
        <MetricCard index={5} Icon={STAT_ICONS.quality} value={overview?.quality.lastGrade ?? <SkeletonText width={20} />} label="Quality" trendValue={0} sparklineData={[90, 92, 91, 95, 94, 98, Number(overview?.quality.averageScore || 95)]} color="#27ae60" />
        <MetricCard index={6} Icon={STAT_ICONS.uptime} value={overview ? `${Math.floor(overview.uptime / 3600)}h` : <SkeletonText width={30} />} label="Uptime" trendValue={100} sparklineData={[100, 100, 100, 100, 100, 100, 100]} color="#22c55e" />
      </div>

      {/* ── Services Health Strip ── */}
      <div className={styles.servicesStrip}>
        <div className={styles.servicesStripLeft}>
          <h3 className={styles.stripTitle}>Services</h3>
          <div className={styles.servicesInline}>
            {['qdrant', 'cliproxy', 'gitnexus', 'mem9', 'mcp'].map((svc) => (
              <ServiceMini key={svc} name={svc} status={svcMap?.[svc] ?? (isLoading ? 'loading' : healthError ? 'error' : 'unknown')} />
            ))}
          </div>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={() => mutate()} disabled={isLoading}>
          {isLoading ? 'Checking...' : 'Refresh'}
        </button>
      </div>


      {/* ── Two Column: System Resources + Quality/Knowledge ── */}
      <div className={styles.twoColumn}>

        {/* Left: System Resources */}
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>System Resources</h2>
            {systemData && (
              <span className={styles.serverTag}>
                <Server size={14} strokeWidth={1.5} style={{ display: 'inline', verticalAlign: 'text-bottom', marginRight: 4 }} />{systemData.hostname} · {systemData.cpu.cores} cores
              </span>
            )}
          </div>
          <div className={styles.gaugesGrid}>
            {systemData ? (
              <>
                <GaugeChart
                  id="cpu"
                  value={systemData.cpu.percent} label="CPU"
                  subtitle={`Load: ${systemData.cpu.loadAvg.join(' / ')}`}
                  color="#4a90d9" Icon={GAUGE_ICONS.cpu}
                />
                <GaugeChart
                  id="mem"
                  value={systemData.memory.percent} label="Memory"
                  subtitle={`${systemData.memory.usedHuman} / ${systemData.memory.totalHuman}`}
                  color="#9b59b6" Icon={GAUGE_ICONS.memory}
                />
                <GaugeChart
                  id="disk"
                  value={systemData.disk[0]?.usedPercent ?? 0} label="Disk"
                  subtitle={systemData.disk[0] ? `${systemData.disk[0].used} / ${systemData.disk[0].size}` : '—'}
                  color="#27ae60" Icon={GAUGE_ICONS.disk}
                />
              </>
            ) : (
              <>
                <GaugeSkeleton />
                <GaugeSkeleton />
                <GaugeSkeleton />
              </>
            )}
          </div>
          {/* Docker Containers */}
          {!systemData ? (
            <ContainersSkeleton />
          ) : systemData.containers && systemData.containers.length > 0 ? (
            <div className={`card ${styles.containersCard}`}>
              <div className={styles.containersHeader}>
                <span>Container</span><span>CPU</span><span>Memory</span><span>Status</span>
              </div>
              {systemData.containers.map((c) => (
                <ContainerRow key={c.name} container={c} />
              ))}
            </div>
          ) : null}

          {/* Cortex Savings */}
          <div style={{ marginTop: 'var(--space-8)' }}>
            <h2 className={styles.sectionTitle} style={{ marginBottom: 'var(--space-4)' }}>Cortex Savings</h2>
            {!overview ? (
              <IntelCardSkeleton />
            ) : (
              <div className={`card ${styles.intelCard} ${styles.intelCardFadeIn}`}>
                <div className={styles.intelHeader}>
                  <span><INTEL_ICONS.tokens size={16} strokeWidth={1.5} style={{ display: 'inline', verticalAlign: 'text-bottom', marginRight: 4 }} /> Token Analytics</span>
                  <Link href="/usage" className={styles.intelLink}>View →</Link>
                </div>
                <div className={styles.intelGrid}>
                  <div className={styles.intelStat}>
                    <span className={styles.intelValue} style={{ color: '#22c55e' }}>
                      <NumberTransition value={overview.tokenSavings?.totalTokensSaved ?? 0} format={formatNumber} />
                    </span>
                    <span className={styles.intelLabel}>Tokens Saved</span>
                  </div>
                  <div className={styles.intelStat}>
                    <span className={styles.intelValue}>
                      <NumberTransition value={overview.tokenSavings?.totalToolCalls ?? 0} format={formatNumber} />
                    </span>
                    <span className={styles.intelLabel}>Tool Calls</span>
                  </div>
                  <div className={styles.intelStat}>
                    <span className={styles.intelValue}>
                      <NumberTransition value={overview.tokenSavings?.avgTokensPerCall ?? 0} />
                    </span>
                    <span className={styles.intelLabel}>Avg/Call</span>
                  </div>
                </div>
                {overview.tokenSavings?.topTools && overview.tokenSavings.topTools.length > 0 && (
                  <div className={styles.topToolsList}>
                    {overview.tokenSavings.topTools.slice(0, 3).map((t) => (
                      <div key={t.tool} className={styles.topToolRow}>
                        <code className={styles.topToolName}>{t.tool.replace('cortex_', '')}</code>
                        <span className={styles.topToolValue}>{formatNumber(t.tokensSaved)} tokens</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Right: Quick Stats */}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Intelligence</h2>

          {!overview ? (
            <>
              <IntelCardSkeleton />
              <IntelCardSkeleton />
              <IntelCardSkeleton />
            </>
          ) : (
            <>
              {/* Quality */}
              <div className={`card ${styles.intelCard} ${styles.intelCardFadeIn}`}>
                <div className={styles.intelHeader}>
                  <span><INTEL_ICONS.quality size={16} strokeWidth={1.5} style={{ display: 'inline', verticalAlign: 'text-bottom', marginRight: 4 }} /> Quality Gates</span>
                  <Link href="/quality" className={styles.intelLink}>View →</Link>
                </div>
                <div className={styles.intelGrid}>
                  <div className={styles.intelStat}>
                    <span className={styles.intelValue} style={{ color: overview.quality.lastGrade === 'A' ? '#22c55e' : overview.quality.lastGrade === 'F' ? '#ef4444' : '#eab308' }}>
                      {overview.quality.lastGrade || '—'}
                    </span>
                    <span className={styles.intelLabel}>Last Grade</span>
                  </div>
                  <div className={styles.intelStat}>
                    <span className={styles.intelValue}>
                      <NumberTransition value={overview.quality.averageScore ?? 0} />
                    </span>
                    <span className={styles.intelLabel}>Avg Score</span>
                  </div>
                  <div className={styles.intelStat}>
                    <span className={styles.intelValue}>
                      <NumberTransition value={overview.quality.reportsToday ?? 0} />
                    </span>
                    <span className={styles.intelLabel}>Today</span>
                  </div>
                </div>
              </div>

              {/* Knowledge */}
              <div className={`card ${styles.intelCard} ${styles.intelCardFadeIn}`} style={{ animationDelay: '60ms' }}>
                <div className={styles.intelHeader}>
                  <span><INTEL_ICONS.knowledge size={16} strokeWidth={1.5} style={{ display: 'inline', verticalAlign: 'text-bottom', marginRight: 4 }} /> Knowledge Base</span>
                  <Link href="/knowledge" className={styles.intelLink}>View →</Link>
                </div>
                <div className={styles.intelGrid}>
                  <div className={styles.intelStat}>
                    <span className={styles.intelValue}>
                      <NumberTransition value={overview.knowledge.totalDocs ?? 0} />
                    </span>
                    <span className={styles.intelLabel}>Documents</span>
                  </div>
                  <div className={styles.intelStat}>
                    <span className={styles.intelValue}>
                      <NumberTransition value={overview.knowledge.totalChunks ?? 0} format={formatNumber} />
                    </span>
                    <span className={styles.intelLabel}>Chunks</span>
                  </div>
                  <div className={styles.intelStat}>
                    <span className={styles.intelValue}>
                      <NumberTransition value={overview.knowledge.totalHits ?? 0} format={formatNumber} />
                    </span>
                    <span className={styles.intelLabel}>Hits</span>
                  </div>
                </div>
              </div>

              {/* Recipe System */}
              {recipeData && (() => {
                const captured = (recipeData.capture.stats.captured ?? 0) + (recipeData.capture.stats.derived ?? 0)
                const errors = recipeData.capture.stats.error ?? 0
                const attempts = Object.values(recipeData.capture.stats).reduce((s, n) => s + n, 0)
                const avgRate = recipeData.quality.avgEffectiveRate != null ? Math.round(recipeData.quality.avgEffectiveRate * 100) : null
                const isAlive = captured > 0
                return (
                  <div className={`card ${styles.intelCard} ${styles.intelCardFadeIn}`} style={{ animationDelay: '90ms' }}>
                    <div className={styles.intelHeader}>
                      <span>
                        <StatusDot variant={isAlive ? 'healthy' : errors > 0 ? 'error' : 'warning'} />
                        {' '}Recipe System
                      </span>
                      <Link href="/knowledge" className={styles.intelLink}>View →</Link>
                    </div>
                    <div className={styles.intelGrid}>
                      <div className={styles.intelStat}>
                        <span className={styles.intelValue} style={{ color: captured > 0 ? '#22c55e' : undefined }}>
                          <NumberTransition value={captured} />
                        </span>
                        <span className={styles.intelLabel}>Captured</span>
                      </div>
                      <div className={styles.intelStat}>
                        <span className={styles.intelValue}>
                          <NumberTransition value={attempts} />
                        </span>
                        <span className={styles.intelLabel}>Attempts</span>
                      </div>
                      {avgRate != null ? (
                        <div className={styles.intelStat}>
                          <span className={styles.intelValue} style={{ color: avgRate > 50 ? '#22c55e' : '#eab308' }}>
                            {avgRate}%
                          </span>
                          <span className={styles.intelLabel}>Effective</span>
                        </div>
                      ) : (
                        <div className={styles.intelStat}>
                          <span className={styles.intelValue} style={{ color: errors > 0 ? '#ef4444' : undefined }}>
                            <NumberTransition value={errors} />
                          </span>
                          <span className={styles.intelLabel}>Errors</span>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })()}

              {/* Sessions + Keys */}
              <div className={`card ${styles.intelCard} ${styles.intelCardFadeIn}`} style={{ animationDelay: '120ms' }}>
                <div className={styles.intelHeader}><span><INTEL_ICONS.platform size={16} strokeWidth={1.5} style={{ display: 'inline', verticalAlign: 'text-bottom', marginRight: 4 }} /> Platform</span></div>
                <div className={styles.intelGrid}>
                  <div className={styles.intelStat}>
                    <span className={styles.intelValue}>
                      <NumberTransition value={overview.activeKeys ?? 0} />
                    </span>
                    <span className={styles.intelLabel}>API Keys</span>
                  </div>
                  <div className={styles.intelStat}>
                    <span className={styles.intelValue}>
                      <NumberTransition value={overview.totalSessions ?? 0} />
                    </span>
                    <span className={styles.intelLabel}>Sessions</span>
                  </div>
                  <div className={styles.intelStat}>
                    <span className={styles.intelValue}>
                      <NumberTransition value={overview.organizations ?? 0} />
                    </span>
                    <span className={styles.intelLabel}>Orgs</span>
                  </div>
                </div>
              </div>
            </>
          )}

        </section>
      </div>

      {/* ── Activity Feed ── */}
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Recent Activity</h2>
          <Link href="/sessions" className="btn btn-secondary btn-sm">All Sessions →</Link>
        </div>
        {!activityData ? (
          <div className={`card ${styles.activityCard}`}><ActivitySkeleton /></div>
        ) : (
          <ActivityFeed events={activityData.activity ?? []} />
        )}
      </section>

      {/* ── Quick Connect ── */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Quick Connect</h2>
        <div className={`card ${styles.connectCard}`}>
          <p className={styles.connectText}>
            Add Cortex Hub to your AI agent&apos;s MCP config:
          </p>
          <pre className={styles.codeBlock}>
{`{
  "mcpServers": {
    "cortex-hub": {
      "url": "${mcpUrl.endsWith('/mcp') ? mcpUrl : `${mcpUrl}/mcp`}",
      "headers": {
        "Authorization": "Bearer <your-api-key>"
      }
    }
  }
}`}
          </pre>
          <a href="/keys" className="btn btn-primary btn-sm" style={{ marginTop: 'var(--space-4)', display: 'inline-flex' }}>
            Generate API Key →
          </a>
        </div>
      </section>
    </DashboardLayout>
  )
}
