'use client'

import { useState, useEffect, type ReactNode } from 'react'
import useSWR from 'swr'
import { getSettings } from '@/lib/api'
import { resolveMcpEndpoint, type McpEndpoint } from '@/lib/config'
import { quickStartCommands } from '@/lib/quick-start'
import { copyToClipboard } from '@/lib/clipboard'
import styles from './KeyQuickStart.module.css'

type Os = 'unix' | 'windows'
type Copyable = 'url' | 'claude' | 'extension' | 'worker'

// This browser remembers a typed MCP URL while the hub doesn't know its public address.
const TYPED_URL_KEY = 'cortex.keyQuickStart.mcpUrl'

const OS_TABS: ReadonlyArray<readonly [Os, string]> = [
  ['unix', 'macOS / Linux'],
  ['windows', 'Windows (PowerShell)'],
]

/** Copy-ready commands that connect a machine with a key that was just created. */
export default function KeyQuickStart({ apiKey }: { apiKey: string }) {
  const { data: settings, error } = useSWR('settings', getSettings)
  // null until settings answer, so a domain deployment doesn't flash the URL input
  const [endpoint, setEndpoint] = useState<McpEndpoint | null>(null)
  const [typedUrl, setTypedUrl] = useState('')
  const [os, setOs] = useState<Os>('unix')
  const [copied, setCopied] = useState<Copyable | null>(null)

  useEffect(() => {
    if (settings || error) setEndpoint(resolveMcpEndpoint(settings?.externalUrls?.mcp, window.location, settings?.externalUrls?.mcpDetected))
  }, [settings, error])

  useEffect(() => {
    if (/Windows/i.test(navigator.userAgent)) setOs('windows')
    try {
      setTypedUrl(localStorage.getItem(TYPED_URL_KEY) ?? '')
    } catch {
      // storage blocked: the input starts empty
    }
  }, [])

  function typeUrl(value: string) {
    setTypedUrl(value)
    try {
      localStorage.setItem(TYPED_URL_KEY, value.trim())
    } catch {
      // storage blocked: the URL lasts until the dialog closes
    }
  }

  async function copy(what: Copyable, text: string) {
    if (await copyToClipboard(text)) {
      setCopied(what)
      setTimeout(() => setCopied((current) => (current === what ? null : current)), 2000)
    }
  }

  const unconfigured = endpoint?.source === 'unconfigured'
  const q = quickStartCommands(unconfigured ? typedUrl : (endpoint?.url ?? null), apiKey)
  const cmds = q[os]

  const steps: ReadonlyArray<{ id: Exclude<Copyable, 'url'>; title: string; cmd: string; hint: ReactNode }> = [
    {
      id: 'claude',
      title: 'Claude Code',
      cmd: cmds.claude,
      hint: 'Adds the cortex-hub MCP server for your user on this machine.',
    },
    {
      id: 'extension',
      title: 'Editor extension',
      cmd: cmds.extension,
      hint: (
        <>
          Installs Cortex Agent into Antigravity, VS Code, Cursor or Windsurf. Then open the
          Agent Panel, click the pencil, paste the MCP URL under <b>Hub</b> and this key under{' '}
          <b>API key</b>, and Save.
        </>
      ),
    },
    {
      id: 'worker',
      title: 'Conductor worker',
      cmd: cmds.worker,
      hint: 'Starts a background worker that takes tasks from the lead. Give each worker its own key.',
    },
  ]

  return (
    <div className={styles.section}>
      <h3 className={styles.heading}>Connect a machine with this key</h3>

      <div className={styles.tabs} role="tablist" aria-label="Operating system">
        {OS_TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={os === id}
            className={`${styles.tab} ${os === id ? styles.tabActive : ''}`}
            onClick={() => setOs(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <div role="tabpanel">
        <div className={styles.urlRow}>
          <span className={styles.label}>MCP URL</span>
          {endpoint === null ? (
            <span className={styles.hint}>Looking it up…</span>
          ) : unconfigured ? (
            <input
              className={`input ${styles.urlInput}`}
              type="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://<your-mcp-host>/mcp"
              aria-label="MCP URL"
              value={typedUrl}
              onChange={(e) => typeUrl(e.target.value)}
            />
          ) : (
            <code className={styles.url}>{q.mcpUrl ?? endpoint.url}</code>
          )}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={q.mcpUrl === null}
            onClick={() => q.mcpUrl && copy('url', q.mcpUrl)}
          >
            {copied === 'url' ? 'Copied' : 'Copy'}
          </button>
        </div>
        {unconfigured && (
          <p className={styles.warn}>
            The hub doesn&apos;t know its public address yet. Paste the MCP URL agents reach it at;
            this browser remembers it. To fix it for everyone, set <code>EXTERNAL_MCP_URL</code> in
            the hub&apos;s <code>.env</code> and recreate <code>cortex-api</code>.
          </p>
        )}

        {steps.map((step, i) => (
          <div key={step.id} className={styles.step}>
            <div className={styles.stepHeader}>
              <span className={styles.stepTitle}>{i + 1}. {step.title}</span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                aria-label={`${copied === step.id ? 'Copied' : 'Copy'} ${step.title} command`}
                // The extension installer needs no URL; the other two would still hold the placeholder host.
                disabled={step.id !== 'extension' && q.mcpUrl === null}
                onClick={() => copy(step.id, step.cmd)}
              >
                {copied === step.id ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className={styles.hint}>{step.hint}</p>
            <pre className={styles.cmd}>{step.cmd}</pre>
          </div>
        ))}
      </div>
    </div>
  )
}
