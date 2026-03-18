'use client'

import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { getSetupStatus } from '@/lib/api'

export default function SetupGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [isReady, setIsReady] = useState(false)

  useEffect(() => {
    async function checkSetup() {
      if (pathname === '/setup') {
        setIsReady(true)
        return
      }

      try {
        const { completed } = await getSetupStatus()
        if (!completed) {
          router.push('/setup')
        } else {
          setIsReady(true)
        }
      } catch (err) {
        console.error('Failed to check setup status:', err)
        // If API fails, default to setup on local dev or unready
        setIsReady(true)
      }
    }

    checkSetup()
  }, [pathname, router])

  if (!isReady && pathname !== '/setup') {
    return (
      <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '1rem' }}>
        <div className="spinner" style={{ width: 40, height: 40, border: '3px solid var(--border)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
        <span style={{ color: 'var(--text-secondary)' }}>Initializing Hub...</span>
        <style>{`@keyframes spin { 100% { transform: rotate(360deg); } }`}</style>
      </div>
    )
  }

  return <>{children}</>
}
