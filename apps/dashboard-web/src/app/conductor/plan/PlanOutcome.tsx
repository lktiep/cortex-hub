'use client'

// Outcome card for the plan drawer: what a task produced (pull request, branch, commit, tests, summary)
// and, for a gate, the outcomes of the dependencies its approval covers. Logic lives in outcome.ts.
import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { MarkdownRenderer } from '@/components/ui/MarkdownRenderer'
import { isLongSummary, prLabel, TESTS_LABEL } from '@/lib/conductor-plan/outcome'
import type { ApproveDep, TaskOutcome, TestsState } from '@/lib/conductor-plan/outcome'
import { STATUS_COLOR, STATUS_LABEL } from '@/lib/conductor-plan/status'
import styles from './plan.module.css'

interface Props {
  /** The task's own outcome (taskOutcome); work only. */
  outcome: TaskOutcome | null
  /** A gate's dependencies, from approveContext; null for work. */
  deps: ApproveDep[] | null
  /** A gate's dependencies outside this plan. */
  external: number
  /** The task can be approved here, so a gate's list is what the approval covers. */
  approving: boolean
  onSelect: (id: string) => void
}

export function PlanOutcome({ outcome, deps, external, approving, onSelect }: Props) {
  if (deps) {
    return (
      <section className={styles.outcome} aria-label={approving ? 'You are approving' : 'Dependencies'}>
        <div className={styles.outcomeHead}>
          <span className={styles.outcomeTitle}>{approving ? 'You are approving' : 'Dependencies'}</span>
        </div>
        {deps.length === 0 && <p className={styles.outcomeMuted}>No dependencies in this plan</p>}
        {deps.length > 0 && (
          <ul className={styles.depList}>
            {deps.map((d) => <DepRow key={d.id} dep={d} onSelect={onSelect} />)}
          </ul>
        )}
        {external > 0 && (
          <p className={styles.outcomeMuted}>
            and {external} task{external === 1 ? '' : 's'} outside this plan
          </p>
        )}
      </section>
    )
  }

  if (!outcome) return null
  return (
    <section className={styles.outcome} aria-label="Outcome">
      <div className={styles.outcomeHead}>
        <span className={styles.outcomeTitle}>Outcome</span>
        <TestsBadge tests={outcome.tests} />
      </div>
      <Artifacts outcome={outcome} />
      {outcome.error && <p className={styles.outcomeError}>{outcome.error}</p>}
      {outcome.summary && <Summary text={outcome.summary} />}
      {outcome.testOutput && (
        <details className={styles.outcomeFold}>
          <summary>Test output</summary>
          <pre>{outcome.testOutput}</pre>
        </details>
      )}
    </section>
  )
}

function TestsBadge({ tests }: { tests: TestsState }) {
  return <span className={styles.testsBadge} data-tests={tests}>{TESTS_LABEL[tests]}</span>
}

function External({ href, className, title, children }: {
  href: string
  className?: string
  title?: string
  children: ReactNode
}) {
  return (
    <a href={href} className={className} title={title} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  )
}

/** PR, its checks, the compare view, branch and commit — links when the repository is known. */
function Artifacts({ outcome }: { outcome: TaskOutcome }) {
  const { pr, compareUrl, branch, commit } = outcome
  if (!pr && !compareUrl && !branch && !commit) return null
  return (
    <div className={styles.artifacts}>
      {pr && <External href={pr.url} className={styles.artifactPr}>{prLabel(outcome)}</External>}
      {pr?.checksUrl && <External href={pr.checksUrl} className={styles.artifactLink}>Checks</External>}
      {compareUrl && <External href={compareUrl} className={styles.artifactLink}>Compare</External>}
      {branch && (
        <span className={styles.artifactRef} title="Branch">
          <span className={styles.artifactKind}>branch</span>
          {branch.url ? <External href={branch.url}>{branch.name}</External> : <code>{branch.name}</code>}
        </span>
      )}
      {commit && (
        <span className={styles.artifactRef} title={commit.sha}>
          <span className={styles.artifactKind}>commit</span>
          {commit.url ? <External href={commit.url}>{commit.short}</External> : <code>{commit.short}</code>}
        </span>
      )}
    </div>
  )
}

/** The summary as markdown, folded after a few lines. */
function Summary({ text }: { text: string }) {
  const long = isLongSummary(text)
  const [open, setOpen] = useState(false)
  const folded = long && !open
  return (
    <div>
      <div className={`${styles.outcomeSummary} ${folded ? styles.outcomeFolded : ''}`}>
        <MarkdownRenderer content={text} className={styles.outcomeMd} />
      </div>
      {long && (
        <button type="button" className={styles.outcomeMore} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  )
}

function DepRow({ dep, onSelect }: { dep: ApproveDep; onSelect: (id: string) => void }) {
  const o = dep.outcome
  return (
    <li className={styles.depRow} style={{ '--st': STATUS_COLOR[dep.state] } as CSSProperties}>
      <button type="button" className={styles.depMain} onClick={() => onSelect(dep.id)} title={`Open ${dep.key}`}>
        <span className={styles.depKey}>{dep.key}</span>
        <span className={styles.depTitle}>{dep.title}</span>
        <span className={styles.depState}>{STATUS_LABEL[dep.state]}</span>
      </button>
      <span className={styles.depArtifacts}>
        {o?.pr && <External href={o.pr.url} className={styles.artifactPr}>{prLabel(o)}</External>}
        {o && <TestsBadge tests={o.tests} />}
        {!o && <span className={styles.outcomeMuted}>no result</span>}
      </span>
    </li>
  )
}
