// The risks a task reports when it completes are kept as knowledge linked to the files it
// touched, so the next agent to open those files is shown them (services/file-notes.ts)
// instead of having to know there was a task, an artifact and a risk section to look for.
import { randomUUID } from 'crypto'
import { createLogger } from '@cortex/shared-utils'
import { db } from '../db/client.js'
import { parseJson, stringList, taskLabel, type TaskRow } from '../conductor/rows.js'
import { linkablePaths, linkFiles } from './file-notes.js'

const logger = createLogger('task-risks')

const MAX_RISKS = 20
const TITLE_CHARS = 100

export interface RiskEntry { text: string; files: string[] }

/** A knowledge document as POST /api/knowledge takes it. */
export interface RiskDoc {
  title: string
  content: string
  tags: string[]
  projectId: string | null
  sourceAgentId: string | null
  sourceTaskId: string
  source: 'task'
  category: 'risk'
  hallType: 'advice'
  files: string[]
}

/** Stores a document the way POST /api/knowledge does (chunked and embedded); false when it did not. */
export type StoreDoc = (doc: RiskDoc) => Promise<boolean>

/**
 * The risks of a task result: each a string, or `{ text, files }` whose files narrow it to
 * some of the task's files. Blank entries are dropped; a risk without files of its own covers
 * every file of the task.
 */
export function risksOf(result: unknown, taskFiles: string[]): RiskEntry[] {
  const raw = (result as { risks?: unknown } | null)?.risks
  if (!Array.isArray(raw)) return []
  const out: RiskEntry[] = []
  for (const r of raw) {
    const text = typeof r === 'string' ? r : typeof (r as { text?: unknown })?.text === 'string' ? (r as { text: string }).text : ''
    if (text.trim() === '') continue
    const own = typeof r === 'object' && r !== null ? linkablePaths((r as { files?: unknown }).files) : []
    out.push({ text: text.trim(), files: own.length > 0 ? own : taskFiles })
    if (out.length === MAX_RISKS) break
  }
  return out
}

function titleOf(text: string): string {
  const line = text.split('\n')[0]!.trim()
  return `Risk: ${line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1)}…` : line}`
}

/** The risk first, so the preview an agent is shown is the risk itself; then where it came from. */
function contentOf(risk: RiskEntry, task: TaskRow, result: { artifactUrl?: unknown; prUrl?: unknown }): string {
  const lines = [risk.text, '', `Task: ${taskLabel(task)} — ${task.title}`]
  if (typeof result.artifactUrl === 'string') lines.push(`Artifact: ${result.artifactUrl}`)
  if (typeof result.prUrl === 'string') lines.push(`PR: ${result.prUrl}`)
  if (risk.files.length > 0) lines.push(`Files: ${risk.files.join(', ')}`)
  return lines.join('\n')
}

/**
 * The document row and its links without vectors, for when the embedder is down: the risk is
 * still shown on its files, and only semantic search misses it.
 */
function storePlain(doc: RiskDoc): void {
  const id = `kdoc-${randomUUID().slice(0, 8)}`
  db.prepare(
    `INSERT INTO knowledge_documents (id, title, content, source, source_agent_id, project_id, tags, content_preview, chunk_count, origin, category, source_task_id, created_by_agent, hall_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'manual', ?, ?, ?, ?)`
  ).run(id, doc.title, doc.content, doc.source, doc.sourceAgentId, doc.projectId, JSON.stringify(doc.tags),
    doc.content.slice(0, 500), doc.category, doc.sourceTaskId, doc.sourceAgentId, doc.hallType)
  if (doc.files.length > 0) linkFiles(id, doc.projectId, doc.files)
}

/**
 * Keeps each risk of a settled task as a `risk` document. A task settles twice when it goes
 * through review, so a risk already kept for the task (same title) is not stored again.
 * Returns how many were stored.
 */
export async function captureTaskRisks(task: TaskRow, store: StoreDoc): Promise<number> {
  const result = parseJson<Record<string, unknown> | null>(task.result, null)
  if (result === null) return 0
  const risks = risksOf(result, linkablePaths(stringList(task.files)))
  const seen = db.prepare("SELECT 1 FROM knowledge_documents WHERE source_task_id = ? AND category = 'risk' AND title = ?")
  let stored = 0
  for (const risk of risks) {
    const title = titleOf(risk.text)
    if (seen.get(task.id, title)) continue
    const doc: RiskDoc = {
      title,
      content: contentOf(risk, task, result),
      tags: ['risk', `task:${taskLabel(task)}`],
      projectId: task.project_id,
      sourceAgentId: task.completed_by ?? task.assigned_to_agent ?? null,
      sourceTaskId: task.id,
      source: 'task',
      category: 'risk',
      hallType: 'advice',
      files: risk.files,
    }
    const ok = await store(doc).catch((err: unknown) => {
      logger.warn(`[${task.id}] storing a risk failed: ${String(err).slice(0, 200)}`)
      return false
    })
    if (!ok) storePlain(doc)
    stored++
  }
  return stored
}
