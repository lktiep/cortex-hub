'use client'

// Plan graph: the dependency DAG at natural size in a scroll box. The critical path is red, tasks that
// share files are joined by a dashed line, and every edge into a running task carries flowing dashes.
import { useId, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import type { ConductorWorker } from '@/lib/api'
import type { CriticalPath, FileConflict } from '@/lib/conductor-plan/analysis'
import { GRAPH, layoutGraph, type EdgeKind, type GraphNode } from '@/lib/conductor-plan/graph'
import type { PhaseSelection } from '@/lib/conductor-plan/layout'
import type { PlanState, PlanTask } from '@/lib/conductor-plan/model'
import { STATUS_COLOR, STATUS_LABEL } from '@/lib/conductor-plan/status'
import styles from './plan.module.css'

const { W, H } = GRAPH
const ZOOM_MIN = 0.4
const ZOOM_MAX = 1.5
const EDGE_KINDS: EdgeKind[] = ['default', 'done', 'gate', 'critical']
const LEGEND_STATES: PlanState[] = ['done', 'review', 'running', 'waiting', 'ready', 'needs_user', 'escalated', 'blocked']
/** Characters that fit the 176px text column of a node, per line. */
const TITLE_CHARS = 27
const ROUTE_CHARS = 27
/** Mono route text and the PR tag's smaller mono text, in px per character. */
const ROUTE_CHAR_W = 6.3
const TAG_CHAR_W = 5.8
/** The agent-number badge's mono text, in px per character. */
const AGENT_CHAR_W = 6.3

const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100))

/** SVG text does not ellipsise, so cut it to what fits. */
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text
}

interface PlanGraphProps {
  tasks: PlanTask[]
  workers: ConductorWorker[]
  /** Worker numbers from the Workers panel, for the badge on a running task. */
  agentNo: ReadonlyMap<string, number>
  phase?: PhaseSelection
  critical: CriticalPath
  conflicts: FileConflict[]
  selectedId?: string
  flashing: ReadonlySet<string>
  onSelect: (id: string) => void
}

export function PlanGraph({ tasks, workers, agentNo, phase, critical, conflicts, selectedId, flashing, onSelect }: PlanGraphProps) {
  const layout = useMemo(
    () => layoutGraph(tasks, workers, { phase, critical, conflicts, now: new Date() }),
    [tasks, workers, phase, critical, conflicts],
  )
  const [zoom, setZoom] = useState(1)
  const scroller = useRef<HTMLDivElement>(null)
  const markerId = `plan-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const edgeClass: Record<EdgeKind, string | undefined> = {
    default: styles.edge,
    done: `${styles.edge} ${styles.edgeDone}`,
    gate: `${styles.edge} ${styles.edgeGate}`,
    critical: `${styles.edge} ${styles.edgeCritical}`,
  }
  const markerClass: Record<EdgeKind, string | undefined> = {
    default: styles.arrow,
    done: `${styles.arrow} ${styles.arrowDone}`,
    gate: `${styles.arrow} ${styles.arrowGate}`,
    critical: `${styles.arrow} ${styles.arrowCritical}`,
  }
  // The critical path is drawn last so it stays on top where edges cross.
  const edges = [...layout.edges].sort((a, b) => Number(a.kind === 'critical') - Number(b.kind === 'critical'))

  const fit = () => {
    const el = scroller.current
    if (!el) return
    setZoom(clampZoom(Math.min((el.clientWidth - 36) / layout.width, (el.clientHeight - 32) / layout.height)))
  }

  return (
    <div className={styles.graph}>
      <div className={styles.graphTools}>
        {layout.cyclic.size > 0 && (
          <span className={styles.graphNote}>{layout.cyclic.size} tasks depend on each other in a loop</span>
        )}
        <div className={styles.zoom} role="group" aria-label="Zoom">
          <button type="button" onClick={() => setZoom((z) => clampZoom(z - 0.1))} disabled={zoom <= ZOOM_MIN} aria-label="Zoom out">−</button>
          <button type="button" onClick={() => setZoom(1)} title="Actual size">{Math.round(zoom * 100)}%</button>
          <button type="button" onClick={() => setZoom((z) => clampZoom(z + 0.1))} disabled={zoom >= ZOOM_MAX} aria-label="Zoom in">+</button>
          <button type="button" onClick={fit}>Fit</button>
        </div>
      </div>
      <div className={styles.graphScroll} ref={scroller}>
        {layout.nodes.length === 0 && <p className={styles.empty}>No tasks in this view</p>}
        <svg
          className={styles.graphSvg}
          width={layout.width * zoom}
          height={layout.height * zoom}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="group"
          aria-label="Plan dependency graph"
        >
          <defs>
            {EDGE_KINDS.map((k) => (
              <marker
                key={k}
                id={`${markerId}-${k}`}
                viewBox="0 0 10 10"
                refX={9}
                refY={5}
                markerWidth={7}
                markerHeight={7}
                orient="auto-start-reverse"
              >
                <path d="M0 0 10 5 0 10z" className={markerClass[k]} />
              </marker>
            ))}
          </defs>
          {layout.columns.map((c) => (
            <text key={c.col} className={styles.colLabel} x={c.x} y={22}>{c.label}</text>
          ))}
          {layout.shares.map((s) => (
            <g key={s.id}>
              <path className={styles.share} d={s.d} />
              <text className={styles.shareLabel} x={s.labelX} y={s.labelY}>{clip(s.file, 18)}</text>
            </g>
          ))}
          {edges.map((e) => (
            <path key={e.id} className={edgeClass[e.kind]} d={e.d} markerEnd={`url(#${markerId}-${e.kind})`} />
          ))}
          {edges.filter((e) => e.animated).map((e) => (
            <path key={`${e.id}:flow`} className={styles.flow} d={e.d} />
          ))}
          {layout.nodes.map((n) => (
            <Node
              key={n.id}
              node={n}
              agentNo={n.agent === null ? undefined : agentNo.get(n.agent)}
              selected={n.id === selectedId}
              flash={flashing.has(n.id)}
              onSelect={onSelect}
            />
          ))}
        </svg>
      </div>
      <div className={styles.graphLegend}>
        <span><svg width="26" height="8" aria-hidden="true"><path d="M0 4h26" className={styles.legendCritical} /></svg>critical path</span>
        <span><svg width="26" height="8" aria-hidden="true"><path d="M0 4h26" className={styles.legendFlow} /></svg>into a running task</span>
        <span><svg width="26" height="8" aria-hidden="true"><path d="M0 4h26" className={styles.legendShare} /></svg>shared files</span>
        <span><svg width="18" height="14" aria-hidden="true"><rect x="1" y="1" width="16" height="12" rx="3" className={styles.legendGate} /></svg>gate</span>
        {LEGEND_STATES.map((s) => (
          <span key={s}><i style={{ background: STATUS_COLOR[s] }} />{STATUS_LABEL[s]}</span>
        ))}
      </div>
    </div>
  )
}

