// Test fixtures for the conductor plan modules — plain data builders, no DOM or React.
import type { ConductorSession, ConductorTask, ConductorWorker } from '../api'

/** A hub task row with sensible defaults; override what the test cares about. */
export function row(p: Partial<ConductorTask> & { id: string }): ConductorTask {
  return {
    title: p.id,
    description: '',
    project_id: null,
    parent_task_id: null,
    created_by_agent: null,
    assigned_to_agent: null,
    assigned_session_id: null,
    status: 'pending',
    priority: 0,
    required_capabilities: '[]',
    depends_on: '[]',
    notify_on_complete: '[]',
    notified_agents: '[]',
    context: '{}',
    result: null,
    completed_by: null,
    created_at: '2026-10-16T00:00:00.000Z',
    assigned_at: null,
    accepted_at: null,
    completed_at: null,
    ...p,
  }
}

export function worker(p: Partial<ConductorWorker> = {}): ConductorWorker {
  return {
    agentId: 'worker-1',
    apiKeyOwner: 'owner',
    capabilities: [],
    status: 'idle',
    connectedAt: '2026-10-16T00:00:00.000Z',
    lastPing: '2026-10-16T00:00:00.000Z',
    connectionId: 'conn-1',
    os: null,
    version: null,
    projectId: null,
    engines: [],
    defaultExecutor: null,
    currentTaskId: null,
    quota: [],
    ...p,
  }
}

export function session(p: Partial<ConductorSession> = {}): ConductorSession {
  return {
    sessionId: 'session-1',
    agentId: 'agent-1',
    hostname: null,
    ide: null,
    branch: null,
    projectId: null,
    apiKeyName: null,
    lastActivity: '2026-10-16T00:00:00.000Z',
    ...p,
  }
}

/**
 * Deterministic plan of `n` leaf tasks under root 'root' (returned first) in 3 groups (g0..g2).
 * Roughly every tenth leaf is a gate; leaves chain to their predecessor in the group, every
 * seventh depends across groups, and files are shared in a rotation of five.
 */
export function generatePlan(n: number): ConductorTask[] {
  const rows: ConductorTask[] = [row({ id: 'root', kind: 'group', status: 'in_progress' })]
  for (let g = 0; g < 3; g++) rows.push(row({ id: `g${g}`, kind: 'group', parent_task_id: 'root' }))
  const lastInGroup: Array<string | null> = [null, null, null]
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const g = i % 3
    const id = `t${i}`
    const deps: string[] = []
    const prev = lastInGroup[g]
    if (prev) deps.push(prev)
    if (i % 7 === 6 && i >= 3) deps.push(ids[i - 3] as string)
    const gate = i % 10 === 9
    rows.push(row({
      id,
      parent_task_id: `g${g}`,
      kind: gate ? 'gate' : 'work',
      approver: gate ? (i % 20 === 19 ? 'user' : 'lead') : null,
      depends_on: JSON.stringify(deps),
      files: JSON.stringify([`src/f${i % 5}.ts`]),
      context: JSON.stringify({ estimate: 1 + (i % 3) }),
      priority: i % 4,
    }))
    lastInGroup[g] = id
    ids.push(id)
  }
  return rows
}
