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

async function opened(params: Record<string, string>): Promise<Client> {
  const client = open(params)
  await new Promise<void>((resolve, reject) => {
    client.ws.once('open', () => resolve())
    client.ws.once('error', reject)
  })
  return client
}

/** A protocol-2 worker: it says so in the query and is not ready before `worker.register`. */
function connect(agentId: string, hostname = `host-${agentId}`, apiKey = 'sk_test'): Promise<Client> {
  return opened({ apiKey, agentId, hostname, protocol: '2' })
}

/** A protocol-1 client with its identity in the query (the extension): ready on connect. */
function connectLegacy(agentId: string, hostname = `host-${agentId}`, extra: Record<string, string> = {}): Promise<Client> {
  return opened({ apiKey: 'sk_test', agentId, hostname, ...extra })
}

/** A script that connects with its key only and names itself in `agent.register`. */
function connectBare(): Promise<Client> {
  return opened({ apiKey: 'sk_test' })
}

function agentRegister(client: Client, agentId: string | undefined, hostname: string): void {
  send(client, { type: 'agent.register', agentId, hostname, os: 'linux', ide: 'cli', capabilities: [] })
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

/** Waits for a condition on the hub side (e.g. that it has processed a close). */
async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 5))
  }
}

function connectedIds(): string[] {
  return getAllConnectedAgents().map((a) => a.agentId).sort()
}

function row(id: string): TaskRow {
  return testDb.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(id) as TaskRow
}

function logs(taskId: string, action: string): { agent_id: string | null; message: string | null }[] {
  return testDb.prepare('SELECT agent_id, message FROM conductor_task_logs WHERE task_id = ? AND action = ? ORDER BY id')
    .all(taskId, action) as { agent_id: string | null; message: string | null }[]
}

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

  it('a protocol=2 connect gets nothing before worker.register, not even its own task', async () => {
    const lease = isoSeconds(Date.now() + 3600_000)
    insertTask(testDb, { id: 'mine', status: 'assigned', assigned_to_agent: 'w1', attempt: 1, lease_expires_at: lease, project_id: 'p1' })
    insertTask(testDb, { id: 't1', status: 'pending', project_id: 'p1' })
    const before = row('mine')
    const w = await connect('w1')
    await next(w, 'welcome')
    await sync(w)
    expect(types(w)).toEqual([])
    expect(row('t1').status).toBe('pending')
    expect(row('mine')).toEqual(before)
    register(w, { activeTaskId: 'mine' })
    expect(await next(w, 'task.resumed')).toMatchObject({ taskId: 'mine' })
  })

  it('a repeated worker.register on a registered connection only updates it', async () => {
    insertTask(testDb, { id: 'gone', status: 'pending', project_id: 'p1', escalated_at: isoSeconds() })
    const w = await connect('w1')
    await next(w, 'welcome')
    register(w)
    await next(w, 'registered')
    await sync(w)
    insertTask(testDb, { id: 'held', status: 'assigned', assigned_to_agent: 'w1', attempt: 1, project_id: 'p1', pinned_agent: 'elsewhere' })
    const held = row('held')
    register(w, { activeTaskId: 'gone', version: '2.0.1' })
    expect(await next(w, 'registered')).toMatchObject({ projectId: 'p1' })
    await sync(w)
    expect(types(w)).toEqual([])
    expect(row('held')).toEqual(held)
    expect(getAllConnectedAgents()[0]?.version).toBe('2.0.1')
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

  it('scoped key whose project is the repo project is accepted', async () => {
    addKey('sk_p1', 'p1')
    const w = await connect('w1', 'host-w1', 'sk_p1')
    register(w)
    expect(await next(w, 'registered')).toMatchObject({ projectId: 'p1' })
  })

  it('falls back to the key project when the repo maps to no project', async () => {
    testDb.prepare("INSERT INTO projects (id, org_id, name, slug, git_repo_url) VALUES ('p2', 'org-1', 'q', 'q', NULL)").run()
    addKey('sk_p2', 'p2')
    const w = await connect('w1', 'host-w1', 'sk_p2')
    register(w, { repo: 'https://github.com/o/unknown.git' })
    expect(await next(w, 'registered')).toMatchObject({ projectId: 'p2' })
  })

  it('a true reconnect resumes once, without a failure or an offline broadcast', async () => {
    const observer = await connect('obs')
    insertTask(testDb, { id: 't1', status: 'pending', project_id: 'p1' })
    const first = await connect('w1', 'host-a')
    register(first)
    await next(first, 'task.assigned')
    send(first, { type: 'task.accept', taskId: 't1' })
    await sync(first)
    const before = row('t1')
    expect(before.status).toBe('accepted')

    const second = await connect('w1', 'host-a')
    expect(await first.closed).toMatchObject({ code: 4000 })
    register(second, { activeTaskId: 't1' })
    expect(await next(second, 'task.resumed')).toMatchObject({ taskId: 't1' })
    await sync(second)
    expect(types(second).filter((t) => t.startsWith('task.'))).toEqual([])
    expect(row('t1')).toEqual(before)
    expect(logs('t1', 'returned')).toEqual([])
    await until(() => wss.clients.size === 2)
    await sync(observer)
    expect(types(observer)).not.toContain('agent.offline')
  })
})

