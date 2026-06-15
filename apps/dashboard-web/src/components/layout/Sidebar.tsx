'use client'

import { useState, useCallback, useEffect } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import useSWR from 'swr'
import { checkHealth } from '@/lib/api'
import { NAV_ICONS, ICON_DEFAULTS } from '@/lib/icons'
import { StatusDot } from '@/components/ui/StatusDot'
import styles from './Sidebar.module.css'

const navItems = [
  { href: '/', label: 'Dashboard' },
  { href: '/orgs', label: 'Organizations' },
  { href: '/knowledge', label: 'Knowledge' },
  { href: '/keys', label: 'API Keys' },
  { href: '/providers', label: 'LLM Providers' },
  { href: '/usage', label: 'Usage' },
  { href: '/quality', label: 'Quality' },
  { href: '/conductor', label: 'Conductor' },
  { href: '/sessions', label: 'Sessions' },
  { href: '/settings', label: 'Settings' },
]

interface SidebarProps {
  isCollapsed: boolean
  toggleSidebar: () => void
}

export default function Sidebar({ isCollapsed, toggleSidebar }: SidebarProps) {
  const pathname = usePathname()
  const [isOpen, setIsOpen] = useState(false)
  const { data: health } = useSWR('health', checkHealth, { refreshInterval: 30000 })

  const [showConductor, setShowConductor] = useState(true)

  useEffect(() => {
    const checkConductor = () => {
      const val = localStorage.getItem('cortex-show-conductor')
      if (val !== null) {
        setShowConductor(val === 'true')
      }
    }
    checkConductor()
    window.addEventListener('cortex-config-changed', checkConductor)
    return () => window.removeEventListener('cortex-config-changed', checkConductor)
  }, [])

  const commitShort = health?.commit && health.commit !== 'dev'
    ? health.commit.slice(0, 7)
    : 'dev'
  const isOnline = health?.status === 'ok' || health?.status === 'degraded'

  const closeSidebar = useCallback(() => setIsOpen(false), [])

  // Close sidebar on route change (mobile)
  useEffect(() => {
    closeSidebar()
  }, [pathname, closeSidebar])

  // Prevent body scroll when sidebar is open on mobile
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [isOpen])

  const filteredNavItems = navItems.filter((item) => {
    if (!showConductor && (item.href === '/conductor' || item.href === '/sessions')) {
      return false
    }
    return true
  })

  return (
    <>
      {/* Hamburger button — visible only on mobile via CSS */}
      <button
        className={styles.hamburger}
        onClick={() => setIsOpen(true)}
        aria-label="Open navigation"
      >
        <span className={styles.hamburgerBar} />
        <span className={styles.hamburgerBar} />
        <span className={styles.hamburgerBar} />
      </button>

      {/* Backdrop overlay — visible only when sidebar is open on mobile */}
      {isOpen && (
        <div
          className={styles.backdrop}
          onClick={closeSidebar}
          aria-hidden="true"
        />
      )}

      <aside className={`${styles.sidebar} ${isCollapsed ? styles.collapsed : ''} ${isOpen ? styles.open : ''}`}>
        {/* Brand */}
        <div className={styles.brand}>
          <div className={styles.logo}>
            <span className={styles.logoIcon}>◇</span>
            {!isCollapsed && <span className={styles.logoText}>Cortex Hub</span>}
          </div>
          {!isCollapsed && <span className={styles.version}>v{health?.version ?? '0.1'}</span>}
          
          {/* Desktop Collapse Toggle */}
          <button
            onClick={toggleSidebar}
            className={styles.collapseButton}
            aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {isCollapsed ? '▶' : '◀'}
          </button>
        </div>

        {/* Navigation */}
        <nav className={styles.nav}>
          {filteredNavItems.map((item) => {
            const isActive = pathname === item.href ||
              (item.href !== '/' && pathname.startsWith(item.href))
            const IconComponent = NAV_ICONS[item.href]
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`${styles.navItem} ${isActive ? styles.active : ''}`}
                onClick={closeSidebar}
                title={isCollapsed ? item.label : undefined}
              >
                <span className={styles.navIcon}>
                  {IconComponent && <IconComponent size={ICON_DEFAULTS.size} strokeWidth={ICON_DEFAULTS.strokeWidth} />}
                </span>
                {!isCollapsed && <span className={styles.navLabel}>{item.label}</span>}
                {isActive && <span className={styles.activeIndicator} />}
              </Link>
            )
          })}
        </nav>

        {/* Footer */}
        <div className={styles.footer}>
          {isCollapsed ? (
            <div className={styles.statusDotWrapper} title={isOnline ? 'All systems online' : 'Connecting...'}>
              <StatusDot variant={isOnline ? 'healthy' : 'error'} />
            </div>
          ) : (
            <>
              <div className={styles.statusRow}>
                <StatusDot variant={isOnline ? 'healthy' : 'error'} />
                <span className={styles.statusText}>
                  {isOnline ? 'All systems online' : 'Connecting...'}
                </span>
              </div>
              <div className={styles.commitRow} title={`Version: v${health?.version ?? '0.0.0'}\nCommit: ${health?.commit ?? 'dev'}\nBuilt: ${health?.buildDate ?? 'N/A'}`}>
                <code className={styles.commitHash}>
                  v{health?.version ?? '0.0.0'}{commitShort !== 'dev' ? ` · ${commitShort}` : ''}
                </code>
              </div>
            </>
          )}
        </div>
      </aside>
    </>
  )
}
