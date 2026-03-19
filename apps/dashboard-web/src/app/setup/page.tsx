'use client'

import { useState, useEffect, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import {
  getModels,
  completeSetup,
  testConnection,
  startOAuth,
  pollOAuthStatus,
  configureProvider,
} from '@/lib/api'
import { config } from '@/lib/config'
import styles from './page.module.css'

type Step = 'provider' | 'auth' | 'models' | 'complete'
type AuthMethod = 'oauth' | 'apikey'

interface DetectedModel {
  id: string
  name: string
  type: string
}

const providers = [
  {
    id: 'openai',
    name: 'OpenAI',
    desc: 'GPT-4o, o3, Codex (via subscription)',
    icon: '🤖',
    supportsOAuth: true,
    oauthLabel: 'ChatGPT Plus/Pro',
    keyPlaceholder: 'sk-...',
    keyHint: 'platform.openai.com/api-keys',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    desc: 'Gemini 2.5 Pro, Flash',
    icon: '✨',
    supportsOAuth: true,
    oauthLabel: 'Google Account',
    keyPlaceholder: 'AIzaSy...',
    keyHint: 'aistudio.google.com/apikey',
  },
  {
    id: 'claude',
    name: 'Anthropic Claude',
    desc: 'Claude 4, Sonnet',
    icon: '🎭',
    supportsOAuth: true,
    oauthLabel: 'Claude Pro/Max',
    keyPlaceholder: 'sk-ant-...',
    keyHint: 'console.anthropic.com/keys',
  },
  {
    id: 'custom',
    name: 'Custom Provider',
    desc: 'Any OpenAI-compatible API',
    icon: '⚙️',
    supportsOAuth: false,
    oauthLabel: '',
    keyPlaceholder: 'sk-...',
    keyHint: 'Enter your provider API key',
  },
]

function SetupWizard() {
  const [step, setStep] = useState<Step>('provider')
  const [selectedProvider, setSelectedProvider] = useState('')
  const [authMethod, setAuthMethod] = useState<AuthMethod>('oauth')
  const [selectedModels, setSelectedModels] = useState<string[]>([])

  // Auth state
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [isAuthenticating, setIsAuthenticating] = useState(false)
  const [authError, setAuthError] = useState('')
  const [_oauthState, setOauthState] = useState('')
  const [callbackUrl, setCallbackUrl] = useState('')
  const [isRelaying, setIsRelaying] = useState(false)

  // Models state
  const [detectedModels, setDetectedModels] = useState<DetectedModel[]>([])
  const [isFetchingModels, setIsFetchingModels] = useState(false)
  const [modelError, setModelError] = useState('')

  // Test connection state
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<'idle' | 'success' | 'error'>('idle')

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const authWindowRef = useRef<Window | null>(null)
  const searchParams = useSearchParams()

  // Listen for postMessage from OAuth callback popup
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.data?.type !== 'cortex-oauth-callback') return

      // OAuth relay completed in the popup
      if (event.data.status === 'success') {
        setIsAuthenticating(false)
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current)
          pollTimerRef.current = null
        }
        // Move to models step
        setStep('models')
        fetchModels()
      } else if (event.data.status === 'error') {
        setIsAuthenticating(false)
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current)
          pollTimerRef.current = null
        }
        setAuthError(event.data.error || 'OAuth failed in callback')
      }
    }

    window.addEventListener('message', handleMessage)
    return () => {
      window.removeEventListener('message', handleMessage)
      if (pollTimerRef.current) clearInterval(pollTimerRef.current)
    }
  }, [])

  // Handle URL params (e.g. redirected back from setup/callback in same window)
  useEffect(() => {
    const urlStep = searchParams.get('step')
    const urlOauth = searchParams.get('oauth')
    if ((urlStep === 'models' || urlOauth === 'success') && step !== 'models') {
      setStep('models')
      fetchModels()
    }
  }, [searchParams])

  const currentProvider = providers.find((p) => p.id === selectedProvider)

  function handleProviderSelect(id: string) {
    setSelectedProvider(id)
    setSelectedModels([])
    setTestResult('idle')
    setAuthError('')
    setApiKeyInput('')
    const provider = providers.find((p) => p.id === id)
    setAuthMethod(provider?.supportsOAuth ? 'oauth' : 'apikey')
  }

  function toggleModel(id: string) {
    setSelectedModels((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]
    )
  }

  // ── OAuth Flow ──
  async function handleStartOAuth() {
    setIsAuthenticating(true)
    setAuthError('')
    setCallbackUrl('')

    try {
      const res = await startOAuth(selectedProvider)

      if (!res.success) {
        throw new Error('Failed to get OAuth URL from CLIProxy')
      }

      // Save state for polling fallback
      setOauthState(res.state)

      // Use the ORIGINAL OAuth URL (with localhost:1455 redirect)
      // because OpenAI only accepts registered redirect_uris
      const oauthUrl = res.originalOauthUrl || res.oauthUrl

      // Open OAuth URL in a NEW TAB (not popup!)
      // Popups block cookies → causes CSRF error at OpenAI auth page
      authWindowRef.current = window.open(oauthUrl, '_blank')

      // Start CLIProxy status polling as fallback
      startFallbackPolling(res.state)
    } catch (err: unknown) {
      setIsAuthenticating(false)
      setAuthError(
        err instanceof Error ? err.message : 'Failed to start OAuth flow'
      )
    }
  }

  // Extract code from pasted localhost callback URL and relay to CLIProxy
  async function handlePasteCallback() {
    if (!callbackUrl.trim()) {
      setAuthError('Please paste the full URL from the error page')
      return
    }

    setIsRelaying(true)
    setAuthError('')

    try {
      // Parse code and state from the pasted URL
      const url = new URL(callbackUrl.trim())
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const scope = url.searchParams.get('scope')

      if (!code || !state) {
        throw new Error('URL does not contain auth code. Make sure you copied the full URL from the browser address bar.')
      }

      // Relay to Dashboard-API → CLIProxy
      const res = await fetch(`${config.api.base}/api/setup/oauth/relay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, state, scope }),
      })
      const data = await res.json()

      if (data.success) {
        // Stop polling
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current)
          pollTimerRef.current = null
        }
        setIsAuthenticating(false)
        setIsRelaying(false)
        // Navigate with URL param — the useEffect checking searchParams
        // will pick this up and transition to models step
        window.location.href = '/setup?oauth=success'
      } else {
        throw new Error(data.error || 'Failed to complete authentication')
      }
    } catch (err: unknown) {
      setIsRelaying(false)
      setAuthError(
        err instanceof Error ? err.message : 'Failed to relay auth code'
      )
    }
  }

  function startFallbackPolling(state: string) {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current)

    let pollCount = 0
    const maxPolls = 180 // 3 minutes

    pollTimerRef.current = setInterval(async () => {
      pollCount++

      if (pollCount > maxPolls) {
        if (pollTimerRef.current) clearInterval(pollTimerRef.current)
        pollTimerRef.current = null
        setIsAuthenticating(false)
        setAuthError('Authentication timed out. Please try again.')
        return
      }

      try {
        const status = await pollOAuthStatus(state)

        if (status.status === 'ok') {
          if (pollTimerRef.current) clearInterval(pollTimerRef.current)
          pollTimerRef.current = null
          setIsAuthenticating(false)
          setStep('models')
          fetchModels()
        } else if (status.status === 'error') {
          if (pollTimerRef.current) clearInterval(pollTimerRef.current)
          pollTimerRef.current = null
          setIsAuthenticating(false)
          setAuthError(status.error || 'Authentication failed')
        }
      } catch {
        // Network error, keep polling
      }
    }, 2000) // Poll every 2s (less aggressive since postMessage is primary)
  }

  // ── API Key Flow ──
  async function handleApiKeySubmit() {
    if (!apiKeyInput.trim()) {
      setAuthError('Please enter your API key')
      return
    }

    setIsAuthenticating(true)
    setAuthError('')

    try {
      const res = await configureProvider({
        provider: selectedProvider,
        apiKey: apiKeyInput.trim(),
      })

      if (res.success) {
        setIsAuthenticating(false)
        setStep('models')
        fetchModels()
      } else {
        throw new Error('Failed to configure provider')
      }
    } catch (err: unknown) {
      setIsAuthenticating(false)
      setAuthError(
        err instanceof Error ? err.message : 'Failed to save API key'
      )
    }
  }

  // ── Models ──
  async function fetchModels() {
    setIsFetchingModels(true)
    setModelError('')

    try {
      const res = await getModels()
      if (res?.data && Array.isArray(res.data)) {
        const models = res.data.map((m: { id: string }) => ({
          id: m.id,
          name: m.id,
          type: m.id.includes('embed')
            ? 'embedding'
            : m.id.includes('o1') || m.id.includes('o3')
              ? 'reasoning'
              : 'chat',
        }))
        setDetectedModels(models)
        setSelectedModels(models.map((m: { id: string }) => m.id))
      } else {
        throw new Error('No models returned — check your API key or subscription')
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      setModelError(message || 'Failed to fetch models from CLIProxy.')
    } finally {
      setIsFetchingModels(false)
    }
  }

  // ── Test Connection ──
  async function handleTestConnection() {
    setTesting(true)
    setModelError('')
    try {
      const res = await testConnection()
      if (res.allPassed) {
        setTestResult('success')
      } else {
        setTestResult('error')
        const failed = Object.entries(res)
          .filter(([k, v]) => !v && k !== 'allPassed')
          .map(([k]) => k)
          .join(', ')
        setModelError(`Connection failed to: ${failed}`)
      }
    } catch (e: unknown) {
      setTestResult('error')
      setModelError(
        `Connection check error: ${e instanceof Error ? e.message : 'Unknown'}`
      )
    } finally {
      setTesting(false)
    }
  }

  // ── Complete Setup ──
  const [setupProgress, setSetupProgress] = useState<string[]>([])
  const [isSettingUp, setIsSettingUp] = useState(false)
  const [setupError, setSetupError] = useState('')

  async function finishSetup() {
    setIsSettingUp(true)
    setSetupError('')
    setSetupProgress([])

    try {
      // Step 1: Configure mem0 with selected model
      setSetupProgress((prev) => [...prev, '🧠 Configuring mem0 memory engine...'])
      try {
        const mem0Url = `${config.api.base}/api/setup/configure-mem0`
        const mem0Res = await fetch(mem0Url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: selectedProvider, models: selectedModels }),
          signal: AbortSignal.timeout(15000),
        })
        if (mem0Res.ok) {
          setSetupProgress((prev) => [...prev, '✅ mem0 configured'])
        } else {
          setSetupProgress((prev) => [...prev, '⚠️ mem0 config skipped (will use defaults)'])
        }
      } catch {
        setSetupProgress((prev) => [...prev, '⚠️ mem0 config skipped (service unreachable)'])
      }

      // Step 2: Save provider configuration
      setSetupProgress((prev) => [...prev, '💾 Saving provider configuration...'])
      await new Promise((resolve) => setTimeout(resolve, 500))
      setSetupProgress((prev) => [...prev, '✅ Provider saved'])

      // Step 3: Mark setup as complete in the database
      setSetupProgress((prev) => [...prev, '🏁 Finalizing setup...'])
      const result = await completeSetup({
        provider: selectedProvider,
        models: selectedModels,
      })

      if (!result || (result as { success?: boolean }).success === false) {
        throw new Error('Backend did not confirm setup completion')
      }

      setSetupProgress((prev) => [...prev, '✅ Setup complete!'])
      localStorage.setItem('cortex_setup_completed', 'true')

      // Brief pause so user can see the success state
      await new Promise((resolve) => setTimeout(resolve, 1500))
      setStep('complete')
    } catch (err) {
      console.error('Setup completion failed:', err)
      setSetupError(
        `Setup failed: ${err instanceof Error ? err.message : 'Unknown error'}. Try again or check if the backend API is running.`
      )
      setIsSettingUp(false)
    }
  }

  const stepIndex = ['provider', 'auth', 'models', 'complete'].indexOf(step)

  return (
    <div className={styles.wizard}>
      {/* Progress */}
      <div className={styles.progress}>
        {['Provider', 'Connect', 'Models', 'Done'].map((label, i) => (
          <div
            key={label}
            className={`${styles.progressStep} ${i <= stepIndex ? styles.progressActive : ''}`}
          >
            <div className={styles.progressDot}>
              {i < stepIndex ? '✓' : i + 1}
            </div>
            <span className={styles.progressLabel}>{label}</span>
          </div>
        ))}
      </div>

      {/* Step: Provider Selection */}
      {step === 'provider' && (
        <div className={styles.stepContent}>
          <h1 className={styles.stepTitle}>Welcome to Cortex Hub</h1>
          <p className={styles.stepSubtitle}>
            Choose your AI provider to get started
          </p>

          <div className={styles.providerGrid}>
            {providers.map((p) => (
              <button
                key={p.id}
                className={`${styles.providerCard} ${selectedProvider === p.id ? styles.providerSelected : ''}`}
                onClick={() => handleProviderSelect(p.id)}
              >
                <span className={styles.providerIcon}>{p.icon}</span>
                <div className={styles.providerName}>{p.name}</div>
                <div className={styles.providerDesc}>{p.desc}</div>
              </button>
            ))}
          </div>

          <button
            className="btn btn-primary btn-lg"
            disabled={!selectedProvider}
            onClick={() => setStep('auth')}
            style={{ marginTop: 'var(--space-6)', width: '100%' }}
          >
            Continue →
          </button>
        </div>
      )}

      {/* Step: Authentication */}
      {step === 'auth' && currentProvider && (
        <div className={styles.stepContent}>
          <h1 className={styles.stepTitle}>
            Connect {currentProvider.name}
          </h1>
          <p className={styles.stepSubtitle}>
            {currentProvider.supportsOAuth
              ? 'Choose how to authenticate — OAuth (subscription) or API Key'
              : 'Enter your API key to connect'}
          </p>

          {/* Auth Method Tabs (only for providers that support OAuth) */}
          {currentProvider.supportsOAuth && (
            <div className={styles.authTabs}>
              <button
                className={`${styles.authTab} ${authMethod === 'oauth' ? styles.authTabActive : ''}`}
                onClick={() => {
                  setAuthMethod('oauth')
                  setAuthError('')
                }}
              >
                🔐 OAuth Login
              </button>
              <button
                className={`${styles.authTab} ${authMethod === 'apikey' ? styles.authTabActive : ''}`}
                onClick={() => {
                  setAuthMethod('apikey')
                  setAuthError('')
                }}
              >
                🔑 API Key
              </button>
            </div>
          )}

          {/* OAuth Method */}
          {authMethod === 'oauth' && currentProvider.supportsOAuth && (
            <div className={`card ${styles.authCard}`}>
              {!isAuthenticating ? (
                /* Step 1: Sign in button */
                <>
                  <p
                    style={{
                      color: 'var(--text-secondary)',
                      fontSize: '0.875rem',
                      marginBottom: 'var(--space-4)',
                    }}
                  >
                    Sign in with your <strong>{currentProvider.oauthLabel}</strong>{' '}
                    subscription. A new window will open for authentication.
                    No API key needed.
                  </p>
                  <button
                    className="btn btn-primary btn-lg"
                    onClick={handleStartOAuth}
                    style={{ width: '100%', position: 'relative', overflow: 'hidden' }}
                  >
                    <div className={styles.glowEffect} />
                    <span style={{ position: 'relative', zIndex: 1 }}>
                      🔐 Sign in with {currentProvider.oauthLabel}
                    </span>
                  </button>
                </>
              ) : (
                /* Step 2: After tab opens — show URL paste input */
                <>
                  <p
                    style={{
                      color: 'var(--text-secondary)',
                      fontSize: '0.875rem',
                      marginBottom: 'var(--space-3)',
                    }}
                  >
                    <strong>Step 1:</strong> Complete login in the new tab.
                  </p>
                  <p
                    style={{
                      color: 'var(--text-secondary)',
                      fontSize: '0.875rem',
                      marginBottom: 'var(--space-4)',
                    }}
                  >
                    <strong>Step 2:</strong> After login, you&apos;ll see a{' '}
                    <em>&quot;Can&apos;t connect to localhost&quot;</em> error.{' '}
                    Copy the <strong>entire URL</strong> from the address bar and paste it here:
                  </p>

                  <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
                    <input
                      type="text"
                      value={callbackUrl}
                      onChange={(e) => setCallbackUrl(e.target.value)}
                      placeholder="localhost:1455/auth/callback?code=..."
                      onKeyDown={(e) =>
                        e.key === 'Enter' && handlePasteCallback()
                      }
                      style={{
                        flex: 1,
                        padding: 'var(--space-3) var(--space-4)',
                        borderRadius: 'var(--radius-md)',
                        border: '1px solid var(--border)',
                        background: 'var(--bg-secondary)',
                        color: 'var(--text-primary)',
                        fontSize: '0.8rem',
                        fontFamily: 'monospace',
                      }}
                    />
                    <button
                      className="btn btn-primary"
                      onClick={handlePasteCallback}
                      disabled={isRelaying || !callbackUrl.trim()}
                    >
                      {isRelaying ? '⏳' : '✓'}
                    </button>
                  </div>

                  <p
                    style={{
                      color: 'var(--text-tertiary)',
                      fontSize: '0.7rem',
                      marginTop: 'var(--space-2)',
                      textAlign: 'center',
                      opacity: 0.7,
                    }}
                  >
                    The URL contains your auth code. It&apos;s never stored and only used
                    to complete the connection.
                  </p>
                </>
              )}
            </div>
          )}

          {/* API Key Method */}
          {(authMethod === 'apikey' || !currentProvider.supportsOAuth) && (
            <div className={`card ${styles.authCard}`}>
              <p
                style={{
                  color: 'var(--text-secondary)',
                  fontSize: '0.875rem',
                  marginBottom: 'var(--space-4)',
                }}
              >
                Enter your API key from{' '}
                <code style={{ fontSize: '0.8rem' }}>
                  {currentProvider.keyHint}
                </code>
              </p>
              <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
                <input
                  type="password"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder={currentProvider.keyPlaceholder}
                  onKeyDown={(e) =>
                    e.key === 'Enter' && handleApiKeySubmit()
                  }
                  style={{
                    flex: 1,
                    padding: 'var(--space-3) var(--space-4)',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--border)',
                    background: 'var(--bg-secondary)',
                    color: 'var(--text-primary)',
                    fontSize: '0.9rem',
                    fontFamily: 'monospace',
                  }}
                />
                <button
                  className="btn btn-primary"
                  onClick={handleApiKeySubmit}
                  disabled={isAuthenticating || !apiKeyInput.trim()}
                >
                  {isAuthenticating ? '⏳' : '→'}
                </button>
              </div>
            </div>
          )}

          {/* Error Display */}
          {authError && (
            <div
              className="card"
              style={{
                borderColor: 'var(--danger)',
                color: 'var(--danger)',
                background: 'rgba(239, 68, 68, 0.1)',
                marginTop: 'var(--space-4)',
              }}
            >
              <strong>Error:</strong> {authError}
            </div>
          )}

          <button
            className="btn btn-ghost"
            onClick={() => {
              setStep('provider')
              if (pollTimerRef.current) {
                clearInterval(pollTimerRef.current)
                pollTimerRef.current = null
              }
              setIsAuthenticating(false)
            }}
            style={{ marginTop: 'var(--space-4)' }}
          >
            ← Back
          </button>
        </div>
      )}

      {/* Step: Model Selection */}
      {step === 'models' && (
        <div className={styles.stepContent}>
          <h1 className={styles.stepTitle}>Select Models</h1>
          <p className={styles.stepSubtitle}>
            Choose which models to enable
          </p>

          <div className={styles.modelList}>
            {isFetchingModels ? (
              <div style={{ textAlign: 'center', padding: 'var(--space-8)' }}>
                <div
                  className="spinner"
                  style={{
                    margin: '0 auto 1rem',
                    width: 32,
                    height: 32,
                    border: '3px solid var(--border)',
                    borderTopColor: 'var(--primary)',
                    borderRadius: '50%',
                    animation: 'spin 1s linear infinite',
                  }}
                />
                <p style={{ color: 'var(--text-secondary)' }}>
                  Detecting available models from your provider...
                </p>
                <style>{`@keyframes spin { 100% { transform: rotate(360deg); } }`}</style>
              </div>
            ) : modelError ? (
              <div
                className="card"
                style={{
                  borderColor: 'var(--danger)',
                  color: 'var(--danger)',
                  background: 'rgba(239, 68, 68, 0.1)',
                }}
              >
                <strong>Error fetching models:</strong>
                <p style={{ marginTop: '0.5rem', opacity: 0.9 }}>
                  {modelError}
                </p>
                <button
                  className="btn btn-secondary"
                  onClick={fetchModels}
                  style={{ marginTop: 'var(--space-3)' }}
                >
                  🔄 Retry
                </button>
              </div>
            ) : detectedModels.length > 0 ? (
              detectedModels.map((model) => (
                <label key={model.id} className={styles.modelItem}>
                  <input
                    type="checkbox"
                    checked={selectedModels.includes(model.id)}
                    onChange={() => toggleModel(model.id)}
                    className={styles.modelCheck}
                  />
                  <div className={styles.modelInfo}>
                    <span className={styles.modelName}>{model.name}</span>
                    <span className="badge badge-healthy">{model.type}</span>
                  </div>
                  <code className={styles.modelId}>{model.id}</code>
                </label>
              ))
            ) : (
              <div
                className="card"
                style={{ textAlign: 'center', padding: 'var(--space-8)' }}
              >
                <p style={{ color: 'var(--text-secondary)' }}>
                  No models detected. Try re-authenticating or check your
                  subscription.
                </p>
                <button
                  className="btn btn-secondary"
                  onClick={fetchModels}
                  style={{ marginTop: 'var(--space-3)' }}
                >
                  🔄 Retry
                </button>
              </div>
            )}
          </div>

          {/* Test Connection (optional) */}
          {!isSettingUp && (
            <div className={styles.testSection}>
              <button
                className="btn btn-secondary"
                onClick={handleTestConnection}
                disabled={testing}
              >
                {testing ? '⏳ Testing...' : '🧪 Test Connection'}
              </button>
              {testResult === 'success' && (
                <span className={styles.testSuccess}>
                  ✓ Connection verified
                </span>
              )}
              {testResult === 'error' && (
                <span
                  className={styles.testError}
                  style={{ color: 'var(--danger)', marginLeft: '1rem' }}
                >
                  ✗ Connection failed
                </span>
              )}
            </div>
          )}

          {/* Setting up progress */}
          {isSettingUp && (
            <div
              className="card"
              style={{
                padding: 'var(--space-5)',
                marginTop: 'var(--space-4)',
                borderColor: 'var(--primary)',
              }}
            >
              <h4 style={{ margin: '0 0 var(--space-3)', color: 'var(--primary)' }}>
                ⚙️ Setting up Cortex Hub...
              </h4>
              {setupProgress.map((msg, i) => (
                <div
                  key={i}
                  style={{
                    fontSize: '0.8125rem',
                    color: 'var(--text-secondary)',
                    padding: '4px 0',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {msg}
                </div>
              ))}
              {setupProgress.length > 0 && !setupError && (
                <div
                  style={{
                    marginTop: 'var(--space-3)',
                    height: '3px',
                    background: 'var(--border-subtle)',
                    borderRadius: '3px',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      height: '100%',
                      background: 'var(--primary)',
                      width: '100%',
                      animation: 'shimmerBar 1.5s ease infinite',
                      borderRadius: '3px',
                    }}
                  />
                </div>
              )}
              <style>{`@keyframes shimmerBar { 0%,100%{opacity:0.4} 50%{opacity:1} }`}</style>
            </div>
          )}

          {/* Setup error */}
          {setupError && (
            <div
              className="card"
              style={{
                padding: 'var(--space-4)',
                marginTop: 'var(--space-3)',
                borderColor: 'var(--danger)',
                color: 'var(--danger)',
                fontSize: '0.8125rem',
              }}
            >
              <strong>Error:</strong> {setupError}
            </div>
          )}

          <button
            className="btn btn-primary btn-lg glow-btn"
            onClick={finishSetup}
            disabled={
              detectedModels.length === 0 ||
              selectedModels.length === 0 ||
              isSettingUp
            }
            style={{ marginTop: 'var(--space-6)', width: '100%' }}
          >
            {isSettingUp ? '⏳ Setting up...' : 'Complete Setup →'}
          </button>

          <button
            className="btn btn-ghost"
            onClick={() => setStep('auth')}
            style={{ marginTop: 'var(--space-4)' }}
          >
            ← Back
          </button>
        </div>
      )}

      {/* Step: Complete */}
      {step === 'complete' && (
        <div className={styles.stepContent} style={{ textAlign: 'center' }}>
          <div className={styles.completeIcon}>✅</div>
          <h1 className={styles.stepTitle}>You&apos;re All Set!</h1>
          <p className={styles.stepSubtitle}>
            Cortex Hub is ready. Head to the dashboard to explore.
          </p>

          <div
            style={{
              display: 'flex',
              gap: 'var(--space-4)',
              marginTop: 'var(--space-8)',
              justifyContent: 'center',
            }}
          >
            <a href="/" className="btn btn-primary btn-lg">
              Open Dashboard →
            </a>
            <a href="/keys" className="btn btn-secondary btn-lg">
              Generate API Key
            </a>
          </div>
        </div>
      )}
    </div>
  )
}

export default function SetupPage() {
  return (
    <Suspense
      fallback={
        <div
          style={{
            padding: 'var(--space-8)',
            textAlign: 'center',
            color: 'var(--text-secondary)',
          }}
        >
          Loading setup...
        </div>
      }
    >
      <SetupWizard />
    </Suspense>
  )
}
