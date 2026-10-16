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

export type AddResult = { ok: true; conn: WorkerConn; replaced: boolean } | { ok: false; code: 4009; reason: string }

const conns = new Map<string, WorkerConn>()
const byAgent = new Map<string, string>()
const seen = new Map<string, number>()
let startedAt = Date.now()

const PLACEHOLDER = /^anon-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The agent id a socket holds until it names itself (a legacy script connects with its key only). */
export function placeholderAgentId(): string {
  return `anon-${randomUUID()}`
}

export function isPlaceholderAgentId(agentId: string): boolean {
  return PLACEHOLDER.test(agentId)
}

/** A placeholder is never an assignee, so it is not remembered once its socket is gone. */
function markSeen(agentId: string, now: number): void {
  if (!isPlaceholderAgentId(agentId)) seen.set(agentId, now)
}

/**
 * Makes way for `connectionId` (absent: a new socket) to take `agentId` from
 * `hostname`: refused while another host holds it; a socket of the same host
 * is closed 4000 and dropped.
 */
function claim(
  agentId: string, hostname: string, connectionId?: string,
): { ok: true; replaced: boolean } | { ok: false; code: 4009; reason: string } {
  const existing = getByAgent(agentId)
  if (!existing || existing.connectionId === connectionId) return { ok: true, replaced: false }
  if (existing.hostname !== hostname) {
    return { ok: false, code: CLOSE_CODES.agentIdInUse, reason: `agent id in use on ${existing.hostname}` }
  }
  conns.delete(existing.connectionId)
  byAgent.delete(existing.agentId)
  existing.ws.close(CLOSE_CODES.replaced, 'replaced')
  return { ok: true, replaced: true }
}

export function addConnection(init: ConnInit, now: number = Date.now()): AddResult {
  const claimed = claim(init.agentId, init.hostname)
  if (!claimed.ok) return claimed
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
  markSeen(conn.agentId, now)
  return { ok: true, conn, replaced: claimed.replaced }
}

/**
 * Gives a connection the identity its register message names, by
 * `addConnection`'s rules: refused (4009) while another host holds `agentId`;
 * an older socket of the same host is closed 4000 and replaced. The old id
 * no longer resolves. Undefined when the connection is unknown.
 */
export function rekeyConnection(
  connectionId: string, agentId: string, hostname: string, now: number = Date.now(),
): AddResult | undefined {
  const conn = conns.get(connectionId)
  if (!conn) return undefined
  const claimed = claim(agentId, hostname, connectionId)
  if (!claimed.ok) return claimed
  if (byAgent.get(conn.agentId) === connectionId) byAgent.delete(conn.agentId)
  if (isPlaceholderAgentId(conn.agentId)) seen.delete(conn.agentId)
  else markSeen(conn.agentId, now)
  conn.agentId = agentId
  conn.hostname = hostname
  byAgent.set(agentId, connectionId)
  markSeen(agentId, now)
  return { ok: true, conn, replaced: claimed.replaced }
}

/** Returns false when the connection is unknown (e.g. a late close of a replaced socket). */
export function removeConnection(connectionId: string, now: number = Date.now()): boolean {
  const conn = conns.get(connectionId)
  if (!conn) return false
  conns.delete(connectionId)
  if (byAgent.get(conn.agentId) === connectionId) byAgent.delete(conn.agentId)
  markSeen(conn.agentId, now)
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
  markSeen(conn.agentId, now)
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

/** Sends on an open socket; a throwing send is logged and reported as false. */
function sendOn(conn: WorkerConn, data: string): boolean {
  try {
    conn.ws.send(data)
    return true
  } catch (err) {
    console.warn(`[conductor] send to ${conn.agentId} failed: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

/** False when the agent is not connected, its socket is not open, or the send throws. */
export function sendTo(agentId: string, msg: object): boolean {
  const conn = getByAgent(agentId)
  if (!conn || conn.ws.readyState !== OPEN) return false
  return sendOn(conn, JSON.stringify(msg))
}

/** A socket whose send throws is skipped; the others still receive the message. */
export function broadcastToOwner(owner: string, msg: object, excludeAgentId?: string): void {
  const data = JSON.stringify(msg)
  for (const conn of conns.values()) {
    if (conn.apiKeyOwner === owner && conn.agentId !== excludeAgentId && conn.ws.readyState === OPEN) {
      sendOn(conn, data)
    }
  }
}

export function resetRegistry(start: number = Date.now()): void {
  conns.clear()
  byAgent.clear()
  seen.clear()
  startedAt = start
}
