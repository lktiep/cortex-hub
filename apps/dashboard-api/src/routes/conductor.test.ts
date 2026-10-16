import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ── In-memory DB for tests ──
let testDb: InstanceType<typeof Database>

function createTestDb() {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  const schemaPath = join(__dirname, '../db/schema.sql')
  const schema = readFileSync(schemaPath, 'utf-8')
  db.exec(schema)
  return db
}

// ── Mock db/client before importing conductor ──
vi.mock('../db/client.js', () => ({
  get db() {
    return testDb
  },
}))

// ── Mock ws/conductor (not needed for these tests) ──
vi.mock('../ws/conductor.js', () => ({
  getAllConnectedAgents: vi.fn(() => []),
  notifyAgents: vi.fn(),
}))

// ── Import after mocks ──
import { Hono } from 'hono'
import { conductorRouter } from './conductor.js'

const app = new Hono()
app.route('/api/conductor', conductorRouter)

// ── Helpers ──

function insertTask(overrides: Partial<{
  id: string
  title: string
  description: string
  status: string
  context: string
  result: string
}> = {}) {
  const id = overrides.id ?? 'task_test001'
  const title = overrides.title ?? 'Test task'
  const description = overrides.description ?? 'A test task'
  const status = overrides.status ?? 'completed'
  const context = overrides.context ?? '{}'
  const result = overrides.result ?? null

  testDb.prepare(`
    INSERT INTO conductor_tasks (id, title, description, status, context, result)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, title, description, status, context, result)

  return id
}

function getTask(id: string) {
  return testDb.prepare('SELECT * FROM conductor_tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
}

function getTaskLogs(taskId: string) {
  return testDb.prepare('SELECT * FROM conductor_task_logs WHERE task_id = ? ORDER BY id').all(taskId) as Array<Record<string, unknown>>
}

// ── Tests ──

beforeEach(() => {
  testDb = createTestDb()
})

afterEach(() => {
  testDb.close()
})

describe('PUT /api/conductor/:id/matrix/:findingId', () => {
  it('approves a finding and stores decision in context', async () => {
    const taskId = insertTask()

    const res = await app.request(`/api/conductor/${taskId}/matrix/finding-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved', reason: 'Looks good' }),
    })

    expect(res.status).toBe(200)
    const json = await res.json() as { success: boolean; findingId: string; status: string; decisions: Record<string, unknown> }
    expect(json.success).toBe(true)
    expect(json.findingId).toBe('finding-1')
    expect(json.status).toBe('approved')
    expect(json.decisions['finding-1']).toMatchObject({
      status: 'approved',
      reason: 'Looks good',
    })

    // Verify persisted in DB
    const task = getTask(taskId)
    const ctx = JSON.parse(task!['context'] as string)
    expect(ctx.decisions['finding-1'].status).toBe('approved')
    expect(ctx.decisions['finding-1'].reason).toBe('Looks good')
    expect(ctx.decisions['finding-1'].decidedAt).toBeDefined()

    // Verify log entry
    const logs = getTaskLogs(taskId)
    expect(logs.some((l) => l['action'] === 'finding_approved')).toBe(true)
  })

  it('rejects a finding and stores decision in context', async () => {
    const taskId = insertTask()

    const res = await app.request(`/api/conductor/${taskId}/matrix/finding-2`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'rejected', reason: 'Not relevant' }),
    })

    expect(res.status).toBe(200)
    const json = await res.json() as { success: boolean; findingId: string; status: string; decisions: Record<string, unknown> }
    expect(json.success).toBe(true)
    expect(json.status).toBe('rejected')
    expect(json.decisions['finding-2']).toMatchObject({
      status: 'rejected',
      reason: 'Not relevant',
    })

    // Verify log
    const logs = getTaskLogs(taskId)
    expect(logs.some((l) => l['action'] === 'finding_rejected')).toBe(true)
  })

  it('rejects invalid status values', async () => {
    const taskId = insertTask()

    const res = await app.request(`/api/conductor/${taskId}/matrix/finding-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'maybe' }),
    })

    expect(res.status).toBe(400)
    const json = await res.json() as { error: string }
    expect(json.error).toContain('approved')
  })

  it('returns 404 for non-existent task', async () => {
    const res = await app.request('/api/conductor/task_nonexistent/matrix/finding-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    })

    expect(res.status).toBe(404)
  })

  it('accumulates multiple decisions on the same task', async () => {
    const taskId = insertTask()

    // Approve finding-1
    await app.request(`/api/conductor/${taskId}/matrix/finding-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    })

    // Reject finding-2
    await app.request(`/api/conductor/${taskId}/matrix/finding-2`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'rejected', reason: 'Duplicate' }),
    })

    // Verify both are stored
    const task = getTask(taskId)
    const ctx = JSON.parse(task!['context'] as string)
    expect(Object.keys(ctx.decisions)).toHaveLength(2)
    expect(ctx.decisions['finding-1'].status).toBe('approved')
    expect(ctx.decisions['finding-2'].status).toBe('rejected')
  })

  it('allows overwriting a previous decision', async () => {
    const taskId = insertTask()

    // First: reject
    await app.request(`/api/conductor/${taskId}/matrix/finding-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'rejected', reason: 'Bad' }),
    })

    // Then: approve (change mind)
    const res = await app.request(`/api/conductor/${taskId}/matrix/finding-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved', reason: 'Actually fine' }),
    })

    expect(res.status).toBe(200)
    const task = getTask(taskId)
    const ctx = JSON.parse(task!['context'] as string)
    expect(ctx.decisions['finding-1'].status).toBe('approved')
    expect(ctx.decisions['finding-1'].reason).toBe('Actually fine')
  })

  it('preserves existing context fields when adding decisions', async () => {
    const taskId = insertTask({ context: JSON.stringify({ existingKey: 'existingValue' }) })

    await app.request(`/api/conductor/${taskId}/matrix/finding-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    })

    const task = getTask(taskId)
    const ctx = JSON.parse(task!['context'] as string)
    expect(ctx.existingKey).toBe('existingValue')
    expect(ctx.decisions['finding-1'].status).toBe('approved')
  })
})

describe('POST /api/conductor/:id/finalize', () => {
  const findingsResult = JSON.stringify({
    summary: 'Security audit results',
    findings: [
      { id: 'f1', title: 'SQL Injection', severity: 'high' },
      { id: 'f2', title: 'XSS in form', severity: 'medium' },
      { id: 'f3', title: 'Open redirect', severity: 'low' },
    ],
  })

  it('includes only approved findings in final result', async () => {
    // Create task with findings in result and decisions in context
    const decisions = {
      f1: { status: 'approved', decidedAt: '2026-04-01T00:00:00Z' },
      f2: { status: 'rejected', reason: 'False positive', decidedAt: '2026-04-01T00:00:00Z' },
      f3: { status: 'approved', decidedAt: '2026-04-01T00:00:00Z' },
    }
    const taskId = insertTask({
      result: findingsResult,
      context: JSON.stringify({ decisions }),
      status: 'review',
    })

    const res = await app.request(`/api/conductor/${taskId}/finalize`, { method: 'POST' })

    expect(res.status).toBe(200)
    const json = await res.json() as { task: Record<string, unknown> }
    const finalResult = JSON.parse(json.task['result'] as string)

    expect(finalResult.finalized).toBe(true)
    expect(finalResult.summary).toBe('Security audit results')
    expect(finalResult.findings).toHaveLength(2)
    expect(finalResult.findings.map((f: { id: string }) => f.id)).toEqual(['f1', 'f3'])
    expect(finalResult.approvedCount).toBe(2)
    expect(finalResult.rejectedCount).toBe(1)
    expect(finalResult.totalFindings).toBe(3)
    expect(finalResult.finalizedAt).toBeDefined()
  })

  it('sets task status to completed after finalize', async () => {
    const decisions = {
      f1: { status: 'approved', decidedAt: '2026-04-01T00:00:00Z' },
    }
    const taskId = insertTask({
      result: findingsResult,
      context: JSON.stringify({ decisions }),
      status: 'review',
    })

    await app.request(`/api/conductor/${taskId}/finalize`, { method: 'POST' })

    const task = getTask(taskId)
    expect(task!['status']).toBe('completed')
    expect(task!['completed_at']).toBeDefined()
  })

  it('returns empty findings when all are rejected', async () => {
    const decisions = {
      f1: { status: 'rejected', decidedAt: '2026-04-01T00:00:00Z' },
      f2: { status: 'rejected', decidedAt: '2026-04-01T00:00:00Z' },
      f3: { status: 'rejected', decidedAt: '2026-04-01T00:00:00Z' },
    }
    const taskId = insertTask({
      result: findingsResult,
      context: JSON.stringify({ decisions }),
      status: 'review',
    })

    const res = await app.request(`/api/conductor/${taskId}/finalize`, { method: 'POST' })
    const json = await res.json() as { task: Record<string, unknown> }
    const finalResult = JSON.parse(json.task['result'] as string)

    expect(finalResult.findings).toHaveLength(0)
    expect(finalResult.approvedCount).toBe(0)
    expect(finalResult.rejectedCount).toBe(3)
  })

  it('handles task with no decisions (undecided findings excluded)', async () => {
    const taskId = insertTask({
      result: findingsResult,
      context: '{}',
      status: 'review',
    })

    const res = await app.request(`/api/conductor/${taskId}/finalize`, { method: 'POST' })
    const json = await res.json() as { task: Record<string, unknown> }
    const finalResult = JSON.parse(json.task['result'] as string)

    // No decisions means no findings match approved status
    expect(finalResult.findings).toHaveLength(0)
    expect(finalResult.approvedCount).toBe(0)
    expect(finalResult.rejectedCount).toBe(0)
    expect(finalResult.totalFindings).toBe(3)
  })

  it('returns 404 for non-existent task', async () => {
    const res = await app.request('/api/conductor/task_nonexistent/finalize', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('logs finalization action', async () => {
    const decisions = {
      f1: { status: 'approved', decidedAt: '2026-04-01T00:00:00Z' },
    }
    const taskId = insertTask({
      result: findingsResult,
      context: JSON.stringify({ decisions }),
      status: 'review',
    })

    await app.request(`/api/conductor/${taskId}/finalize`, { method: 'POST' })

    const logs = getTaskLogs(taskId)
    const finalizeLog = logs.find((l) => l['action'] === 'finalized')
    expect(finalizeLog).toBeDefined()
    expect(finalizeLog!['message']).toContain('1/3 findings approved')
  })
})

describe('context.decisions JSON storage and retrieval', () => {
  it('round-trips decisions through DB correctly', async () => {
    const taskId = insertTask()

    // Store via API
    await app.request(`/api/conductor/${taskId}/matrix/complex-id-with-dashes`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved', reason: 'Unicode: 日本語テスト' }),
    })

    // Read directly from DB
    const row = testDb.prepare('SELECT context FROM conductor_tasks WHERE id = ?').get(taskId) as { context: string }
    const ctx = JSON.parse(row.context)

    expect(ctx.decisions['complex-id-with-dashes']).toEqual({
      status: 'approved',
      reason: 'Unicode: 日本語テスト',
      decidedAt: expect.any(String),
    })

    // Verify decidedAt is valid ISO date
    const date = new Date(ctx.decisions['complex-id-with-dashes'].decidedAt)
    expect(date.getTime()).not.toBeNaN()
  })

  it('decisions survive approve then finalize flow', async () => {
    const result = JSON.stringify({
      summary: 'Test',
      findings: [
        { id: 'a', title: 'Finding A' },
        { id: 'b', title: 'Finding B' },
      ],
    })
    const taskId = insertTask({ result, status: 'review' })

    // Approve A, reject B via matrix endpoint
    await app.request(`/api/conductor/${taskId}/matrix/a`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    })
    await app.request(`/api/conductor/${taskId}/matrix/b`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'rejected', reason: 'Not applicable' }),
    })

    // Finalize
    const res = await app.request(`/api/conductor/${taskId}/finalize`, { method: 'POST' })
    const json = await res.json() as { task: Record<string, unknown> }
    const finalResult = JSON.parse(json.task['result'] as string)

    expect(finalResult.findings).toHaveLength(1)
    expect(finalResult.findings[0].id).toBe('a')
    expect(finalResult.approvedCount).toBe(1)
    expect(finalResult.rejectedCount).toBe(1)
    expect(finalResult.finalized).toBe(true)
  })

  it('reason field is optional', async () => {
    const taskId = insertTask()

    const res = await app.request(`/api/conductor/${taskId}/matrix/finding-no-reason`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    })

    expect(res.status).toBe(200)
    const task = getTask(taskId)
    const ctx = JSON.parse(task!['context'] as string)
    // reason should be undefined (not stored or stored as undefined)
    expect(ctx.decisions['finding-no-reason'].status).toBe('approved')
  })
})
