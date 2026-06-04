'use client'

import { useEffect, useState, useRef } from 'react'
import { usePathname } from 'next/navigation'
import Sidebar from './Sidebar'
import SetupGuard from './SetupGuard'
import styles from './DashboardLayout.module.css'

import useSWR from 'swr'
import { checkHealth } from '@/lib/api'
import { AlertTriangle, X } from 'lucide-react'

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

  // Sidebar collapse state (persisted in localStorage)
  const [isCollapsed, setIsCollapsed] = useState(false)

  // Global health check SWR
  const { data: healthData, error: healthError } = useSWR('health', checkHealth, {
    refreshInterval: 15000,
  })

  const [dismissedWarnings, setDismissedWarnings] = useState<Record<string, boolean>>({})

  // Clear dismissed warnings when navigating to a new tab/path
  useEffect(() => {
    setDismissedWarnings({})
  }, [pathname])

  useEffect(() => {
    const saved = localStorage.getItem('sidebar-collapsed')
    if (saved === 'true') {
      setIsCollapsed(true)
    }
  }, [])

  const toggleSidebar = () => {
    setIsCollapsed(prev => {
      const next = !prev
      localStorage.setItem('sidebar-collapsed', String(next))
      return next
    })
  }

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

  const isApiDown = !!healthError
  const ollamaError = healthData?.services?.ollama === 'error' ? (healthData.ollamaError || 'Ollama service is unreachable') : null
  const chatModelError = healthData?.services?.chatModel === 'error' ? (healthData.chatModelError || 'Chat model connection failed') : null

  // Check if other docker services are down
  const failedServices = healthData?.services
    ? Object.entries(healthData.services)
        .filter(([name, status]) => status === 'error' && name !== 'ollama' && name !== 'chatModel')
        .map(([name]) => name)
    : []

  const warnings: { id: string; message: string; type: 'error' | 'warning' }[] = []

  if (isApiDown) {
    warnings.push({
      id: 'api_down',
      message: 'Cortex Hub API is offline. Make sure the backend docker Compose services are running.',
      type: 'error',
    })
  } else {
    if (ollamaError) {
      warnings.push({
        id: 'ollama_down',
        message: `Ollama Service is offline: ${ollamaError}`,
        type: 'error',
      })
    }
    if (chatModelError) {
      warnings.push({
        id: 'chat_model_down',
        message: `Active Chat Model is failing: ${chatModelError}`,
        type: 'error',
      })
    }
    if (failedServices.length > 0) {
      warnings.push({
        id: 'services_down',
        message: `Background service(s) offline: ${failedServices.join(', ')}. Check docker status.`,
        type: 'warning',
      })
    }
  }

  const activeWarnings = warnings.filter((w) => !dismissedWarnings[w.id])

  return (
    <SetupGuard>
      <div className={`${styles.wrapper} ${isCollapsed ? styles.collapsed : ''}`}>
        <Sidebar isCollapsed={isCollapsed} toggleSidebar={toggleSidebar} />
        <main className={styles.main}>
          {title && (
            <header className={styles.pageHeader}>
              <h1 className={styles.title}>{title}</h1>
              {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
            </header>
          )}

          {activeWarnings.length > 0 && (
            <div className={styles.warningContainer}>
              {activeWarnings.map((w) => (
                <div key={w.id} className={`${styles.warningBanner} ${styles[w.type]}`}>
                  <span className={styles.warningIcon}>
                    <AlertTriangle size={16} />
                  </span>
                  <span className={styles.warningText}>{w.message}</span>
                  <button
                    className={styles.warningClose}
                    onClick={() => setDismissedWarnings((prev) => ({ ...prev, [w.id]: true }))}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
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
