// Knowledge linked to repo files: a risk, lesson or past fix recorded against the files it is
// about, so an agent is shown it when it reaches those files instead of having to search for it.
import { db } from '../db/client.js'
import { normalizeProjectId } from '../db/project-utils.js'
import { allowedOrgs, currentGrant } from '../lib/key-grant.js'
import { normalizePath } from '../conductor/files.js'
import { findProjectByRepo } from '../lib/project-match.js'
import { projectOfActiveSession } from '../lib/session-project.js'

/** Newest notes kept per path: the ones an agent reads before the file, so few and short. */
export const NOTES_PER_FILE = 3
/** Links one document may carry: a note about fifty files is about none of them. */
export const MAX_LINKS = 50
const NOTE_CHARS = 280

export interface FileNote {
  id: string
  title: string
  /** The document's category: `risk`, `error_fix`, `lesson`, … */
  kind: string
  note: string
  at: string
}

/**
 * The repo-relative paths a document can be linked to, deduplicated. Globs, `..`, absolute
 * Windows drives and empty paths are dropped rather than refused: a link is a hint, and one
 * bad path should not lose the note. A trailing `/` keeps the path a directory.
 */
export function linkablePaths(files: unknown): string[] {
  if (!Array.isArray(files)) return []
  const out = new Set<string>()
  for (const f of files) {
    if (typeof f !== 'string' || /[*?[]/.test(f) || /^[A-Za-z]:/.test(f)) continue
    const p = normalizePath(f.trim())
    if (p === '' || p.split('/').includes('..')) continue
    out.add(p)
    if (out.size === MAX_LINKS) break
  }
  return [...out]
}

export function linkFiles(documentId: string, projectId: string | null, files: string[]): void {
  const insert = db.prepare('INSERT OR IGNORE INTO knowledge_links (document_id, project_id, file_path) VALUES (?, ?, ?)')
  db.transaction(() => {
    for (const f of files) insert.run(documentId, projectId, f)
  })()
}

export function unlinkDocument(documentId: string): void {
  db.prepare('DELETE FROM knowledge_links WHERE document_id = ?').run(documentId)
}

/** The linked paths of each document, for lists that show them. */
export function linksOf(documentIds: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  if (documentIds.length === 0) return out
  const rows = db.prepare(
    `SELECT document_id, file_path FROM knowledge_links
      WHERE document_id IN (${documentIds.map(() => '?').join(',')})
      ORDER BY file_path`
  ).all(...documentIds) as Array<{ document_id: string; file_path: string }>
  for (const r of rows) {
    const list = out.get(r.document_id) ?? []
    list.push(r.file_path)
    out.set(r.document_id, list)
  }
  return out
}

type LinkRow = { file_path: string; id: string; title: string; category: string | null; content_preview: string | null; created_at: string }

/** Every live note of a project by linked path, newest first. Archived and invalidated documents are left out. */
function liveLinks(projectId: string): LinkRow[] {
  return db.prepare(
    `SELECT l.file_path, d.id, d.title, d.category, d.content_preview, d.created_at
       FROM knowledge_links l
       JOIN knowledge_documents d ON d.id = l.document_id
      WHERE l.project_id = ? AND d.status = 'active' AND d.invalidated_at IS NULL
      ORDER BY d.created_at DESC, d.id`
  ).all(projectId) as LinkRow[]
}

function toNote(r: LinkRow): FileNote {
  const note = (r.content_preview ?? '').replace(/\s+/g, ' ').trim()
  return {
    id: r.id,
    title: r.title,
    kind: r.category ?? 'general',
    note: note.length > NOTE_CHARS ? `${note.slice(0, NOTE_CHARS - 1)}…` : note,
    at: r.created_at,
  }
}

/** True when a linked path covers a file: the file itself, or a directory holding it. */
export function covers(linked: string, file: string): boolean {
  return linked === file || (linked.endsWith('/') && file.startsWith(linked))
}

/** True when the text names the path as a whole: `src/a.ts` is not named by `lib/src/a.ts` or `src/a.tsx`. */
export function names(text: string, path: string): boolean {
  for (let at = text.indexOf(path); at !== -1; at = text.indexOf(path, at + 1)) {
    const before = text[at - 1] ?? ''
    const after = text[at + path.length] ?? ''
    if (!/[\w./-]/.test(before) && !/[\w-]/.test(after) && !/^\.\w/.test(text.slice(at + path.length))) return true
  }
  return false
}

function group(rows: LinkRow[], keyOf: (linked: string) => string[]): Record<string, FileNote[]> {
  const out: Record<string, FileNote[]> = {}
  for (const r of rows) {
    for (const key of keyOf(r.file_path)) {
      const list = (out[key] ??= [])
      if (list.length < NOTES_PER_FILE && !list.some((n) => n.id === r.id)) list.push(toNote(r))
    }
  }
  return out
}

/**
 * Notes by path. With `files`, the notes covering each of them, keyed by the file asked for.
 * With `text` (a code lookup's answer), the notes of every linked path the text names. With
 * neither, every linked path of the project: what a client caches to check reads locally.
 */
export function notesFor(projectId: string, select: { files?: string[]; text?: string } = {}): Record<string, FileNote[]> {
  const rows = liveLinks(projectId)
  if (select.files) {
    const files = select.files.map((f) => normalizePath(f))
    return group(rows, (linked) => files.filter((f) => covers(linked, f)))
  }
  if (select.text !== undefined) {
    const text = select.text
    return group(rows, (linked) => (!linked.endsWith('/') && names(text, linked) ? [linked] : []))
  }
  return group(rows, (linked) => [linked])
}

/**
 * The project a notes request is about: the repo it names (as cortex_session_start matches
 * it), else the project id, else the caller's latest session. undefined when none resolves.
 */
export function notesProject(hints: { repo?: string; projectId?: string; apiKeyOwner?: string | null }): string | undefined {
  // A repo or project that is named but unknown answers nothing: falling back to the session
  // would hand back another project's notes.
  if (hints.repo) return findProjectByRepo(hints.repo, allowedOrgs(currentGrant()))?.id
  if (hints.projectId) {
    const id = normalizeProjectId(hints.projectId)
    const known = id ? db.prepare('SELECT id FROM projects WHERE id = ?').get(id) as { id: string } | undefined : undefined
    return known?.id
  }
  return projectOfActiveSession(hints.apiKeyOwner)?.id
}
