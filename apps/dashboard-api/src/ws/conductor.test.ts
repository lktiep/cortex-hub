import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { createHash } from 'crypto'
import type Database from 'better-sqlite3'
import { WebSocket, type WebSocketServer } from 'ws'
import type { AssignedTask, EngineInfo, WorkerRegisterMsg } from '@cortex/shared-types'
import { createTestDb, insertTask } from '../conductor/testing.js'

let testDb: Database.Database
vi.mock('../db/client.js', () => ({ get db() { return testDb } }))

import { resetRegistry } from '../conductor/registry.js'
import { isoSeconds, type TaskRow } from '../conductor/rows.js'
import { appVersion } from '../version.js'
import { getAllConnectedAgents, pushTaskToAgent, setupConductorWebSocket } from './conductor.js'

const REPO = 'https://github.com/o/r.git'
const CLAUDE: EngineInfo = { executor: 'claude', models: ['*'], defaultModel: 'opus' }

type Msg = { type: string; [k: string]: unknown }
interface Client {
  ws: WebSocket
  /** Every message received and not yet taken by `next`, in arrival order. */
  inbox: Msg[]
  closed: Promise<{ code: number; reason: string }>
}

let server: Server
let wss: WebSocketServer
let port: number
let clients: Client[] = []
let consoleError: MockInstance<typeof console.error>

function addKey(key: string, projectId: string | null): void {
  testDb.prepare("INSERT INTO api_keys (id, name, key_hash, scope, project_id) VALUES (?, 'owner', ?, 'all', ?)")
    .run(`k-${key}`, createHash('sha256').update(key).digest('hex'), projectId)
}

