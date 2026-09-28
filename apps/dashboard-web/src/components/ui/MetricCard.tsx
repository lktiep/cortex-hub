import React from 'react'
import { Sparkline } from './Sparkline'
import { TrendBadge } from './TrendBadge'
import type { LucideIcon } from '@/lib/icons'
import { ICON_DEFAULTS } from '@/lib/icons'
import styles from './MetricCard.module.css'

export interface MetricCardProps {
  /** Lucide icon component */
  Icon: LucideIcon
  /** Primary display value (supports ReactNode for skeletons / transitions) */
  value: React.ReactNode
  /** Metric label */
  label: string
  /** Optional trend percentage (renders TrendBadge) */
  trendValue?: number
  /** Optional sparkline data points */
  sparklineData?: number[]
  /** Accent color for sparkline */
  color?: string
  /** Stagger animation index */
  index?: number
}

export function MetricCard({
  Icon,
  value,
  label,
  trendValue,
  sparklineData,
  color,
  index = 0,
}: MetricCardProps) {
  return (
    <div
      className={styles.metricCard}
      style={{ '--stagger-index': index, '--spark-color': color || '#4a90d9' } as React.CSSProperties}
    >
      <div className={styles.header}>
        <span className={styles.icon}>
          <Icon size={16} strokeWidth={ICON_DEFAULTS.strokeWidth} />
        </span>
        {/* Full label, no truncation — wraps to a second line rather than
            losing characters to an ellipsis. The trend badge lives on the
            value row below so it never competes with the label for width. */}
        <span className={styles.label}>{label}</span>
      </div>
      <div className={styles.valueRow}>
        <span className={`${styles.value} live-value`}>{value}</span>
        {trendValue !== undefined && <TrendBadge value={trendValue} className={styles.trendBadge} />}
      </div>
      {sparklineData && (
        <div className={styles.sparkline}>
          <Sparkline data={sparklineData} color={color || '#4a90d9'} width={100} height={28} responsive />
        </div>
      )}
    </div>
  )
}
