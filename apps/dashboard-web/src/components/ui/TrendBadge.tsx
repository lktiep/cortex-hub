import React from 'react'
import { ArrowUp, ArrowDown, Minus } from 'lucide-react'
import styles from './TrendBadge.module.css'

interface TrendBadgeProps {
  value: number // Percentage positive or negative (e.g. 12 or -5)
  /** Extra class for layout placement (e.g. positioning within a value row) */
  className?: string
}

export function TrendBadge({ value, className }: TrendBadgeProps) {
  const variant = value > 0 ? 'up' : value < 0 ? 'down' : 'flat'
  const Icon = value > 0 ? ArrowUp : value < 0 ? ArrowDown : Minus

  return (
    <span className={`${styles.badge} ${styles[variant]}${className ? ` ${className}` : ''}`}>
      <Icon size={11} strokeWidth={2.5} className={styles.arrow} />
      {Math.abs(value)}%
    </span>
  )
}
