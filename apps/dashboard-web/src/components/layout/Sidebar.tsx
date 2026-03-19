'use client'

import { usePathname } from 'next/navigation'
import Link from 'next/link'
import styles from './Sidebar.module.css'

const navItems = [
  { href: '/', label: 'Dashboard', icon: '◈' },
  { href: '/orgs', label: 'Organizations', icon: '🏢' },
  { href: '/keys', label: 'API Keys', icon: '⚿' },
  { href: '/providers', label: 'LLM Providers', icon: '⬡' },
  { href: '/usage', label: 'Usage', icon: '📊' },
  { href: '/quality', label: 'Quality', icon: '✦' },
  { href: '/sessions', label: 'Sessions', icon: '⇄' },
  { href: '/settings', label: 'Settings', icon: '⚙' },
]

export default function Sidebar() {
  const pathname = usePathname()

  return (
    <aside className={styles.sidebar}>
      {/* Brand */}
      <div className={styles.brand}>
        <div className={styles.logo}>
          <span className={styles.logoIcon}>◇</span>
          <span className={styles.logoText}>Cortex Hub</span>
        </div>
        <span className={styles.version}>v0.1</span>
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
          <span className="status-dot healthy" />
          <span className={styles.statusText}>All systems online</span>
        </div>
      </div>
    </aside>
  )
}
