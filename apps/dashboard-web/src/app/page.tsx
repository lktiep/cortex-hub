'use client'

import DashboardLayout from '@/components/layout/DashboardLayout'
import useSWR from 'swr'
import { checkHealth, getDashboardStats, getActivityFeed, getSystemMetrics, type ActivityEvent, type SystemMetrics } from '@/lib/api'
import styles from './page.module.css'

interface ServiceCardProps {
  name: string
  status: 'healthy' | 'warning' | 'error' | 'unknown' | 'muted'
  description: string
  endpoint: string
}

function ServiceCard({ name, status, description, endpoint }: ServiceCardProps) {
  return (
    <div className={`card ${styles.serviceCard}`}>
      <div className={styles.serviceHeader}>
        <span className={`status-dot ${status}`} />
        <h3 className={styles.serviceName}>{name}</h3>
        <span className={`badge badge-${status === 'unknown' || status === 'muted' ? 'warning' : status}`}>
          {status}
        </span>
      </div>
      <p className={styles.serviceDesc}>{description}</p>
      <code className={styles.serviceEndpoint}>{endpoint}</code>
    </div>
  )
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toString()
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function ActivityRow({ event }: { event: ActivityEvent }) {
  const icon = event.type === 'query' ? '🔍' : '📋'
  const statusClass = event.status === 'ok' || event.status === 'completed' ? 'healthy' : event.status === 'error' ? 'error' : 'warning'
  return (
    <div className={styles.activityRow}>
      <span className={styles.activityIcon}>{icon}</span>
      <div className={styles.activityInfo}>
        <span className={styles.activityDetail}>{event.detail}</span>
        <span className={styles.activityMeta}>
          {event.agent_id}
          {event.latency_ms ? ` · ${event.latency_ms}ms` : ''}
        </span>
      </div>
      <div className={styles.activityRight}>
        <span className={`badge badge-${statusClass}`}>{event.status}</span>
        <span className={styles.activityTime}>{timeAgo(event.created_at)}</span>
      </div>
    </div>
  )
}

function GaugeChart({ value, label, subtitle, color, icon }: {
  value: number
  label: string
  subtitle: string
  color: string
  icon: string
}) {
  const radius = 54
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (value / 100) * circumference
  const statusColor = value > 90 ? '#e74c3c' : value > 70 ? '#f5a623' : color

  return (
    <div className={styles.gaugeCard}>
      <div className={styles.gaugeContainer}>
        <svg viewBox="0 0 128 128" className={styles.gaugeSvg}>
          {/* Background ring */}
          <circle
            cx="64" cy="64" r={radius}
            fill="none"
            stroke="var(--border)"
            strokeWidth="8"
            opacity="0.3"
          />
          {/* Animated value ring */}
          <circle
            cx="64" cy="64" r={radius}
            fill="none"
            stroke={statusColor}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            transform="rotate(-90 64 64)"
            className={styles.gaugeRing}
            style={{
              filter: `drop-shadow(0 0 6px ${statusColor}40)`,
            }}
          />
        </svg>
        <div className={styles.gaugeCenter}>
          <span className={styles.gaugeIcon}>{icon}</span>
          <span className={styles.gaugeValue}>{value}%</span>
        </div>
      </div>
      <div className={styles.gaugeLabel}>{label}</div>
      <div className={styles.gaugeSub}>{subtitle}</div>
    </div>
  )
}

function ContainerRow({ container }: { container: SystemMetrics['containers'][0] }) {
  const isRunning = container.status === 'running'
  const statusClass = isRunning ? 'healthy' : container.status === 'exited' ? 'error' : 'warning'
  return (
    <div className={styles.containerRow}>
      <div className={styles.containerInfo}>
        <span className={`status-dot ${statusClass}`} />
        <span className={styles.containerName}>{container.name.replace('cortex-', '')}</span>
      </div>
      <span className={styles.containerCpu}>{isRunning ? container.cpu : '—'}</span>
      <span className={styles.containerMem}>{isRunning ? container.memory : '—'}</span>
      <span className={styles.containerUptime}>{container.uptime}</span>
    </div>
  )
}

export default function DashboardPage() {
  const { data: healthData, error, mutate, isLoading } = useSWR('health', checkHealth, {
    refreshInterval: 30000,
  })
  const { data: statsData } = useSWR('dashboard-stats', getDashboardStats, {
    refreshInterval: 30000,
  })
  const { data: activityData } = useSWR('activity', () => getActivityFeed(20), {
    refreshInterval: 15000,
  })
  const { data: systemData } = useSWR('system-metrics', getSystemMetrics, {
    refreshInterval: 5000,
  })

  const services: ServiceCardProps[] = [
    {
      name: 'Hub Backend API',
      description: `Core API for Cortex Hub operations ${healthData?.commit ? `(${healthData.commit.substring(0, 7)})` : ''}`,
      endpoint: 'cortex-api.jackle.dev',
      status: isLoading ? 'muted' : error ? 'error' : healthData?.status === 'ok' || healthData?.status === 'degraded' ? 'healthy' : 'error',
    },
    {
      name: 'MCP Gateway',
      description: 'Cloudflare Worker — MCP protocol endpoint',
      endpoint: 'cortex-mcp.jackle.dev',
      status: isLoading ? 'muted' : 'warning',
    },
    {
      name: 'Qdrant Vector DB',
      description: 'Vector database — semantic search',
      endpoint: 'Local Docker :6333',
      status: isLoading ? 'muted' : healthData?.services?.qdrant === 'ok' ? 'healthy' : 'error',
    },
    {
      name: 'CLIProxy (LLM)',
      description: 'LLM gateway — OAuth proxy to AI providers',
      endpoint: 'Local Docker :8317',
      status: isLoading ? 'muted' : healthData?.services?.cliproxy === 'ok' ? 'healthy' : 'error',
    },
  ]

  const metrics = [
    { label: 'Active Keys', value: statsData ? formatNumber(statsData.activeKeys) : '...', icon: '🔑' },
    { label: 'Total Agents', value: statsData ? formatNumber(statsData.totalAgents) : '...', icon: '🤖' },
    { label: 'Memory Nodes', value: statsData ? formatNumber(statsData.memoryNodes) : '...', icon: '🧠' },
    { label: 'Uptime', value: statsData ? `${Math.floor(statsData.uptime / 3600)}h` : '...', icon: '⚡' },
    { label: 'Queries Today', value: statsData ? formatNumber(statsData.today.queries) : '...', icon: '📊' },
    { label: 'Organizations', value: statsData ? formatNumber(statsData.organizations) : '...', icon: '🏢' },
  ]

  return (
    <DashboardLayout title="Dashboard" subtitle="System overview and service health">
      {/* System Resources — top of page */}
      <section className={styles.section}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-4)' }}>
          <h2 className={styles.sectionTitle} style={{ margin: 0 }}>System Resources</h2>
          {systemData && (
            <div className={styles.serverInfo}>
              <span>🖥️ {systemData.hostname}</span>
              <span>·</span>
              <span>{systemData.cpu.cores} cores</span>
              <span>·</span>
              <span>{systemData.ip}</span>
              <span>·</span>
              <span>⏱️ {Math.floor(systemData.uptime / 3600)}h {Math.floor((systemData.uptime % 3600) / 60)}m</span>
            </div>
          )}
        </div>

        {/* Gauge Charts */}
        <div className={styles.gaugesGrid}>
          <GaugeChart
            value={systemData?.cpu.percent ?? 0}
            label="CPU"
            subtitle={systemData ? `Load: ${systemData.cpu.loadAvg.join(' / ')}` : 'Loading...'}
            color="#4a90d9"
            icon="⚡"
          />
          <GaugeChart
            value={systemData?.memory.percent ?? 0}
            label="Memory"
            subtitle={systemData ? `${systemData.memory.usedHuman} / ${systemData.memory.totalHuman}` : 'Loading...'}
            color="#9b59b6"
            icon="🧠"
          />
          <GaugeChart
            value={systemData?.disk[0]?.usedPercent ?? 0}
            label="Disk"
            subtitle={systemData?.disk[0] ? `${systemData.disk[0].used} / ${systemData.disk[0].size}` : 'Loading...'}
            color="#27ae60"
            icon="💾"
          />
        </div>

        {/* Docker Containers */}
        {systemData?.containers && systemData.containers.length > 0 && (
          <div className={`card ${styles.containersCard}`}>
            <div className={styles.containersHeader}>
              <span>Container</span>
              <span>CPU</span>
              <span>Memory</span>
              <span>Status</span>
            </div>
            {systemData.containers.map((c) => (
              <ContainerRow key={c.name} container={c} />
            ))}
          </div>
        )}
      </section>

      {/* Stats Grid */}
      <div className={styles.statsGrid}>
        {metrics.map((stat) => (
          <div key={stat.label} className={`card ${styles.statCard}`}>
            <span className={styles.statIcon}>{stat.icon}</span>
            <div>
              <div className={styles.statValue}>{stat.value}</div>
              <div className={styles.statLabel}>{stat.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Services */}
      <section className={styles.section}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-4)' }}>
          <h2 className={styles.sectionTitle} style={{ margin: 0 }}>System Status</h2>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => mutate()}
            disabled={isLoading}
          >
            {isLoading ? 'Checking...' : 'Refresh Status'}
          </button>
        </div>

        <div className={styles.servicesGrid}>
          {services.map((service) => (
            <ServiceCard key={service.name} {...service} />
          ))}
        </div>
      </section>



      {/* Activity Feed */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Recent Activity</h2>
        <div className={`card ${styles.activityCard}`}>
          {activityData?.activity && activityData.activity.length > 0 ? (
            <div className={styles.activityList}>
              {activityData.activity.map((event, i) => (
                <ActivityRow key={`${event.created_at}-${i}`} event={event} />
              ))}
            </div>
          ) : (
            <div className={styles.emptyActivity}>
              <span>📭</span>
              <p>No activity yet. Events appear when agents make API calls.</p>
            </div>
          )}
        </div>
      </section>

      {/* Quick Connect */}
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
      "url": "https://mcp.hub.jackle.dev/mcp",
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
