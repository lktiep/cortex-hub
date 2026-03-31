'use client'

import { useState, useEffect } from 'react'
import useSWR from 'swr'
import { getConductorTaskStats } from '@/lib/api'
import styles from './WelcomeBanner.module.css'

interface WelcomeBannerProps {
  agentName?: string
}

function useCurrentTime() {
  const [time, setTime] = useState(() => new Date())

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 60_000)
    return () => clearInterval(timer)
  }, [])

  return time
}

function getGreeting(hour: number): string {
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatDate(date: Date): string {
  return date.toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
}

export default function WelcomeBanner({ agentName = 'Agent' }: WelcomeBannerProps) {
  const now = useCurrentTime()
  const greeting = getGreeting(now.getHours())

  const { data: taskData } = useSWR('conductor-stats', getConductorTaskStats, {
    refreshInterval: 30_000,
  })

  const pendingCount = taskData?.stats?.pending ?? 0
  const activeCount = taskData?.stats?.active ?? 0

  return (
    <div className={styles.banner}>
      {/* Decorative background elements */}
      <div className={styles.bgOrb1} />
      <div className={styles.bgOrb2} />

      <div className={styles.content}>
        <div className={styles.greeting}>
          <h2 className={styles.title}>
            {greeting}, <span className={styles.agentName}>{agentName}</span>
          </h2>
          <p className={styles.subtitle}>
            {formatDate(now)} · {formatTime(now)}
          </p>
        </div>

        <div className={styles.stats}>
          {pendingCount > 0 && (
            <div className={styles.statBadge}>
              <span className={styles.statCount}>{pendingCount}</span>
              <span className={styles.statLabel}>pending</span>
            </div>
          )}
          {activeCount > 0 && (
            <div className={`${styles.statBadge} ${styles.activeBadge}`}>
              <span className={styles.statCount}>{activeCount}</span>
              <span className={styles.statLabel}>active</span>
            </div>
          )}
          {pendingCount === 0 && activeCount === 0 && (
            <div className={styles.allClear}>
              <span className={styles.checkIcon}>✓</span>
              <span>All clear</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