/** Opens a socket; the inbox records from the first message on. */
function open(params: Record<string, string>): Client {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/conductor?${new URLSearchParams(params).toString()}`)
  const client: Client = {
    ws,
    inbox: [],
    closed: new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))),
  }
  ws.on('message', (data) => client.inbox.push(JSON.parse(String(data)) as Msg))
  ws.on('error', () => {})
  clients.push(client)
  return client
}

async function connect(agentId: string, hostname = `host-${agentId}`, apiKey = 'sk_test'): Promise<Client> {
  const client = open({ apiKey, agentId, hostname })
  await new Promise<void>((resolve, reject) => {
    client.ws.once('open', () => resolve())
    client.ws.once('error', reject)
  })
  return client
}

function send(client: Client, msg: object): void {
  client.ws.send(JSON.stringify(msg))
}

function register(client: Client, extra: Partial<WorkerRegisterMsg> = {}): void {
  send(client, {
    type: 'worker.register', protocol: 2, version: '2.0.0', hostname: 'ignored', os: 'darwin', repo: REPO,
    capabilities: [], engines: [CLAUDE], defaultExecutor: 'claude', ...extra,
  } satisfies WorkerRegisterMsg)
}

/** Takes the first message of `type` from the inbox, waiting for it if needed. */
async function next(client: Client, type: string, timeoutMs = 2000): Promise<Msg> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const i = client.inbox.findIndex((m) => m.type === type)
    if (i >= 0) return client.inbox.splice(i, 1)[0] as Msg
    if (Date.now() > deadline) {
      throw new Error(`no ${type} within ${timeoutMs} ms; inbox: ${client.inbox.map((m) => m.type).join(', ')}`)
    }
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** Barrier: the hub answers `request.data` after handling every earlier message from this socket. */
async function sync(client: Client): Promise<void> {
  send(client, { type: 'request.data' })
  await next(client, 'data.response')
}

function types(client: Client): string[] {
  return client.inbox.map((m) => m.type)
}

function row(id: string): TaskRow {
  return testDb.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(id) as TaskRow
}

function logs(taskId: string, action: string): { agent_id: string | null; message: string | null }[] {
  return testDb.prepare('SELECT agent_id, message FROM conductor_task_logs WHERE task_id = ? AND action = ? ORDER BY id')
    .all(taskId, action) as { agent_id: string | null; message: string | null }[]
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

beforeEach(async () => {
  // the hub logs every connection; a handler that throws is logged as an error and fails the test
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  consoleError = vi.spyOn(console, 'error')
  testDb = createTestDb()
  resetRegistry()
  testDb.prepare("INSERT INTO organizations (id, name, slug) VALUES ('org-1', 'Org', 'org')").run()
  testDb.prepare("INSERT INTO projects (id, org_id, name, slug, git_repo_url) VALUES ('p1', 'org-1', 'r', 'r', ?)").run(REPO)
  addKey('sk_test', null)
  server = createServer()
  wss = setupConductorWebSocket(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  port = (server.address() as AddressInfo).port
})

afterEach(async () => {
  for (const c of clients) c.ws.terminate()
  clients = []
  for (const ws of wss.clients) ws.terminate()
  await new Promise<void>((resolve) => wss.close(() => resolve()))
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  try {
    expect(consoleError).not.toHaveBeenCalled()
  } finally {
    vi.restoreAllMocks()
  }
})

describe('worker.register', () => {
  it('registers and replies registered', async () => {
    const w = await connect('w1')
    expect(await next(w, 'welcome')).toMatchObject({ agentId: 'w1' })
    register(w)
    const reg = await next(w, 'registered')
    expect(reg).toEqual({ type: 'registered', connectionId: expect.any(String), projectId: 'p1', hubVersion: appVersion })
  })

  it('dispatches a pending task after registration', async () => {
    insertTask(testDb, { id: 't1', title: 'Fix login', description: 'the form', status: 'pending', project_id: 'p1' })
    const w = await connect('w1')
    register(w)
    await next(w, 'registered')
    const msg = await next(w, 'task.assigned')
    expect(msg).toMatchObject({ taskId: 't1', title: 'Fix login', description: 'the form' })
    const task = msg.task as AssignedTask
    expect(task).toMatchObject({ id: 't1', title: 'Fix login', attempt: 1, baseBranch: 'main' })
    expect(task.branch).not.toBe('')
    expect(row('t1')).toMatchObject({ status: 'assigned', assigned_to_agent: 'w1', attempt: 1 })
  })

  it('does not dispatch or re-push on connect, only after register', async () => {
    insertTask(testDb, { id: 't1', status: 'pending', project_id: 'p1' })
    const w = await connect('w1')
    await next(w, 'welcome')
    await sync(w)
    expect(types(w)).toEqual([])
    expect(row('t1').status).toBe('pending')
  })

  it('stale activeTaskId is revoked and the row is left alone', async () => {
    // escalated: the dispatcher leaves it untouched, so any change would come from the register
    insertTask(testDb, { id: 't1', status: 'pending', project_id: 'p1', escalated_at: isoSeconds() })
    const before = row('t1')
    const w = await connect('w1')
    register(w, { activeTaskId: 't1' })
    await next(w, 'registered')
    expect(await next(w, 'task.revoked')).toEqual({ type: 'task.revoked', taskId: 't1', reason: 'reclaimed' })
    await sync(w)
    expect(row('t1')).toEqual(before)
  })

  it('revokes an activeTaskId held by another worker without touching it', async () => {
    insertTask(testDb, { id: 't1', status: 'in_progress', assigned_to_agent: 'w2', attempt: 1, project_id: 'p1' })
    const before = row('t1')
    const w = await connect('w1')
    register(w, { activeTaskId: 't1' })
    expect(await next(w, 'task.revoked')).toEqual({ type: 'task.revoked', taskId: 't1', reason: 'reclaimed' })
    await sync(w)
    expect(row('t1')).toEqual(before)
  })

  it('resumes its own active task', async () => {
    const lease = isoSeconds(Date.now() + 3600_000)
    insertTask(testDb, {
      id: 't1', status: 'in_progress', assigned_to_agent: 'w1', attempt: 2, lease_expires_at: lease,
      project_id: 'p1', branch: 'cx/t1-fix',
    })
    const before = row('t1')
    const w = await connect('w1')
    register(w, { activeTaskId: 't1' })
    const msg = await next(w, 'task.resumed')
    expect(msg).toMatchObject({ taskId: 't1', title: 't1' })
    expect(msg.task).toMatchObject({ id: 't1', attempt: 2, leaseExpiresAt: lease, branch: 'cx/t1-fix', baseBranch: 'main' })
    await sync(w)
    expect(types(w)).not.toContain('task.revoked')
    expect(types(w)).not.toContain('task.assigned')
    expect(row('t1')).toEqual(before)
  })

  it('reconciles the other active tasks it no longer has', async () => {
    // pinned elsewhere so that the dispatch after the register does not hand them straight back
    const held = { assigned_to_agent: 'w1', attempt: 1, project_id: 'p1', pinned_agent: 'elsewhere' }
    insertTask(testDb, { id: 'kept', status: 'in_progress', assigned_to_agent: 'w1', attempt: 1, project_id: 'p1' })
    insertTask(testDb, { id: 'unstarted', status: 'assigned', ...held })
    insertTask(testDb, { id: 'started', status: 'in_progress', ...held })
    const w = await connect('w1')
    register(w, { activeTaskId: 'kept' })
    await next(w, 'task.resumed')
    await sync(w)
    expect(row('kept')).toMatchObject({ status: 'in_progress', assigned_to_agent: 'w1' })
    expect(row('unstarted')).toMatchObject({ status: 'pending', assigned_to_agent: null, fail_count: 0 })
    expect(logs('unstarted', 'returned')).toEqual([{ agent_id: 'w1', message: 'worker restarted' }])
    expect(row('started')).toMatchObject({ status: 'pending', assigned_to_agent: null, fail_count: 1 })
    expect(logs('started', 'returned')).toEqual([{ agent_id: 'w1', message: 'failed: worker restarted without the task' }])
    expect(types(w)).not.toContain('task.revoked')
  })

  it('scoped key refuses another project', async () => {
    addKey('sk_scoped', 'p-other')
    const w = await connect('w1', 'host-w1', 'sk_scoped')
    register(w)
    expect(await w.closed).toEqual({ code: 4003, reason: 'key is scoped to another project' })
    expect(getAllConnectedAgents()).toEqual([])
  })
})

describe('connections', () => {
  it('second connection from the same host replaces the first, without an offline broadcast', async () => {
    const observer = await connect('obs')
    const first = await connect('w1', 'host-a')
    const second = await connect('w1', 'host-a')
    expect(await first.closed).toMatchObject({ code: 4000 })
    await sleep(50)
    await sync(observer)
    expect(types(observer).filter((t) => t === 'agent.offline')).toEqual([])
    expect(getAllConnectedAgents().map((a) => a.agentId).sort()).toEqual(['obs', 'w1'])

    second.ws.close()
    const offline = await next(observer, 'agent.offline')
    expect(offline).toMatchObject({ agentId: 'w1' })
  })

  it('from another host is refused', async () => {
    const first = await connect('w1', 'host-a')
    const second = await connect('w1', 'host-b')
    expect(await second.closed).toEqual({ code: 4009, reason: 'agent id in use on host-a' })
    await sync(first)
    expect(first.ws.readyState).toBe(WebSocket.OPEN)
  })

  it('answers invalid JSON with an error', async () => {
    const w = await connect('w1')
    w.ws.send('not json')
    expect(await next(w, 'error')).toMatchObject({ message: 'Invalid JSON' })
  })
})

describe('task messages', () => {
  it('ignores messages for tasks it does not own', async () => {
    insertTask(testDb, { id: 't1', status: 'in_progress', assigned_to_agent: 'w2', attempt: 1, project_id: 'p1' })
    const before = row('t1')
    const w = await connect('w1')
    register(w)
    await next(w, 'registered')
    send(w, { type: 'task.complete', taskId: 't1', status: 'completed', result: { summary: 'done' } })
    await sync(w)
    expect(row('t1')).toEqual(before)
    expect(logs('t1', 'ignored')).toHaveLength(1)
  })

  it('ignores an outcome for a stale attempt and completes the current one', async () => {
    insertTask(testDb, { id: 't1', status: 'pending', project_id: 'p1' })
    const w = await connect('w1')
    register(w)
    expect(((await next(w, 'task.assigned')).task as AssignedTask).attempt).toBe(1)
    send(w, { type: 'task.accept', taskId: 't1' })
    send(w, { type: 'task.complete', taskId: 't1', status: 'completed', result: { summary: 'old' }, attempt: 0 })
    await sync(w)
    expect(row('t1').status).toBe('accepted')
    send(w, { type: 'task.complete', taskId: 't1', status: 'completed', result: { summary: 'done' }, attempt: 1 })
    await sync(w)
    expect(row('t1')).toMatchObject({ status: 'completed', completed_by: 'w1' })
    expect(JSON.parse(row('t1').result ?? '')).toEqual({ summary: 'done' })
  })

  it('status.update sets the status and idle dispatches', async () => {
    const w = await connect('w1')
    register(w)
    await next(w, 'registered')
    send(w, { type: 'status.update', state: 'busy' })
    await sync(w)
    expect(getAllConnectedAgents()[0]?.status).toBe('busy')
    insertTask(testDb, { id: 't1', status: 'pending', project_id: 'p1' })
    send(w, { type: 'status.update', status: 'idle' }) // the extension's field name
    expect(await next(w, 'task.assigned')).toMatchObject({ taskId: 't1' })
  })

  it('reports a connected worker with its current task and live quota', async () => {
    const future = isoSeconds(Date.now() + 3600_000)
    testDb.prepare("INSERT INTO conductor_quota (host, executor, model, exhausted_until, reason) VALUES ('host-w1', 'codex', '*', ?, 'limit')")
      .run(future)
    testDb.prepare("INSERT INTO conductor_quota (host, executor, model, exhausted_until) VALUES ('host-w1', 'agy', '*', '2020-01-01T00:00:00Z')")
      .run()
    insertTask(testDb, { id: 't1', status: 'pending', project_id: 'p1' })
    const w = await connect('w1')
    register(w)
    await next(w, 'task.assigned')
    expect(getAllConnectedAgents()).toEqual([expect.objectContaining({
      agentId: 'w1', apiKeyOwner: 'owner', hostname: 'host-w1', connectionId: expect.any(String), os: 'darwin',
      version: '2.0.0', projectId: 'p1', engines: [CLAUDE], defaultExecutor: 'claude', currentTaskId: 't1',
      quota: [{ executor: 'codex', model: '*', exhaustedUntil: future, reason: 'limit' }],
    })])
  })
})

describe('legacy workers', () => {
  it('legacy worker gets only executor-null tasks with flat fields', async () => {
    insertTask(testDb, { id: 't-agy', title: 'Agy job', status: 'pending', executor: 'agy', created_at: '2026-01-01T00:00:00Z' })
    insertTask(testDb, { id: 't-any', title: 'Any job', description: 'plain', status: 'pending', created_at: '2026-01-02T00:00:00Z' })
    const legacy = await connect('legacy', 'h-legacy')
    send(legacy, { type: 'agent.register', capabilities: [], hostname: 'h-legacy', ide: 'cli', os: 'linux' })
    const msg = await next(legacy, 'task.assigned')
    expect(msg).toMatchObject({ taskId: 't-any', title: 'Any job', description: 'plain' })
    await sync(legacy)
    expect(types(legacy)).not.toContain('task.assigned')
    expect(row('t-agy').status).toBe('pending')

    // a legacy script completes with a plain string result and no status
    send(legacy, { type: 'task.accept', taskId: 't-any' })
    send(legacy, { type: 'task.progress', taskId: 't-any', message: 'working' })
    send(legacy, { type: 'task.complete', taskId: 't-any', result: 'all done' })
    await sync(legacy)
    expect(row('t-any').status).toBe('completed')
    expect(JSON.parse(row('t-any').result ?? '')).toEqual({ summary: 'all done' })
  })

  it('agent.register does not reconcile active tasks', async () => {
    insertTask(testDb, { id: 't1', status: 'in_progress', assigned_to_agent: 'legacy', attempt: 1 })
    const before = row('t1')
    const legacy = await connect('legacy')
    send(legacy, { type: 'agent.register', capabilities: [] })
    await sync(legacy)
    expect(row('t1')).toEqual(before)
    expect(types(legacy)).toEqual(['welcome'])
  })
})

describe('pushTaskToAgent', () => {
  it('pins and dispatches instead of sending twice', async () => {
    const w = await connect('w1')
    register(w)
    await next(w, 'registered')
    await sync(w)
    insertTask(testDb, { id: 't1', title: 'Legacy', status: 'assigned', assigned_to_agent: 'w1', project_id: 'p1' })
    expect(pushTaskToAgent('w1', 't1', 'Legacy', '')).toBe(true)
    expect(await next(w, 'task.assigned')).toMatchObject({ taskId: 't1', task: expect.objectContaining({ id: 't1' }) })
    await sync(w)
    expect(types(w)).not.toContain('task.assigned')
    const r = row('t1')
    expect(r).toMatchObject({ status: 'assigned', assigned_to_agent: 'w1', pinned_agent: 'w1' })
    expect(r.lease_expires_at).not.toBeNull()
  })

  it('sends the flat legacy message for a task outside the dispatcher', async () => {
    const w = await connect('w1')
    register(w)
    await next(w, 'registered')
    insertTask(testDb, { id: 't1', title: 'Synthesize', status: 'synthesis', assigned_to_agent: 'w1' })
    expect(pushTaskToAgent('w1', 't1', 'Synthesize', 'merge results')).toBe(true)
    const msg = await next(w, 'task.assigned')
    expect(msg).toMatchObject({ taskId: 't1', title: 'Synthesize', description: 'merge results' })
    expect(msg.task).toBeUndefined()
    expect(row('t1').status).toBe('synthesis')
  })
})
