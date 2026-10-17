// Plan status colours and labels. Pure module — type-only import, so home can use it as is.
import type { PlanState } from './model'

export const STATUS_COLOR: Record<PlanState, string> = {
  done: '#34d399',
  review: '#a78bfa',
  needs_user: '#fbbf24',
  gate_lead: '#fbbf24',
  escalated: '#f87171',
  running: '#60a5fa',
  waiting: '#22d3ee',
  ready: '#e5e7eb',
  blocked: '#6b7280',
  stopped: '#4b5563',
}

export const STATUS_LABEL: Record<PlanState, string> = {
  done: 'done',
  review: 'in review',
  needs_user: 'needs you',
  gate_lead: 'awaiting lead',
  escalated: 'escalated',
  running: 'running',
  waiting: 'waiting',
  ready: 'ready',
  blocked: 'blocked',
  stopped: 'stopped',
}
