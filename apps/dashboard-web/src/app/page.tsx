'use client'

import DashboardLayout from '@/components/layout/DashboardLayout'
import useSWR from 'swr'
import { checkHealth, getDashboardStats, getActivityFeed, type ActivityEvent } from '@/lib/api'
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

  const services: ServiceCardProps[] = [
    {
      name: 'Hub Backend API',
      description: 'Core API for Cortex Hub operations',
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
      name: 'Neo4j Graph DB',
      description: 'Graph database — knowledge relationships',
      endpoint: 'Local Docker :7687',
      status: isLoading ? 'muted' : healthData?.services?.neo4j === 'ok' ? 'healthy' : 'error',
    },
    {
      name: 'CLIProxy (LLM)',
      description: 'LLM gateway — OAuth proxy to AI providers',
      endpoint: 'Local Docker :8317',
      status: isLoading ? 'muted' : healthData?.services?.cliproxy === 'ok' ? 'healthy' : 'error',
    },
    {
      name: 'mem0 Memory',
      description: 'Agent memory — persistent knowledge store',
      endpoint: 'Local Docker :8050',
      status: isLoading ? 'muted' : healthData?.services?.mem0 === 'ok' ? 'healthy' : 'error',
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
