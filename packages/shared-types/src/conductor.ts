// Conductor wire protocol and REST view types shared by hub, worker and MCP.

export const CONDUCTOR_PROTOCOL_VERSION = 2
export type Executor = 'claude' | 'codex' | 'agy' | 'gemini'
export const EXECUTORS: readonly Executor[] = ['claude', 'codex', 'agy', 'gemini']
export const PRIORITY_LABELS = { critical: 1, high: 3, medium: 5, low: 8 } as const

export interface RouteSpec { executor: Executor | null; model: string | null; effort: string | null }
export interface EngineInfo { executor: Executor; models: string[]; defaultModel: string | null } // models may contain '*'
export interface TaskReview { at: string; by: string; verdict: 'approve' | 'reject'; feedback: string }
export interface TaskHandoff { branch: string; commit: string | null; note: string }
export interface TaskResult { summary: string; prUrl?: string; branch?: string; commit?: string; testOutput?: string; error?: string }
export interface AssignedTask {
  id: string; key: string | null; title: string; description: string
  context: Record<string, unknown>; files: string[]
  branch: string; baseBranch: string; route: RouteSpec
  attempt: number; leaseExpiresAt: string
  reviews: TaskReview[]; handoff: TaskHandoff | null; testCommand: string | null
}

// worker -> hub
export interface WorkerRegisterMsg {
  type: 'worker.register'; protocol: number; version: string; hostname: string; os: string
  repo: string; capabilities: string[]; engines: EngineInfo[]; defaultExecutor: Executor | null
  activeTaskId?: string
}
export interface TaskAcceptMsg { type: 'task.accept'; taskId: string }
export interface TaskProgressMsg { type: 'task.progress'; taskId: string; message: string; percent?: number }
export interface TaskCompleteMsg { type: 'task.complete'; taskId: string; status: 'completed' | 'review' | 'failed'; result: TaskResult }
export interface TaskQuotaExhaustedMsg {
  type: 'task.quota_exhausted'; taskId: string; executor: Executor; model: string
  modelScope?: string; resetAt?: string; raw: string; handoff: TaskHandoff
}
export interface TaskDeclineMsg { type: 'task.decline'; taskId: string; reason: string }
export interface StatusUpdateMsg { type: 'status.update'; state: 'idle' | 'busy' }
export type WorkerToHubMsg = WorkerRegisterMsg | TaskAcceptMsg | TaskProgressMsg | TaskCompleteMsg
  | TaskQuotaExhaustedMsg | TaskDeclineMsg | StatusUpdateMsg

// hub -> worker
export interface RegisteredMsg { type: 'registered'; connectionId: string; projectId: string | null; hubVersion: string }
export interface TaskAssignedMsg {
  type: 'task.assigned' | 'task.resumed'; task: AssignedTask
  taskId: string; title: string; description: string // flat copy for cortex-agent.sh/.ps1
}
export interface TaskRevokedMsg { type: 'task.revoked'; taskId: string; reason: string }
export type HubToWorkerMsg = RegisteredMsg | TaskAssignedMsg | TaskRevokedMsg
export const CLOSE_CODES = { replaced: 4000, missingKey: 4001, badKey: 4003, agentIdInUse: 4009 } as const

// REST views
export type WaitReason = 'capacity' | 'no_worker' | 'lock'
export interface WorkerView {
  agentId: string; apiKeyOwner: string; hostname?: string; ide?: string; platform?: string
  capabilities: string[]; status: 'idle' | 'busy'; connectedAt: string; lastPing: string
  connectionId: string; os: string | null; version: string | null; projectId: string | null
  engines: EngineInfo[]; defaultExecutor: Executor | null; currentTaskId: string | null
  quota: Array<{ executor: Executor; model: string; exhaustedUntil: string; reason: string | null }>
}
export interface SessionView {
  sessionId: string; agentId: string; hostname: string | null; ide: string | null
  branch: string | null; projectId: string | null; apiKeyName: string | null; lastActivity: string
}
export interface TreeTaskInput {
  key: string; title: string; description?: string; kind?: 'work' | 'gate' | 'group'
  parentKey?: string; dependsOn?: string[]; requiredCapabilities?: string[]
  priority?: number | keyof typeof PRIORITY_LABELS
  executor?: Executor; model?: string; effort?: string; fallback?: RouteSpec[]
  files?: string[]; branch?: string; pinnedAgent?: string; reviewRequired?: boolean
  approver?: 'user' | 'lead'; context?: Record<string, unknown>
}
export interface TreeCreateRequest { parentId?: string; projectId?: string; tasks: TreeTaskInput[] }
export interface TreeCreateResponse { ids: Record<string, string>; rootIds: string[]; ready: number }
export interface RoutePatch {
  executor?: Executor | null; model?: string | null; effort?: string | null; fallback?: RouteSpec[] | null
  pinnedAgent?: string | null; priority?: number | keyof typeof PRIORITY_LABELS; files?: string[]
  dependsOn?: string[]; clearEscalation?: boolean
}
export interface ReviewRequest { verdict: 'approve' | 'reject'; feedback?: string; by?: string }
