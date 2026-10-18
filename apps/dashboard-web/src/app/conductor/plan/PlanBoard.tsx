'use client'

// Plan board: one lane per machine with a chip per task. When a poll moves a task to another lane or
// slot, its chip glides there (FLIP); a chip whose state just changed flashes once.
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type { CSSProperties } from 'react'
import type { ConductorWorker } from '@/lib/api'
import { boardLanes, type BoardChip } from '@/lib/conductor-plan/board'
import type { PhaseSelection } from '@/lib/conductor-plan/layout'
import type { PlanTask } from '@/lib/conductor-plan/model'
import { STATUS_COLOR, STATUS_LABEL } from '@/lib/conductor-plan/status'
import styles from './plan.module.css'

const MOVE = 'transform .55s cubic-bezier(.2,.7,.2,1), border-color .35s, background-color .35s, opacity .35s'

type Point = { x: number; y: number }

/** Chip positions relative to the board (offsets ignore the transforms a running glide applies). */
function measure(root: HTMLElement): Map<string, Point> {
  const out = new Map<string, Point>()
  for (const el of root.querySelectorAll<HTMLElement>('[data-chip]')) {
    out.set(el.dataset.chip as string, { x: el.offsetLeft, y: el.offsetTop })
  }
  return out
}

interface PlanBoardProps {
  tasks: PlanTask[]
  workers: ConductorWorker[]
  /** Worker numbers from the Workers panel, for the chip on a running task. */
  agentNo: ReadonlyMap<string, number>
  phase?: PhaseSelection
  selectedId?: string
  flashing: ReadonlySet<string>
  onSelect: (id: string) => void
}

export function PlanBoard({ tasks, workers, agentNo, phase, selectedId, flashing, onSelect }: PlanBoardProps) {
  const lanes = useMemo(() => boardLanes(tasks, workers, { phase, now: new Date() }), [tasks, workers, phase])
  const root = useRef<HTMLDivElement>(null)
  const last = useRef(new Map<string, Point>())

  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const next = measure(el)
    const before = last.current
    last.current = next
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    for (const chip of el.querySelectorAll<HTMLElement>('[data-chip]')) {
      const from = before.get(chip.dataset.chip as string)
      const to = next.get(chip.dataset.chip as string)
      if (!from || !to) continue
      const dx = from.x - to.x
      const dy = from.y - to.y
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue
      chip.style.transition = 'none'
      chip.style.transform = `translate(${dx}px, ${dy}px)`
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          chip.style.transition = MOVE
          chip.style.transform = ''
        })
      })
    }
  }, [lanes])

  // A resize reflows the lanes: take the new positions as the baseline instead of gliding from the old ones.
  useEffect(() => {
    const el = root.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      last.current = measure(el)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div className={styles.boardScroll}>
      <div className={styles.lanes} ref={root}>
        {lanes.length === 0 && <p className={styles.empty}>No tasks in this view</p>}
        {lanes.map((lane) => (
          <div
            key={lane.id}
            className={`${styles.lane} ${lane.queue ? styles.laneQueue : ''}`}
            data-busy={lane.busy ? '1' : '0'}
            data-online={lane.online ? '1' : '0'}
          >
            <div className={styles.laneHead}>
              <div className={styles.laneName}>
                {!lane.queue && <i aria-hidden="true" />}
                <span>{lane.label}</span>
              </div>
              <div className={styles.laneMeta}>{lane.sub}</div>
              {lane.engines.length > 0 && (
                <div className={styles.engines}>
                  {lane.engines.map((e) => <span key={e}>{e}</span>)}
                </div>
              )}
            </div>
            <div className={styles.track}>
              {lane.chips.map((chip) => (
                <Chip
                  key={chip.id}
                  chip={chip}
                  agentNo={chip.agent === null ? undefined : agentNo.get(chip.agent)}
                  selected={chip.id === selectedId}
                  flash={flashing.has(chip.id)}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Chip({ chip, agentNo, selected, flash, onSelect }: {
  chip: BoardChip
  agentNo: number | undefined
  selected: boolean
  flash: boolean
  onSelect: (id: string) => void
}) {
  const classes = [
    styles.chip,
    chip.kind === 'gate' ? styles.chipGate : '',
    chip.ghost ? styles.chipGhost : '',
    chip.attention ? styles.chipAttention : '',
    flash ? styles.chipFlash : '',
    selected ? styles.chipSelected : '',
  ].filter(Boolean).join(' ')
  return (
    <button
      type="button"
      data-chip={chip.id}
      data-state={chip.state}
      className={classes}
      style={{ '--st': STATUS_COLOR[chip.state] } as CSSProperties}
      title={chip.pr ? `${chip.title}\n${chip.pr}` : chip.title}
      aria-pressed={selected}
      onClick={() => onSelect(chip.id)}
    >
      <span className={styles.chipRow}>
        <span className={styles.chipKey}>
          {chip.key}
          {chip.attempt !== null && <span className={styles.chipAtt}>#{chip.attempt}</span>}
        </span>
        <span className={styles.chipSt}>{STATUS_LABEL[chip.state]}</span>
        {agentNo !== undefined && (
          <span className={styles.agentNo} title={`agent ${agentNo} · ${chip.agent}`}>{agentNo}</span>
        )}
      </span>
      <span className={styles.chipTitle}>{chip.title}</span>
      {(chip.route || chip.pr) && (
        <span className={styles.chipFoot}>
          <span className={styles.chipRoute}>{chip.route}</span>
          {chip.pr && <span className={styles.chipPr}>{chip.pr}</span>}
        </span>
      )}
      {chip.note && <span className={styles.chipNote}>{chip.note}</span>}
      {chip.ghost && <span className={styles.chipTag}>{chip.ghost === 'input' ? 'input' : 'unlocks'}</span>}
    </button>
  )
}