describe('connections', () => {
  it('second connection from the same host replaces the first, without an offline broadcast', async () => {
    const observer = await connect('obs')
    const first = await connect('w1', 'host-a')
    const second = await connect('w1', 'host-a')
    expect(await first.closed).toMatchObject({ code: 4000 })
    // the hub has handled the first socket's close once it has left the server's client set
    await until(() => wss.clients.size === 2)
    await sync(observer)
    expect(types(observer).filter((t) => t === 'agent.offline')).toEqual([])
    expect(connectedIds()).toEqual(['obs', 'w1'])

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

  it('ignores a decline or a quota report for a stale attempt', async () => {
    insertTask(testDb, { id: 't1', status: 'pending', project_id: 'p1' })
    const w = await connect('w1')
    register(w)
    await next(w, 'task.assigned')
    send(w, { type: 'task.accept', taskId: 't1' })
    await sync(w)
    const before = row('t1')
    send(w, { type: 'task.decline', taskId: 't1', reason: 'not mine', attempt: 0 })
    send(w, {
      type: 'task.quota_exhausted', taskId: 't1', executor: 'claude', model: 'opus', raw: 'limit',
      handoff: { branch: 'cx/t1', commit: null, note: '' }, attempt: 0,
    })
    await sync(w)
    expect(row('t1')).toEqual(before)
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM conductor_quota').get()).toEqual({ n: 0 })
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
    const legacy = await connectLegacy('legacy', 'h-legacy')
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
    const legacy = await connectLegacy('legacy')
    send(legacy, { type: 'agent.register', capabilities: [] })
    await sync(legacy)
    expect(row('t1')).toEqual(before)
    expect(types(legacy)).toEqual(['welcome'])
  })

  it('extension-style connect with query identity gets an executor-null task without registering', async () => {
    insertTask(testDb, { id: 't-agy', status: 'pending', executor: 'agy', created_at: '2026-01-01T00:00:00Z' })
    insertTask(testDb, { id: 't-any', title: 'Any job', description: 'plain', status: 'pending', created_at: '2026-01-02T00:00:00Z' })
    const ext = await connectLegacy('ext', 'h-ext', {
      ide: 'vscode', platform: 'darwin', capabilities: encodeURIComponent(JSON.stringify([])),
    })
    expect(await next(ext, 'task.assigned')).toMatchObject({ taskId: 't-any', title: 'Any job', description: 'plain' })
    await sync(ext)
    expect(types(ext)).not.toContain('task.assigned')
    expect(row('t-agy').status).toBe('pending')
    expect(row('t-any')).toMatchObject({ status: 'assigned', assigned_to_agent: 'ext' })
  })

  it('agent.register ignores identity fields when the query named the agent', async () => {
    const legacy = await connectLegacy('legacy', 'h-legacy')
    agentRegister(legacy, 'other', 'h-other')
    await sync(legacy)
    expect(getAllConnectedAgents()).toEqual([expect.objectContaining({ agentId: 'legacy', hostname: 'h-legacy', ide: 'cli' })])
  })

  it('task.create with assignTo pins the task and delivers it through the dispatcher', async () => {
    const target = await connect('w2')
    register(target)
    await next(target, 'registered')
    await sync(target)
    const creator = await connectLegacy('creator', 'h-c')
    send(creator, { type: 'task.create', title: 'Do X', description: 'the thing', assignTo: 'w2' })
    const created = await next(creator, 'task.created')
    const msg = await next(target, 'task.assigned')
    expect(msg).toMatchObject({ taskId: created.taskId, title: 'Do X', task: expect.objectContaining({ id: created.taskId }) })
    expect(row(created.taskId as string)).toMatchObject({
      status: 'assigned', assigned_to_agent: 'w2', pinned_agent: 'w2', created_by_agent: 'creator',
    })
    await sync(creator)
    await sync(target)
    expect(types(creator)).not.toContain('task.assigned')
    expect(types(target)).not.toContain('task.assigned')
  })
})

describe('query-less legacy scripts', () => {
  it('are not listed or announced until agent.register names them', async () => {
    const observer = await connect('obs')
    const bare = await connectBare()
    const welcome = await next(bare, 'welcome')
    expect(String(welcome.agentId)).toMatch(/^anon-/)
    await sync(observer)
    expect(types(observer)).not.toContain('agent.online')
    expect(connectedIds()).toEqual(['obs'])
    agentRegister(bare, 'script', 'h-script')
    expect(await next(observer, 'agent.online')).toMatchObject({ agentId: 'script', hostname: 'h-script' })
    expect(connectedIds()).toEqual(['obs', 'script'])
  })

  it('two scripts on different hosts both stay connected and each gets its own task', async () => {
    insertTask(testDb, { id: 'ta', status: 'pending', pinned_agent: 'sa' })
    insertTask(testDb, { id: 'tb', status: 'pending', pinned_agent: 'sb' })
    const a = await connectBare()
    const b = await connectBare()
    await sync(a)
    await sync(b)
    expect(row('ta').status).toBe('pending')
    agentRegister(a, 'sa', 'h-a')
    agentRegister(b, 'sb', 'h-b')
    expect(await next(a, 'task.assigned')).toMatchObject({ taskId: 'ta' })
    expect(await next(b, 'task.assigned')).toMatchObject({ taskId: 'tb' })
    await sync(a)
    await sync(b)
    expect(a.ws.readyState).toBe(WebSocket.OPEN)
    expect(b.ws.readyState).toBe(WebSocket.OPEN)
    expect(row('ta')).toMatchObject({ status: 'assigned', assigned_to_agent: 'sa' })
    expect(row('tb')).toMatchObject({ status: 'assigned', assigned_to_agent: 'sb' })
    expect(connectedIds()).toEqual(['sa', 'sb'])
  })

  it('the same agentId from another host is refused with 4009', async () => {
    const a = await connectBare()
    agentRegister(a, 'sa', 'h-a')
    await sync(a)
    const b = await connectBare()
    agentRegister(b, 'sa', 'h-b')
    expect(await b.closed).toEqual({ code: 4009, reason: 'agent id in use on h-a' })
    await sync(a)
    expect(a.ws.readyState).toBe(WebSocket.OPEN)
    expect(connectedIds()).toEqual(['sa'])
  })

  it('the same agentId from the same host replaces the older socket', async () => {
    const a = await connectBare()
    agentRegister(a, 'sa', 'h-a')
    await sync(a)
    const b = await connectBare()
    agentRegister(b, 'sa', 'h-a')
    expect(await a.closed).toMatchObject({ code: 4000 })
    await sync(b)
    expect(connectedIds()).toEqual(['sa'])
  })

  it('agent.register without an agentId is closed with 4001', async () => {
    const bare = await connectBare()
    agentRegister(bare, undefined, 'h-x')
    expect(await bare.closed).toEqual({ code: 4001, reason: 'agentId required' })
    await until(() => wss.clients.size === 0)
    expect(connectedIds()).toEqual([])
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
    expect(logs('t1', 'pinned')).toEqual([{ agent_id: 'w1', message: 'pinned to w1' }])
  })

  it('pins a pending task and dispatches it to that agent once', async () => {
    const w = await connect('w1')
    register(w)
    await next(w, 'registered')
    await sync(w)
    insertTask(testDb, { id: 't1', title: 'Fresh', status: 'pending', project_id: 'p1' })
    expect(pushTaskToAgent('w1', 't1', 'Fresh', '')).toBe(true)
    expect(await next(w, 'task.assigned')).toMatchObject({ taskId: 't1', task: expect.objectContaining({ id: 't1' }) })
    await sync(w)
    expect(types(w)).not.toContain('task.assigned')
    expect(row('t1')).toMatchObject({ status: 'assigned', assigned_to_agent: 'w1', pinned_agent: 'w1' })
    expect(logs('t1', 'pinned')).toEqual([{ agent_id: 'w1', message: 'pinned to w1' }])
  })

  it('only pins a blocked task: the dispatcher sends it once it unblocks', async () => {
    const w = await connect('w1')
    register(w)
    await next(w, 'registered')
    await sync(w)
    insertTask(testDb, { id: 't1', title: 'Later', status: 'blocked', project_id: 'p1' })
    expect(pushTaskToAgent('w1', 't1', 'Later', '')).toBe(false)
    await sync(w)
    expect(types(w)).not.toContain('task.assigned')
    expect(row('t1')).toMatchObject({ status: 'blocked', pinned_agent: 'w1', assigned_to_agent: null })
    expect(logs('t1', 'pinned')).toEqual([{ agent_id: 'w1', message: 'pinned to w1' }])
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
