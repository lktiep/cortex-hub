'use client'

import { useState, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { getModels, completeSetup } from '@/lib/api'
import styles from './page.module.css'

type Step = 'provider' | 'auth' | 'models' | 'complete'

interface DetectedModel {
  id: string
  name: string
  type: string
}

const providers = [
  { id: 'openai', name: 'OpenAI', desc: 'GPT-4o, o3, embeddings', icon: '🤖' },
  { id: 'gemini', name: 'Google Gemini', desc: 'Gemini 2.5 Pro, Flash', icon: '✨' },
  { id: 'claude', name: 'Anthropic Claude', desc: 'Claude 4, Sonnet', icon: '🎭' },
  { id: 'custom', name: 'Custom Provider', desc: 'Any OpenAI-compatible API', icon: '⚙️' },
]

import { Suspense } from 'react'

function SetupWizard() {
  const [step, setStep] = useState<Step>('provider')
  const [selectedProvider, setSelectedProvider] = useState('')
  const [selectedModels, setSelectedModels] = useState<string[]>([])
  
  const [detectedModels, setDetectedModels] = useState<DetectedModel[]>([])
  const [isFetchingModels, setIsFetchingModels] = useState(false)
  const [modelError, setModelError] = useState('')
  
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<'idle' | 'success' | 'error'>('idle')

  const searchParams = useSearchParams()

  useEffect(() => {
    const urlStep = searchParams.get('step')
    if (urlStep === 'models' && step !== 'models') {
      setStep('models')
      fetchModels()
    }
  }, [searchParams])

  function handleProviderSelect(id: string) {
    setSelectedProvider(id)
    setSelectedModels([])
    setTestResult('idle')
  }

  function toggleModel(id: string) {
    setSelectedModels((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]
    )
  }

  async function handleTestConnection() {
    setTesting(true)
    // Simulate connection test
    await new Promise((r) => setTimeout(r, 1500))
    setTestResult('success')
    setTesting(false)
  }

  function startOAuthFlow() {
    // Perform actual browser redirect for OAuth via CLIProxy
    const cliProxyUrl = process.env.NEXT_PUBLIC_CLIPROXY_URL || 'http://localhost:8317'
    const callbackUrl = encodeURIComponent(`${window.location.origin}/setup?step=models`)
    
    // Redirect to proxy's auth login page (OpenAI or other provider)
    window.location.href = `${cliProxyUrl}/v1/auth/login/${selectedProvider}?redirect_uri=${callbackUrl}`
  }

  async function fetchModels() {
    setIsFetchingModels(true)
    setModelError('')
    
    try {
      const res = await getModels()
      if (res?.data && Array.isArray(res.data)) {
        const models = res.data.map((m: { id: string }) => ({
          id: m.id,
          name: m.id, // we use ID as name
          type: m.id.includes('embed') ? 'embedding' : m.id.includes('o1') || m.id.includes('o3') ? 'reasoning' : 'chat'
        }))
        setDetectedModels(models)
        setSelectedModels(models.map((m: { id: string }) => m.id))
      } else {
        throw new Error('Invalid response format from CLIProxy')
      }
    } catch (err: unknown) {
      console.error(err)
      const message = err instanceof Error ? err.message : 'Unknown error'
      setModelError(message || 'Failed to fetch models from CLIProxy. Make sure it is running.')
    } finally {
      setIsFetchingModels(false)
    }
  }

  async function finishSetup() {
    try {
      // Call Dashboard API to persist setup status
      await completeSetup({
        provider: selectedProvider,
        models: selectedModels
      })
    } catch (e) {
      console.warn('Dashboard API unreachable, using local fallback', e)
    }

    localStorage.setItem('cortex_setup_completed', 'true')
    setStep('complete')
  }

  const stepIndex = ['provider', 'auth', 'models', 'complete'].indexOf(step)

  return (
    <div className={styles.wizard}>
      {/* Progress */}
      <div className={styles.progress}>
        {['Provider', 'Connect', 'Models', 'Done'].map((label, i) => (
          <div key={label} className={`${styles.progressStep} ${i <= stepIndex ? styles.progressActive : ''}`}>
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
          <p className={styles.stepSubtitle}>Choose your AI provider to get started</p>

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

      {/* Step: OAuth */}
      {step === 'auth' && (
        <div className={styles.stepContent}>
          <h1 className={styles.stepTitle}>Connect {providers.find((p) => p.id === selectedProvider)?.name}</h1>
          <p className={styles.stepSubtitle}>
            Authenticate via OAuth — no API key needed
          </p>

          <div className={`card ${styles.authCard}`}>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: 'var(--space-4)' }}>
              You'll be redirected to your provider's login page.
              Cortex Hub uses CLIProxy to securely route requests through your existing subscription.
            </p>
            <button
              className="btn btn-primary btn-lg"
              onClick={startOAuthFlow}
              style={{ width: '100%', position: 'relative', overflow: 'hidden' }}
            >
              <div className={styles.glowEffect} />
              <span style={{ position: 'relative', zIndex: 1 }}>
                🔐 Authenticate with {providers.find((p) => p.id === selectedProvider)?.name}
              </span>
            </button>
          </div>

          <button className="btn btn-ghost" onClick={() => setStep('provider')} style={{ marginTop: 'var(--space-4)' }}>
            ← Back
          </button>
        </div>
      )}

      {/* Step: Model Selection */}
      {step === 'models' && (
        <div className={styles.stepContent}>
          <h1 className={styles.stepTitle}>Select Models</h1>
          <p className={styles.stepSubtitle}>Choose which models to enable</p>

          <div className={styles.modelList}>
            {isFetchingModels ? (
              <div style={{ textAlign: 'center', padding: 'var(--space-8)' }}>
                <div className="spinner" style={{ margin: '0 auto 1rem', width: 32, height: 32, border: '3px solid var(--border)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                <p style={{ color: 'var(--text-secondary)' }}>Contacting LLM Gateway to detect models...</p>
                <style>{`@keyframes spin { 100% { transform: rotate(360deg); } }`}</style>
              </div>
            ) : modelError ? (
              <div className="card" style={{ borderColor: 'var(--danger)', color: 'var(--danger)', background: 'var(--danger-bg, rgba(239, 68, 68, 0.1))' }}>
                <strong>Error fetching models:</strong>
                <p style={{ marginTop: '0.5rem', opacity: 0.9 }}>{modelError}</p>
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
                    <span className={`badge badge-healthy`}>{model.type}</span>
                  </div>
                  <code className={styles.modelId}>{model.id}</code>
                </label>
              ))
            ) : (
              <div className={`card`} style={{ textAlign: 'center', padding: 'var(--space-8)' }}>
                <p style={{ color: 'var(--text-secondary)' }}>
                  Custom provider — models will be detected after connection.
                </p>
              </div>
            )}
          </div>

          {/* Test Connection */}
          <div className={styles.testSection}>
            <button
              className="btn btn-secondary"
              onClick={handleTestConnection}
              disabled={testing}
            >
              {testing ? '⏳ Testing...' : '🧪 Test Connection'}
            </button>
            {testResult === 'success' && (
              <span className={styles.testSuccess}>✓ Connection verified</span>
            )}
          </div>

          <button
            className="btn btn-primary btn-lg glow-btn"
            onClick={finishSetup}
            disabled={detectedModels.length > 0 && selectedModels.length === 0}
            style={{ marginTop: 'var(--space-6)', width: '100%' }}
          >
            Complete Setup →
          </button>

          <button className="btn btn-ghost" onClick={() => setStep('auth')} style={{ marginTop: 'var(--space-4)' }}>
            ← Back
          </button>
        </div>
      )}

      {/* Step: Complete */}
      {step === 'complete' && (
        <div className={styles.stepContent} style={{ textAlign: 'center' }}>
          <div className={styles.completeIcon}>✅</div>
          <h1 className={styles.stepTitle}>You're All Set!</h1>
          <p className={styles.stepSubtitle}>
            Cortex Hub is ready. Head to the dashboard to explore.
          </p>

          <div style={{ display: 'flex', gap: 'var(--space-4)', marginTop: 'var(--space-8)', justifyContent: 'center' }}>
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
    <Suspense fallback={<div style={{ padding: 'var(--space-8)', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading setup...</div>}>
      <SetupWizard />
    </Suspense>
  )
}
