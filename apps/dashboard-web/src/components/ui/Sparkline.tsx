import React from 'react'

interface SparklineProps {
  data: number[]
  color?: string
  width?: number
  height?: number
  strokeWidth?: number
  /** Show gradient fill beneath the line */
  fill?: boolean
  /** Stretch to fill the parent's width (viewBox keeps using `width` as its coordinate space) */
  responsive?: boolean
  className?: string
}

let sparklineIdCounter = 0

export function Sparkline({
  data,
  color = 'currentColor',
  width = 80,
  height = 24,
  strokeWidth = 2,
  fill = true,
  responsive = false,
  className,
}: SparklineProps) {
  if (!data || data.length === 0) return null

  const gradientId = React.useMemo(() => `spark-grad-${++sparklineIdCounter}`, [])

  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1

  // Map data points into coordinate pairs
  const points = data.map((d, i) => ({
    x: (i / (data.length - 1)) * width,
    y: height - ((d - min) / range) * (height - strokeWidth * 2) - strokeWidth,
  }))

  const linePath = `M ${points.map((p) => `${p.x},${p.y}`).join(' L ')}`

  // Closed area path for gradient fill
  const areaPath = fill
    ? `${linePath} L ${width},${height} L 0,${height} Z`
    : undefined

  return (
    <svg
      width={responsive ? '100%' : width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      fill="none"
      className={className}
      style={{ display: 'block', verticalAlign: 'middle' }}
    >
      {fill && (
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.25} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
      )}
      {areaPath && (
        <path d={areaPath} fill={`url(#${gradientId})`} />
      )}
      <path
        d={linePath}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
