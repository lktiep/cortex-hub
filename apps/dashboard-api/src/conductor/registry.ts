import { randomUUID } from 'crypto'
import { CLOSE_CODES, type EngineInfo, type Executor } from '@cortex/shared-types'
import { isoSeconds } from './rows.js'

const OPEN = 1

export interface SocketLike { readyState: number; send(data: string): void; close(code?: number, reason?: string): void }

export interface WorkerConn {
  connectionId: string; ws: SocketLike; agentId: string; apiKeyOwner: string; apiKeyProjectId: string | null
  hostname: string; ide: string | null; platform: string | null; os: string | null; version: string | null
  protocol: 1 | 2; capabilities: string[]; engines: EngineInfo[]; defaultExecutor: Executor | null
  projectId: string | null; status: 'idle' | 'busy'; connectedAt: string; lastPing: string; idleSince: number
  /** false until the socket has registered (worker.register / agent.register) */
  ready: boolean
}

export type ConnInit = Pick<WorkerConn, 'ws' | 'agentId' | 'apiKeyOwner' | 'apiKeyProjectId' | 'hostname' | 'ide' | 'platform' | 'capabilities'>

const conns = new Map<string, WorkerConn>()
const byAgent = new Map<string, string>()
const seen = new Map<string, number>()
let startedAt = Date.now()

export function addConnection(
  init: ConnInit,
  now: number = Date.now(),
): { ok: true; conn: WorkerConn; replaced: boolean } | { ok: false; code: 4009; reason: string } {
  const existingId = byAgent.get(init.agentId)
  const existing = existingId ? conns.get(existingId) : undefined
  if (existing && existing.hostname !== init.hostname) {
    return { ok: false, code: CLOSE_CODES.agentIdInUse, reason: `agent id in use on ${existing.hostname}` }
  }
  if (existing) {
    conns.delete(existing.connectionId)
    byAgent.delete(existing.agentId)
    existing.ws.close(CLOSE_CODES.replaced, 'replaced')
  }
  const stamp = isoSeconds(now)
  const conn: WorkerConn = {
    ...init,
    connectionId: randomUUID(),
    os: null,
    version: null,
    protocol: 1,
    engines: [],
    defaultExecutor: null,
    projectId: null,
    status: 'idle',
    connectedAt: stamp,
    lastPing: stamp,
    idleSince: now,
    ready: false,
  }
  conns.set(conn.connectionId, conn)
  byAgent.set(conn.agentId, conn.connectionId)
  seen.set(conn.agentId, now)
  return { ok: true, conn, replaced: !!existing }
}

/** Returns false when the connection is unknown (e.g. a late close of a replaced socket). */
export function removeConnection(connectionId: string, now: number = Date.now()): boolean {
  const conn = conns.get(connectionId)
  if (!conn) return false
  conns.delete(connectionId)
  if (byAgent.get(conn.agentId) === connectionId) byAgent.delete(conn.agentId)
  seen.set(conn.agentId, now)
  return true
}

export function updateConnection(
  connectionId: string,
  patch: Partial<Omit<WorkerConn, 'connectionId' | 'ws' | 'agentId'>>,
): WorkerConn | undefined {
  const conn = conns.get(connectionId)
  if (!conn) return undefined
  Object.assign(conn, patch)
  return conn
}

export function getConnection(connectionId: string): WorkerConn | undefined {
  return conns.get(connectionId)
}

export function getByAgent(agentId: string): WorkerConn | undefined {
  const id = byAgent.get(agentId)
  return id ? conns.get(id) : undefined
}

export function listConnections(): WorkerConn[] {
  return [...conns.values()]
}

export function touch(connectionId: string, now: number = Date.now()): void {
  const conn = conns.get(connectionId)
  if (!conn) return
  conn.lastPing = isoSeconds(now)
  seen.set(conn.agentId, now)
}

/** Connected now → `now`; otherwise when it was last seen; never seen → registry start. */
export function lastSeen(agentId: string, now: number = Date.now()): number {
  if (byAgent.has(agentId)) return now
  return seen.get(agentId) ?? startedAt
}

export function setStatus(agentId: string, status: 'idle' | 'busy', now: number = Date.now()): void {
  const conn = getByAgent(agentId)
  if (!conn) return
  if (status === 'idle' && conn.status !== 'idle') conn.idleSince = now
  conn.status = status
}

export function sendTo(agentId: string, msg: object): boolean {
  const conn = getByAgent(agentId)
  if (!conn || conn.ws.readyState !== OPEN) return false
  conn.ws.send(JSON.stringify(msg))
  return true
}

export function broadcastToOwner(owner: string, msg: object, excludeAgentId?: string): void {
  const data = JSON.stringify(msg)
  for (const conn of conns.values()) {
    if (conn.apiKeyOwner === owner && conn.agentId !== excludeAgentId && conn.ws.readyState === OPEN) {
      conn.ws.send(data)
    }
  }
}

export function resetRegistry(start: number = Date.now()): void {
  conns.clear()
  byAgent.clear()
  seen.clear()
  startedAt = start
}