function Node({ node, agentNo, selected, flash, onSelect }: {
  node: GraphNode
  agentNo: number | undefined
  selected: boolean
  flash: boolean
  onSelect: (id: string) => void
}) {
  const label = STATUS_LABEL[node.state].toUpperCase()
  // The agent badge takes the top-right corner and pushes the status label left.
  const badgeW = agentNo === undefined ? 0 : Math.max(16, Math.ceil(String(agentNo).length * AGENT_CHAR_W + 9))
  const stRight = W - 10 - (badgeW ? badgeW + 6 : 0)
  // Mono key at ~7.75px a character, beside a status label at ~6.3px a character.
  const keyChars = Math.max(4, Math.floor((176 - label.length * 6.3 - 10 - (badgeW ? badgeW + 6 : 0)) / 7.75))
  const attempt = node.attempt !== null ? ` #${node.attempt}` : ''
  const classes = [
    styles.node,
    node.kind === 'gate' ? styles.nodeGate : '',
    node.critical ? styles.nodeCritical : '',
    node.ghost ? styles.nodeGhost : '',
    node.attention ? styles.nodeAttention : '',
    flash ? styles.nodeFlash : '',
    selected ? styles.nodeSelected : '',
  ].filter(Boolean).join(' ')
  const onKeyDown = (e: KeyboardEvent<SVGGElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    onSelect(node.id)
  }
  const runBy = agentNo === undefined ? null : `agent ${agentNo} · ${node.agent}`
  const tip = [`${node.key}${attempt} — ${node.title}`, STATUS_LABEL[node.state], runBy, node.route, node.note, node.pr]
    .filter(Boolean)
    .join('\n')
  // The PR tag sits at the right end of the route line, which is cut short to make room for it.
  const tagW = node.pr ? Math.ceil(node.pr.length * TAG_CHAR_W + 10) : 0
  const routeChars = node.pr ? Math.max(4, Math.floor((W - 10 - tagW - 6 - 14) / ROUTE_CHAR_W)) : ROUTE_CHARS
  return (
    <g
      className={classes}
      data-state={node.state}
      style={{ '--st': STATUS_COLOR[node.state] } as CSSProperties}
      transform={`translate(${node.x} ${node.y})`}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${node.key}: ${node.title}, ${STATUS_LABEL[node.state]}${runBy ? `, ${runBy}` : ''}${node.pr ? `, ${node.pr}` : ''}`}
      onClick={() => onSelect(node.id)}
      onKeyDown={onKeyDown}
    >
      <title>{tip}</title>
      {node.state === 'running' && <rect className={styles.halo} width={W} height={H} rx={7} />}
      <rect className={styles.box} width={W} height={H} rx={7} />
      {node.kind !== 'gate' && <rect className={styles.stripe} width={4} height={H} rx={2} />}
      <text className={styles.nodeKey} x={14} y={21}>
        {clip(node.key, keyChars)}
        {attempt && <tspan className={styles.nodeAtt}>{attempt}</tspan>}
      </text>
      <text className={styles.nodeSt} x={stRight} y={21}>{label}</text>
      {agentNo !== undefined && (
        <g className={styles.nodeAgent}>
          <rect x={W - 10 - badgeW} y={9} width={badgeW} height={16} rx={8} />
          <text x={W - 10 - badgeW / 2} y={21}>{agentNo}</text>
        </g>
      )}
      <text className={styles.nodeTitle} x={14} y={39}>{clip(node.title, TITLE_CHARS)}</text>
      {node.route && <text className={styles.nodeRoute} x={14} y={55}>{clip(node.route, routeChars)}</text>}
      {node.pr && (
        <g className={styles.nodePr}>
          <rect x={W - 10 - tagW} y={45} width={tagW} height={14} rx={3} />
          <text x={W - 10 - tagW / 2} y={55}>{node.pr}</text>
        </g>
      )}
    </g>
  )
}
