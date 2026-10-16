// End to end inside one process: the REST routes and the worker WebSocket on a
// real HTTP server, two scripted protocol-2 workers that answer like the A2
// worker (accept, one progress, then complete or report quota), and a lead
// that creates a plan, reads its notifications and reviews.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { createHash } from 'crypto'
import type Database from 'better-sqlite3'
import { getRequestListener } from '@hono/node-server'
import { Hono } from 'hono'
import { WebSocket, type WebSocketServer } from 'ws'
import type {
  AssignedTask, EngineInfo, TaskCompleteMsg, TaskHandoff, TaskQuotaExhaustedMsg, TaskResult, TreeCreateRequest,
  TreeCreateResponse, WorkerRegisterMsg,
} from '@cortex/shared-types'
import { createTestDb } from './testing.js'

let testDb: Database.Database
vi.mock('../db/client.js', () => ({ get db() { return testDb } }))
// stats.ts imports intel.ts for routes this test does not call
vi.mock('../routes/intel.js', () => ({ getGitNexusRepos: vi.fn() }))

import { conductorRouter } from '../routes/conductor.js'
import { statsRouter } from '../routes/stats.js'
import { setupConductorWebSocket } from '../ws/conductor.js'
import { resetRegistry } from './registry.js'
import { isoSeconds, type TaskRow } from './rows.js'

const REPO = 'https://github.com/o/r.git'
const WORKER_KEY = 'sk_workers'
const LEAD = 'lead-key'
const AGY: EngineInfo = { executor: 'agy', models: ['gemini-4-argon-low'], defaultModel: 'gemini-4-argon-low' }
const CLAUDE: EngineInfo = { executor: 'claude', models: ['*'], defaultModel: 'opus' }

type Msg = { type: string; [k: string]: unknown }
interface Worker {
  agentId: string
  ws: WebSocket
  /** Every message received and not yet taken by `next`, in arrival order. */
  inbox: Msg[]
}

let server: Server
let wss: WebSocketServer
let port: number
let workers: Worker[] = []
let consoleError: MockInstance<typeof console.error>
let consoleWarn: MockInstance<typeof console.warn>
/** Arrival order across workers and lead calls: `w-mac task.assigned <id>`, `lead approve <id>`. */
let events: string[] = []
/** taskId → the worker that has received it and not yet reported an outcome. */
let holders = new Map<string, string>()
/** Assignments that reached a worker while another worker still held the task. */
let doubleHeld: string[] = []

function addKey(key: string, name: string): void {
  testDb.prepare("INSERT INTO api_keys (id, name, key_hash, scope, project_id) VALUES (?, ?, ?, 'all', NULL)")
    .run(`k-${key}`, name, createHash('sha256').update(key).digest('hex'))
}

function onWorkerMessage(w: Worker, msg: Msg): void {
  w.inbox.push(msg)
  if (msg.type !== 'task.assigned' && msg.type !== 'task.revoked') return
  const taskId = String(msg.taskId)
  events.push(`${w.agentId} ${msg.type} ${taskId}`)
  if (msg.type === 'task.revoked') {
    if (holders.get(taskId) === w.agentId) holders.delete(taskId)
    return
  }
  const holder = holders.get(taskId)
  if (holder !== undefined) doubleHeld.push(`${taskId} to ${w.agentId} while ${holder} held it`)
  holders.set(taskId, w.agentId)
}

