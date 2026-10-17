'use client'

import type { GitAccount } from '@/lib/api'
import styles from './ReuseTokenOption.module.css'

/**
 * Offers the token the hub already holds for this git username, so a new
 * project of the same account does not need the PAT typed again. The hub
 * copies it server-side; the browser never sees it.
 */
export default function ReuseTokenOption({
  account,
  checked,
  onChange,
}: {
  account: GitAccount
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  const usedBy = account.projects.map((p) => p.name)
  const shown = usedBy.slice(0, 3).join(', ') + (usedBy.length > 3 ? ` and ${usedBy.length - 3} more` : '')
  return (
    <label className={styles.option}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        Reuse the token saved for <strong>{account.username}</strong> on {account.host}
        <span className={styles.usedBy}>Used by {shown}. Type a token above to use a different one.</span>
      </span>
    </label>
  )
}
