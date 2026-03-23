'use client'

import { useState, useCallback, useEffect } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import useSWR from 'swr'
import { checkHealth } from '@/lib/api'
import styles from './Sidebar.module.css'

const navItems = [
  { href: '/', label: 'Dashboard', icon: '◈' },
  { href: '/orgs', label: 'Organizations', icon: '🏢' },
  { href: '/knowledge', label: 'Knowledge', icon: '📚' },
  { href: '/keys', label: 'API Keys', icon: '⚿' },
  { href: '/providers', label: 'LLM Providers', icon: '⬡' },
  { href: '/usage', label: 'Usage', icon: '📊' },
  { href: '/quality', label: 'Quality', icon: '✦' },
  { href: '/sessions', label: 'Sessions', icon: '⇄' },
  { href: '/settings', label: 'Settings', icon: '⚙' },
]

export default function Sidebar() {
  const pathname = usePathname()
  const [isOpen, setIsOpen] = useState(false)
  const { data: health } = useSWR('health', checkHealth, { refreshInterval: 30000 })

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

      <aside className={`${styles.sidebar} ${isOpen ? styles.open : ''}`}>
        {/* Brand */}
        <div className={styles.brand}>
          <div className={styles.logo}>
            <span className={styles.logoIcon}>◇</span>
            <span className={styles.logoText}>Cortex Hub</span>
          </div>
          <span className={styles.version}>v{health?.version ?? '0.1'}</span>
        </div>

        {/* Navigation */}
        <nav className={styles.nav}>
          {navItems.map((item) => {
            const isActive = pathname === item.href ||
              (item.href !== '/' && pathname.startsWith(item.href))
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`${styles.navItem} ${isActive ? styles.active : ''}`}
                onClick={closeSidebar}
              >
                <span className={styles.navIcon}>{item.icon}</span>
                <span className={styles.navLabel}>{item.label}</span>
                {isActive && <span className={styles.activeIndicator} />}
              </Link>
            )
          })}
        </nav>

        {/* Footer */}
        <div className={styles.footer}>
          <div className={styles.statusRow}>
            <span className={`status-dot ${isOnline ? 'healthy' : 'unhealthy'}`} />
            <span className={styles.statusText}>
              {isOnline ? 'All systems online' : 'Connecting...'}
            </span>
          </div>
        <div className={styles.commitRow} title={`Version: v${health?.version ?? '0.0.0'}\nCommit: ${health?.commit ?? 'dev'}\nBuilt: ${health?.buildDate ?? 'N/A'}`}>
            <code className={styles.commitHash}>
              v{health?.version ?? '0.0.0'}{commitShort !== 'dev' ? ` · ${commitShort}` : ''}
            </code>
          </div>
        </div>
      </aside>
    </>
  )
}