/** A protocol-2 worker: connects with `protocol=2`, then sends `worker.register` and waits for `registered`. */
async function startWorker(agentId: string, hostname: string, engines: EngineInfo[]): Promise<Worker> {
  const params = new URLSearchParams({ apiKey: WORKER_KEY, agentId, hostname, protocol: '2' })
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/conductor?${params.toString()}`)
  const w: Worker = { agentId, ws, inbox: [] }
  ws.on('message', (data) => onWorkerMessage(w, JSON.parse(String(data)) as Msg))
  ws.on('error', () => {})
  workers.push(w)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  send(w, {
    type: 'worker.register', protocol: 2, version: '2.0.0', hostname, os: 'darwin', repo: REPO,
    capabilities: [], engines, defaultExecutor: engines[0]?.executor ?? null,
  } satisfies WorkerRegisterMsg)
  await next(w, 'registered')
  return w
}

function send(w: Worker, msg: object): void {
  w.ws.send(JSON.stringify(msg))
}

/** Takes the first message of `type` from the inbox, waiting for it if needed. */
async function next(w: Worker, type: string, timeoutMs = 2000): Promise<Msg> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const i = w.inbox.findIndex((m) => m.type === type)
    if (i >= 0) return w.inbox.splice(i, 1)[0] as Msg
    if (Date.now() > deadline) {
      throw new Error(`${w.agentId}: no ${type} within ${timeoutMs} ms; inbox: ${w.inbox.map((m) => m.type).join(', ')}`)
    }
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** Barrier: the hub answers `request.data` after handling every earlier message from this socket. */
async function sync(w: Worker): Promise<void> {
  send(w, { type: 'request.data' })
  await next(w, 'data.response')
}

/** The next assignment pushed to `w`. */
async function assigned(w: Worker): Promise<AssignedTask> {
  return (await next(w, 'task.assigned')).task as AssignedTask
}

/** The next assignment pushed to any of `among`, with the worker that got it. */
async function assignedToAny(among: Worker[], timeoutMs = 2000): Promise<{ worker: Worker; task: AssignedTask }> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    for (const w of among) {
      if (w.inbox.some((m) => m.type === 'task.assigned')) return { worker: w, task: await assigned(w) }
    }
    if (Date.now() > deadline) throw new Error(`no task.assigned to ${among.map((w) => w.agentId).join(' or ')} within ${timeoutMs} ms`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** What the A2 worker sends before the engine's outcome: accept, then one progress line. */
function start(w: Worker, task: AssignedTask): void {
  send(w, { type: 'task.accept', taskId: task.id })
  send(w, { type: 'task.progress', taskId: task.id, message: `${task.route.executor} running`, percent: 50 })
}

/** Reports the engine's outcome for the attempt the worker received; it no longer holds the task. */
function report(w: Worker, msg: TaskCompleteMsg | TaskQuotaExhaustedMsg): void {
  if (holders.get(msg.taskId) === w.agentId) holders.delete(msg.taskId)
  send(w, msg)
}

function complete(w: Worker, task: AssignedTask, result: TaskResult): void {
  report(w, { type: 'task.complete', taskId: task.id, status: 'completed', result, attempt: task.attempt })
}

function assignedTypes(w: Worker): string[] {
  return w.inbox.map((m) => m.type).filter((t) => t === 'task.assigned' || t === 'task.revoked')
}

async function api(method: 'GET' | 'POST', path: string, body?: object): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-API-Key-Owner': LEAD },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function review(taskId: string, verdict: 'approve' | 'reject', feedback?: string): Promise<TaskRow> {
  events.push(`lead ${verdict} ${taskId}`)
  const res = await api('POST', `/api/conductor/${taskId}/review`, feedback === undefined ? { verdict } : { verdict, feedback })
  expect(res.status).toBe(200)
  return res.body.task as TaskRow
}

async function leadNotices(): Promise<string[]> {
  const res = await api('GET', `/api/metrics/hints/${LEAD}`)
  expect(res.status).toBe(200)
  return res.body.conductor as string[]
}

function row(id: string): TaskRow {
  return testDb.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(id) as TaskRow
}

/** The task's `accepted` and `progress` log rows, oldest first: one pair per attempt the worker started. */
function startLogs(taskId: string): string[] {
  const rows = testDb.prepare("SELECT action FROM conductor_task_logs WHERE task_id = ? AND action IN ('accepted', 'progress') ORDER BY id")
    .all(taskId) as { action: string }[]
  return rows.map((r) => r.action)
}

function logId(taskId: string, action: string, order: 'ASC' | 'DESC'): number {
  const found = testDb.prepare(`SELECT id FROM conductor_task_logs WHERE task_id = ? AND action = ? ORDER BY id ${order} LIMIT 1`)
    .get(taskId, action) as { id: number } | undefined
  if (found === undefined) throw new Error(`no ${action} log for ${taskId}`)
  return found.id
}

beforeEach(async () => {
  // the hub logs every connection; a worker message it ignores is a warning, checked at the end of the test;
  // a handler that throws is logged as an error and fails the test
  vi.spyOn(console, 'log').mockImplementation(() => {})
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  consoleError = vi.spyOn(console, 'error')
  testDb = createTestDb()
  resetRegistry()
  events = []
  holders = new Map()
  doubleHeld = []
  testDb.prepare("INSERT INTO organizations (id, name, slug) VALUES ('org-1', 'Org', 'org')").run()
  testDb.prepare("INSERT INTO projects (id, org_id, name, slug, git_repo_url) VALUES ('p1', 'org-1', 'r', 'r', ?)").run(REPO)
  addKey(WORKER_KEY, 'workers')

  const app = new Hono()
  app.route('/api/conductor', conductorRouter)
  app.route('/api/metrics', statsRouter)
  server = createServer(getRequestListener(app.fetch))
  wss = setupConductorWebSocket(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  port = (server.address() as AddressInfo).port
})

afterEach(async () => {
  for (const w of workers) w.ws.terminate()
  workers = []
  for (const ws of wss.clients) ws.terminate()
  // closing the server also clears its keepalive interval
  await new Promise<void>((resolve) => wss.close(() => resolve()))
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  try {
    expect(consoleError).not.toHaveBeenCalled()
  } finally {
    vi.restoreAllMocks()
  }
})

describe('conductor end to end', () => {
  it('three-task plan runs in order, survives quota and review', async () => {
    // 1. two workers register: only w-mac has agy
    const mac = await startWorker('w-mac', 'h-mac', [AGY, CLAUDE])
    const linux = await startWorker('w-linux', 'h-linux', [CLAUDE])

    // 2. the lead creates A → B → G
    const plan: TreeCreateRequest = {
      projectId: 'p1',
      tasks: [
        {
          key: 'A', title: 'Parser', executor: 'agy', model: 'gemini-4-argon-low',
          fallback: [{ executor: 'claude', model: 'opus', effort: null }], files: ['src/a.ts'],
        },
        { key: 'B', title: 'Parser CLI', dependsOn: ['A'] },
        { key: 'G', title: 'Ship check', kind: 'gate', approver: 'lead', dependsOn: ['B'] },
      ],
    }
    const created = await api('POST', '/api/conductor/tree', plan)
    expect(created.status).toBe(201)
    const { ids, ready } = created.body as unknown as TreeCreateResponse
    expect(ready).toBe(1)
    const [A, B, G] = [ids['A'], ids['B'], ids['G']] as [string, string, string]

    // 3. A runs on agy at w-mac, which runs out of quota; A moves to claude/opus, back on w-mac
    const first = await assigned(mac)
    expect(first).toMatchObject({
      id: A, key: 'A', attempt: 1, files: ['src/a.ts'], baseBranch: 'main', handoff: null, reviews: [],
      route: { executor: 'agy', model: 'gemini-4-argon-low', effort: null },
    })
    expect(first.branch).toBe('cx/A-parser')
    start(mac, first)
    const resetAt = isoSeconds(Date.now() + 5 * 3600_000)
    const handoff: TaskHandoff = { branch: first.branch, commit: '1a2b3c4', note: 'WIP A: quota handoff' }
    report(mac, {
      type: 'task.quota_exhausted', taskId: A, executor: 'agy', model: 'gemini-4-argon-low',
      modelScope: 'gemini-4-argon-*', resetAt, raw: 'RESOURCE_EXHAUSTED: Resets in 4h59m59s', handoff, attempt: first.attempt,
    })
    const second = await assigned(mac)
    expect(second).toMatchObject({
      id: A, attempt: 2, branch: first.branch, handoff, route: { executor: 'claude', model: 'opus', effort: null },
    })

    // 4. A completes → review, and the lead hears of it
    start(mac, second)
    const prA = 'https://github.com/o/r/pull/1'
    complete(mac, second, { summary: 'parser done', prUrl: prA, branch: second.branch, testOutput: '12 passed' })
    await sync(mac)
    expect(row(A).status).toBe('review')
    expect(await leadNotices()).toEqual([`A "Parser" is ready for review — ${prA} (tests attached)`])

    // 5. rejected with feedback: A runs again with the review; completed again and approved, B starts
    const feedback = 'handle an empty input'
    expect(await review(A, 'reject', feedback)).toMatchObject({ id: A, reject_count: 1 })
    const third = await assigned(mac)
    expect(third).toMatchObject({ id: A, attempt: 3, branch: first.branch, route: { executor: 'claude', model: 'opus', effort: null } })
    expect(third.reviews).toEqual([{ at: expect.any(String), by: LEAD, verdict: 'reject', feedback }])
    start(mac, third)
    complete(mac, third, { summary: 'empty input handled', prUrl: prA, branch: third.branch, testOutput: '13 passed' })
    await sync(mac)
    expect(row(A).status).toBe('review')
    expect(row(B).status).toBe('blocked')
    await sync(linux)
    expect(events.filter((e) => e.endsWith(B))).toEqual([])
    expect((await review(A, 'approve')).status).toBe('completed')
    // B has no last_agent: it goes to the worker idle longest, w-linux, idle since it registered
    const { worker: bWorker, task: bTask } = await assignedToAny([mac, linux])
    expect(bWorker.agentId).toBe('w-linux')
    expect(bTask).toMatchObject({ id: B, key: 'B', attempt: 1, route: { executor: null, model: null, effort: null } })

    // 6. B completes and is approved: the gate awaits the lead, who approves it
    start(bWorker, bTask)
    const prB = 'https://github.com/o/r/pull/2'
    complete(bWorker, bTask, { summary: 'cli done', prUrl: prB, branch: bTask.branch })
    await sync(bWorker)
    expect(row(B).status).toBe('review')
    expect((await review(B, 'approve')).status).toBe('completed')
    expect(row(G).status).toBe('pending')
    expect(await leadNotices()).toEqual([
      `A "Parser" is ready for review — ${prA} (tests attached)`,
      `B "Parser CLI" is ready for review — ${prB}`,
      'G "Ship check" is waiting for your approval (cortex_task_review).',
    ])
    expect(await review(G, 'approve')).toMatchObject({ id: G, status: 'completed', completed_by: LEAD })

    // 7. nothing held twice, three attempts at A, the quota recorded, B only after A's approval
    await sync(mac)
    await sync(linux)
    expect(doubleHeld).toEqual([])
    expect(assignedTypes(mac)).toEqual([])
    expect(assignedTypes(linux)).toEqual([])
    const fetched = await api('GET', `/api/conductor/${A}`)
    expect(fetched.body.task).toMatchObject({ status: 'completed', attempt: 3, fail_count: 0, reject_count: 1 })
    expect(testDb.prepare("SELECT host, executor, model, exhausted_until FROM conductor_quota WHERE host = 'h-mac'").all())
      .toEqual([{ host: 'h-mac', executor: 'agy', model: 'gemini-4-argon-*', exhausted_until: resetAt }])
    expect(events.filter((e) => e.endsWith(` ${A}`) || e.endsWith(` ${B}`))).toEqual([
      `w-mac task.assigned ${A}`,
      `w-mac task.assigned ${A}`,
      `lead reject ${A}`,
      `w-mac task.assigned ${A}`,
      `lead approve ${A}`,
      `${bWorker.agentId} task.assigned ${B}`,
      `lead approve ${B}`,
    ])
    expect(logId(B, 'assigned', 'ASC')).toBeGreaterThan(logId(A, 'approved', 'DESC'))
    expect(row(B)).toMatchObject({ status: 'completed', attempt: 1 })

    // every worker message was applied: no refusal logged or warned, and each attempt was accepted and progressed
    expect(testDb.prepare("SELECT task_id, message FROM conductor_task_logs WHERE action = 'ignored'").all()).toEqual([])
    expect(consoleWarn.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith('[ws]') && m.includes(' ignored'))).toEqual([])
    expect(startLogs(A)).toEqual(['accepted', 'progress', 'accepted', 'progress', 'accepted', 'progress'])
    expect(startLogs(B)).toEqual(['accepted', 'progress'])
  })
})
