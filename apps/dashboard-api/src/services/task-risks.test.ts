import { beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb, insertTask } from '../conductor/testing.js'

let testDb: Database.Database
vi.mock('../db/client.js', () => ({ get db() { return testDb } }))

import { captureTaskRisks, risksOf, type RiskDoc } from './task-risks.js'
import { completeTask, onTaskSettled } from '../conductor/lifecycle.js'
import type { TaskRow } from '../conductor/rows.js'

beforeEach(() => {
  testDb = createTestDb()
})

function task(result: unknown, extra: Partial<TaskRow> = {}): TaskRow {
  return insertTask(testDb, {
    id: 't1', task_key: 'T1', title: 'Fix login', project_id: 'proj-1', status: 'completed', completed_by: 'w1',
    files: JSON.stringify(['src/login.ts', 'src/session.ts']), result: JSON.stringify(result), ...extra,
  })
}

describe('risksOf', () => {
  it('takes strings and { text, files }, dropping blanks', () => {
    expect(risksOf({ risks: ['  token expiry  ', '', { text: 'race on refresh', files: ['src/session.ts', '*.ts'] }, { text: ' ' }, 3] }, ['a.ts']))
      .toEqual([
        { text: 'token expiry', files: ['a.ts'] },
        { text: 'race on refresh', files: ['src/session.ts'] },
      ])
  })

  it('a risk with no linkable files of its own covers the task\'s files', () => {
    expect(risksOf({ risks: [{ text: 'x', files: ['../out.ts'] }] }, ['a.ts'])).toEqual([{ text: 'x', files: ['a.ts'] }])
  })

  it('answers nothing for a result without risks, and at most twenty', () => {
    expect(risksOf({ summary: 'done' }, [])).toEqual([])
    expect(risksOf(null, [])).toEqual([])
    expect(risksOf({ risks: Array.from({ length: 30 }, (_, i) => `r${i}`) }, [])).toHaveLength(20)
  })
})

describe('captureTaskRisks', () => {
  const docs = () => testDb.prepare('SELECT * FROM knowledge_documents ORDER BY title').all() as Array<Record<string, unknown>>
  const links = () => testDb.prepare('SELECT document_id, project_id, file_path FROM knowledge_links ORDER BY file_path').all()

  it('hands each risk to the store as a risk document on its files', async () => {
    const stored: RiskDoc[] = []
    const t = task({ summary: 'done', artifactUrl: 'https://example.com/a', risks: ['Token expiry\nmore', { text: 'Race', files: ['src/session.ts'] }] })
    expect(await captureTaskRisks(t, async (d) => { stored.push(d); return true })).toBe(2)
    expect(stored[0]).toMatchObject({
      title: 'Risk: Token expiry', category: 'risk', hallType: 'advice', source: 'task', sourceTaskId: 't1',
      projectId: 'proj-1', sourceAgentId: 'w1', tags: ['risk', 'task:T1'], files: ['src/login.ts', 'src/session.ts'],
    })
    expect(stored[0]!.content).toBe(
      'Token expiry\nmore\n\nTask: T1 — Fix login\nArtifact: https://example.com/a\nFiles: src/login.ts, src/session.ts',
    )
    expect(stored[1]!.files).toEqual(['src/session.ts'])
    expect(docs()).toEqual([])
  })

  it('keeps the risk without vectors when the store fails, and not twice', async () => {
    const t = task({ summary: 'done', risks: ['Token expiry'] })
    const failing = vi.fn(async () => { throw new Error('embedder down') })
    expect(await captureTaskRisks(t, failing)).toBe(1)
    expect(docs()).toEqual([expect.objectContaining({
      title: 'Risk: Token expiry', category: 'risk', source_task_id: 't1', project_id: 'proj-1', chunk_count: 0,
      content: expect.stringContaining('Token expiry'),
    })])
    expect(links()).toEqual([
      { document_id: docs()[0]!.id, project_id: 'proj-1', file_path: 'src/login.ts' },
      { document_id: docs()[0]!.id, project_id: 'proj-1', file_path: 'src/session.ts' },
    ])
    expect(await captureTaskRisks(t, failing)).toBe(0)
    expect(failing).toHaveBeenCalledTimes(1)
  })

  it('a long first line is cut in the title', async () => {
    const stored: RiskDoc[] = []
    await captureTaskRisks(task({ summary: 'd', risks: ['x'.repeat(150)] }), async (d) => { stored.push(d); return true })
    expect(stored[0]!.title).toBe(`Risk: ${'x'.repeat(99)}…`)
  })
})

describe('onTaskSettled', () => {
  it('is told of a task that completes, after the commit', () => {
    insertTask(testDb, { id: 'a', status: 'in_progress', assigned_to_agent: 'w1', api_key_owner: 'lead', attempt: 1 })
    const told: Array<{ id: string; status: string; inTx: boolean }> = []
    onTaskSettled((t) => { told.push({ id: t.id, status: t.status, inTx: testDb.inTransaction }) })
    expect(completeTask('a', 'w1', 'completed', { summary: 'done', risks: ['r'] }).ok).toBe(true)
    expect(told).toEqual([{ id: 'a', status: 'completed', inTx: false }])
  })

  it('a listener that throws does not fail the completion', () => {
    insertTask(testDb, { id: 'b', status: 'in_progress', assigned_to_agent: 'w1', api_key_owner: 'lead', attempt: 1 })
    onTaskSettled(() => { throw new Error('boom') })
    expect(completeTask('b', 'w1', 'completed', { summary: 'done' }).ok).toBe(true)
  })
})
