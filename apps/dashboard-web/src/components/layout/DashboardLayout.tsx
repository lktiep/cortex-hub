'use client'

import { useEffect, useState, useRef } from 'react'
import { usePathname } from 'next/navigation'
import Sidebar from './Sidebar'
import SetupGuard from './SetupGuard'
import styles from './DashboardLayout.module.css'

interface DashboardLayoutProps {
  children: React.ReactNode
  title?: string
  subtitle?: string
  /** Optional section identifier (used by pages like Conductor) */
  section?: string
}

export default function DashboardLayout({ children, title, subtitle, section: _section }: DashboardLayoutProps) {
  const pathname = usePathname()
  const [isVisible, setIsVisible] = useState(false)
  const prevPathRef = useRef(pathname)

  useEffect(() => {
    // On route change: reset visibility then animate in
    if (prevPathRef.current !== pathname) {
      setIsVisible(false)
      prevPathRef.current = pathname
      // Small rAF delay so the opacity:0 frame renders before transitioning
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setIsVisible(true)
        })
      })
    } else {
      // Initial mount
      setIsVisible(true)
    }
  }, [pathname])

  return (
    <SetupGuard>
      <div className={styles.wrapper}>
        <Sidebar />
        <main className={styles.main}>
          {title && (
            <header className={styles.pageHeader}>
              <h1 className={styles.title}>{title}</h1>
              {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
            </header>
          )}
          <div
            className={`${styles.content} ${isVisible ? styles.contentVisible : ''}`}
          >
            {children}
          </div>
        </main>
      </div>
    </SetupGuard>
  )
}
