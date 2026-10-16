'use client'

// Plan diagram: depth columns by machine lane, gates, critical path and same-file edges.
// Task 9's PlanView mounts it and gives its parent a size; the diagram fills that parent.
import { useEffect, useMemo, useRef } from 'react'
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Node,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { ConductorWorker } from '@/lib/api'
import { criticalPath, fileConflicts } from '@/lib/conductor-plan/analysis'
import { toFlow } from '@/lib/conductor-plan/flow'
import { computeDepths, layoutPlan, type PhaseSelection } from '@/lib/conductor-plan/layout'
import type { PlanState, PlanTask } from '@/lib/conductor-plan/model'
import { STATUS_COLOR, STATUS_LABEL } from '@/lib/conductor-plan/status'
import { nodeTypes } from './PlanNodes'
import styles from './plan.module.css'

export interface PlanDiagramProps {
  tasks: PlanTask[]
  workers: ConductorWorker[]
  phase?: PhaseSelection
  selectedId?: string
  onSelect: (id: string) => void
  /** Changing it re-fits the view; polling updates never do. */
  viewKey: string
}

const FIT = { padding: 0.02 }
const STATES = Object.keys(STATUS_LABEL) as PlanState[]

function Inner({ tasks, workers, phase, selectedId, onSelect, viewKey }: PlanDiagramProps) {
  const { fitView } = useReactFlow()
  const fitRef = useRef(fitView)
  fitRef.current = fitView

  const { nodes, edges } = useMemo(() => {
    const mode = phase ? 'detail' : 'compact'
    const byId = new Map(tasks.map((t) => [t.id, t]))
    const now = new Date()
    const layout = layoutPlan(tasks, workers, { mode, phase })
    const { depth, cyclic } = computeDepths(tasks)
    return toFlow(layout, byId, criticalPath(tasks, cyclic), fileConflicts(tasks, depth), mode, now, selectedId)
  }, [tasks, workers, phase, selectedId])

  // Fit once the nodes exist and are measured, and only when the view itself changes.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      void fitRef.current(FIT)
    })
    return () => cancelAnimationFrame(frame)
  }, [viewKey])

  const handleNodeClick = (_event: React.MouseEvent, node: Node) => {
    if (node.type === 'task' || node.type === 'gate') onSelect(node.id)
  }

  return (
    <div className={styles.wrap}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={handleNodeClick}
        fitView
        fitViewOptions={FIT}
        nodesDraggable={false}
        nodesConnectable={false}
        minZoom={0.1}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} size={1} color="rgba(255,255,255,.04)" />
        <Controls showInteractive={false} />
      </ReactFlow>
      <div className={styles.legend}>
        <span><i className={`${styles.ln}`} />dependency</span>
        <span><i className={`${styles.ln} ${styles.dash}`} />same file</span>
        <span><i className={`${styles.ln} ${styles.crit}`} />critical path</span>
        {STATES.map((s) => (
          <span key={s}><i className={styles.sq} style={{ background: STATUS_COLOR[s] }} />{STATUS_LABEL[s]}</span>
        ))}
      </div>
    </div>
  )
}

export function PlanDiagram(props: PlanDiagramProps) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  )
}
