import { CheckCircle, XCircle, ICON_INLINE } from '@/lib/icons'
import styles from './LlmTradeoff.module.css'

/** What works without a chat model, and what needs one. Kept in step with dashboard-api lib/llm-mode.ts. */
export const WITHOUT_LLM = {
  kept: [
    'Code search, code context and impact (embeddings only)',
    'Knowledge search, file notes and task risks',
    'Memory: stored as written and recalled by meaning; near-duplicates are skipped',
    'Sessions, tasks, gates and nudges',
  ],
  lost: [
    'Memory fact extraction: a stored note is not split into facts or merged with older ones',
    'Recipes captured automatically from finished tasks and sessions',
    'Knowledge self-repair: documents agents keep failing with are not rewritten',
  ],
}

export default function LlmTradeoff() {
  return (
    <div className={styles.tradeoff}>
      <div>
        <div className={styles.heading}>Without an LLM you keep</div>
        <ul className={styles.list}>
          {WITHOUT_LLM.kept.map((t) => (
            <li key={t}><span className={styles.kept}><CheckCircle {...ICON_INLINE} /></span> {t}</li>
          ))}
        </ul>
      </div>
      <div>
        <div className={styles.heading}>Only with an LLM</div>
        <ul className={styles.list}>
          {WITHOUT_LLM.lost.map((t) => (
            <li key={t}><span className={styles.lost}><XCircle {...ICON_INLINE} /></span> {t}</li>
          ))}
        </ul>
      </div>
    </div>
  )
}
