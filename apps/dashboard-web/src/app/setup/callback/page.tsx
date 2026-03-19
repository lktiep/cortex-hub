'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://cortex-api.jackle.dev'

function CallbackContent() {
  const searchParams = useSearchParams()
  const [status, setStatus] = useState<'processing' | 'relaying' | 'success' | 'error'>('processing')
  const [message, setMessage] = useState('Processing authentication...')

  useEffect(() => {
    const code = searchParams.get('code')
    const state = searchParams.get('state')
    const scope = searchParams.get('scope')
    const error = searchParams.get('error')

    if (error) {
      setStatus('error')
      setMessage(`Authentication failed: ${error}`)
      return
    }

    if (!code || !state) {
      setStatus('error')
      setMessage('Missing authentication parameters (code or state)')
      return
    }

    // Relay the auth code to Dashboard-API → CLIProxy
    setStatus('relaying')
    setMessage('Completing authentication...')

    fetch(`${API_URL}/api/setup/oauth/relay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, state, scope }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.success) {
          setStatus('success')
          setMessage('Authentication successful! You can close this window.')

          // Notify parent window (setup wizard) that OAuth completed
          if (window.opener) {
            window.opener.postMessage(
              { type: 'cortex-oauth-callback', status: 'success', state },
              '*'
            )
          }

          // Auto-close popup after a brief delay
          setTimeout(() => {
            window.close()
          }, 1500)
        } else {
          setStatus('error')
          setMessage(data.error || 'Authentication failed. Please try again.')

          if (window.opener) {
            window.opener.postMessage(
              { type: 'cortex-oauth-callback', status: 'error', error: data.error },
              '*'
            )
          }
        }
      })
      .catch((err) => {
        setStatus('error')
        setMessage(`Network error: ${String(err)}`)

        if (window.opener) {
          window.opener.postMessage(
            { type: 'cortex-oauth-callback', status: 'error', error: String(err) },
            '*'
          )
        }
      })
  }, [searchParams])

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      background: '#0a0a0f',
      color: '#e0e0e0',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      padding: '2rem',
      textAlign: 'center',
    }}>
      <div style={{
        background: 'rgba(255, 255, 255, 0.05)',
        borderRadius: '16px',
        padding: '2rem 3rem',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        maxWidth: '400px',
      }}>
        {status === 'processing' || status === 'relaying' ? (
          <>
            <div style={{ fontSize: '2rem', marginBottom: '1rem' }}>
              <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⟳</span>
            </div>
            <p style={{ fontSize: '1.125rem', fontWeight: 600 }}>{message}</p>
            <p style={{ fontSize: '0.8125rem', color: '#888', marginTop: '0.5rem' }}>
              {status === 'relaying' ? 'Exchanging credentials with the server...' : 'Please wait...'}
            </p>
          </>
        ) : status === 'success' ? (
          <>
            <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>✓</div>
            <p style={{ fontSize: '1.125rem', fontWeight: 600, color: '#4ade80' }}>{message}</p>
            <p style={{ fontSize: '0.8125rem', color: '#888', marginTop: '0.5rem' }}>
              This window will close automatically.
            </p>
          </>
        ) : (
          <>
            <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>✗</div>
            <p style={{ fontSize: '1.125rem', fontWeight: 600, color: '#f87171' }}>{message}</p>
            <button
              onClick={() => window.close()}
              style={{
                marginTop: '1rem',
                padding: '0.5rem 1.5rem',
                background: 'rgba(255, 255, 255, 0.1)',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                borderRadius: '8px',
                color: '#e0e0e0',
                cursor: 'pointer',
                fontSize: '0.875rem',
              }}
            >
              Close
            </button>
          </>
        )}
      </div>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}

export default function OAuthCallbackPage() {
  return (
    <Suspense fallback={
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        minHeight: '100vh', background: '#0a0a0f', color: '#e0e0e0',
      }}>
        Loading...
      </div>
    }>
      <CallbackContent />
    </Suspense>
  )
}
