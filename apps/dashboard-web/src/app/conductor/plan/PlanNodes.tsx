'use client'

// Node renderers for the plan diagram: task, gate, and the lane and column backgrounds.
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import {
  STATUS_COLOR,
  STATUS_LABEL,
  type ColNodeData,
  type GateNodeData,
  type LaneNodeData,
  type TaskNodeData,
} from '@/lib/conductor-plan/flow'
import type { PlanState } from '@/lib/conductor-plan/model'
import styles from './plan.module.css'

const STATE_CLASS: Partial<Record<PlanState, string>> = {
  blocked: styles.stBlocked,
  ready: styles.stReady,
  running: styles.stRunning,
}

const ROUTE_CHIP_COLOR = '#94a3b8'

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

function basename(file: string): string {
  return file.split('/').filter(Boolean).pop() ?? file
}

export function TaskNode({ data }: NodeProps<Node<TaskNodeData>>) {
  const { task, mode, critical, ghost, note, route, noFiles, selected } = data
  const color = STATUS_COLOR[task.state]
  const detail = mode === 'detail'
  const className = cx(
    styles.tn,
    detail ? styles.tnDetail : styles.tnCompact,
    ghost && styles.tnGhost,
    critical && styles.tnCritical,
    selected && styles.tnSelected,
    STATE_CLASS[task.state],
  )
  return (
    <div
      className={className}
      style={{ ['--st' as string]: color }}
      title={compactTitle(task.key, task.title, STATUS_LABEL[task.state], note)}
    >
      <Handle type="target" position={Position.Left} className={styles.h} />
      {detail ? (
        <>
          <div className={styles.tnTop}>
            <span className={styles.tnId}>{task.key}</span>
            <span className={styles.tnTitle}>{task.title}</span>
          </div>
          <div className={styles.tnState}>
            <span className={styles.pill} style={{ color, borderColor: color }}>{STATUS_LABEL[task.state]}</span>
            {note && <span className={styles.tnNote}>{note}</span>}
          </div>
          <div className={styles.tnMeta}>
            <span className={styles.tnAgent}>{task.agent ?? 'unassigned'}</span>
            {route && <span>{route}</span>}
            {task.estimate > 0 && <span>{`≈ ${task.estimate} d`}</span>}
          </div>
          {task.files.length > 0 && (
            <div className={styles.tnLock}>{task.files.map(basename).join(', ')}</div>
          )}
          {noFiles && <div className={styles.tnNoFiles}>no files</div>}
          {ghost && <div className={styles.tnGhostTag}>{ghost}</div>}
        </>
      ) : (
        <>
          <span className={styles.tnId}>{task.key}</span>
          <span className={styles.tnTitle}>{task.title}</span>
          {route && <span className={styles.routeChip} style={{ background: ROUTE_CHIP_COLOR }}>{route}</span>}
        </>
      )}
      <Handle type="source" position={Position.Right} className={styles.h} />
    </div>
  )
}

function compactTitle(key: string, title: string, status: string, note: string | null): string {
  return [`${key} ${title}`, note ? `${status} · ${note}` : status].join('\n')
}

export function GateNode({ data }: NodeProps<Node<GateNodeData>>) {
  const { task, mode, critical, selected, blocks } = data
  const detail = mode === 'detail'
  const done = task.state === 'done'
  const who = task.approver === 'lead' ? 'lead' : 'user'
  return (
    <div
      className={cx(
        styles.gate,
        detail ? styles.gateDetail : styles.gateCompact,
        done && styles.gateDone,
        critical && styles.gateCritical,
        selected && styles.gateSelected,
      )}
      title={compactTitle(task.key, task.title, STATUS_LABEL[task.state], null)}
    >
      <Handle type="target" position={Position.Left} className={styles.h} />
      <span className={styles.gateId}>{task.key}</span>
      <span className={styles.gateTitle}>{task.title}</span>
      <span className={styles.gateText}>
        {detail ? `${who} · ${STATUS_LABEL[task.state]} · blocks ${blocks}` : who}
      </span>
      <Handle type="source" position={Position.Right} className={styles.h} />
    </div>
  )
}

export function LaneNode({ data }: NodeProps<Node<LaneNodeData>>) {
  const { lane, width, height, index } = data
  return (
    <div
      className={cx(styles.lane, index % 2 === 1 && styles.laneAlt, !lane.online && styles.laneOffline)}
      style={{ width, height }}
    >
      <div className={styles.laneLabel}>
        <b>{lane.label}</b>
        <small>{lane.sub}</small>
      </div>
    </div>
  )
}

export function ColNode({ data }: NodeProps<Node<ColNodeData>>) {
  return <div className={styles.colhead}>{data.label}</div>
}

export const nodeTypes = { task: TaskNode, gate: GateNode, lane: LaneNode, col: ColNode }
