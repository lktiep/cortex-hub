import { beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from '../conductor/testing.js'

let testDb: Database.Database
vi.mock('../db/client.js', () => ({ get db() { return testDb } }))

import { covers, linkablePaths, linkFiles, linksOf, MAX_LINKS, names, notesFor, notesProject, unlinkDocument } from './file-notes.js'

function doc(id: string, extra: { category?: string; status?: string; invalidated?: boolean; at?: string; preview?: string } = {}): void {
  testDb.prepare(
    `INSERT INTO knowledge_documents (id, title, project_id, category, status, invalidated_at, created_at, content_preview)
     VALUES (?, ?, 'proj-1', ?, ?, ?, ?, ?)`,
  ).run(id, `T ${id}`, extra.category ?? 'risk', extra.status ?? 'active', extra.invalidated ? '2026-10-01T00:00:00Z' : null,
    extra.at ?? '2026-10-20T00:00:00Z', extra.preview ?? `note ${id}`)
}

beforeEach(() => {
  testDb = createTestDb()
  testDb.exec('ALTER TABLE session_handoffs ADD COLUMN api_key_name TEXT')
  testDb.prepare("INSERT INTO organizations (id, name, slug) VALUES ('org-1', 'Org', 'org')").run()
  testDb.prepare(
    `INSERT INTO projects (id, org_id, name, slug, git_repo_url)
     VALUES ('proj-1', 'org-1', 'Demo', 'demo', 'https://github.com/example/demo.git'),
            ('proj-2', 'org-1', 'Other', 'other', 'https://github.com/example/other.git')`,
  ).run()
})

describe('linkablePaths', () => {
  it('keeps repo-relative paths and directories, deduplicated', () => {
    expect(linkablePaths(['./src/a.ts', 'src/a.ts', 'src/lib/', 'src\\b.ts'])).toEqual(['src/a.ts', 'src/lib/', 'src/b.ts'])
  })

  it('drops globs, parent paths, drives, blanks and non-strings', () => {
    expect(linkablePaths(['src/*.ts', '../x.ts', 'a/../../b', 'C:\\x\\y.ts', '  ', 7, null])).toEqual([])
    expect(linkablePaths('src/a.ts')).toEqual([])
  })

  it('caps the links of one document', () => {
    expect(linkablePaths(Array.from({ length: 80 }, (_, i) => `f${i}.ts`))).toHaveLength(MAX_LINKS)
  })
})

describe('covers and names', () => {
  it('a path covers itself and a directory covers what it holds', () => {
    expect(covers('src/a.ts', 'src/a.ts')).toBe(true)
    expect(covers('src/', 'src/deep/a.ts')).toBe(true)
    expect(covers('src', 'src/a.ts')).toBe(false)
    expect(covers('src/a.ts', 'src/a.tsx')).toBe(false)
  })

  it('a text names a path only as a whole', () => {
    expect(names('see src/a.ts:12 for it', 'src/a.ts')).toBe(true)
    expect(names('`src/a.ts`', 'src/a.ts')).toBe(true)
    expect(names('src/a.ts.', 'src/a.ts')).toBe(true)
    expect(names('lib/src/a.ts', 'src/a.ts')).toBe(false)
    expect(names('src/a.tsx', 'src/a.ts')).toBe(false)
    expect(names('src/a.ts.bak', 'src/a.ts')).toBe(false)
  })
})

describe('notesFor', () => {
  it('answers the files asked for, newest first, three at most', () => {
    for (const [i, at] of ['01', '02', '03', '04'].entries()) {
      doc(`d${i}`, { at: `2026-10-${at}T00:00:00Z` })
      linkFiles(`d${i}`, 'proj-1', ['src/a.ts'])
    }
    doc('dir', { at: '2026-10-10T00:00:00Z', category: 'lesson' })
    linkFiles('dir', 'proj-1', ['src/'])

    const notes = notesFor('proj-1', { files: ['./src/a.ts', 'src/none.ts', 'lib/x.ts'] })
    expect(notes['src/a.ts']!.map((n) => n.id)).toEqual(['dir', 'd3', 'd2'])
    expect(notes['src/none.ts']!.map((n) => n.id)).toEqual(['dir'])
    expect(notes['src/none.ts']![0]).toMatchObject({ kind: 'lesson', title: 'T dir', note: 'note dir' })
    expect(notes['lib/x.ts']).toBeUndefined()
  })

  it('leaves out archived and invalidated documents and other projects', () => {
    doc('old', { status: 'archived' })
    doc('gone', { invalidated: true })
    doc('live')
    for (const id of ['old', 'gone', 'live']) linkFiles(id, 'proj-1', ['src/a.ts'])
    linkFiles('live', 'proj-2', ['src/b.ts'])
    expect(notesFor('proj-1')).toEqual({ 'src/a.ts': [expect.objectContaining({ id: 'live' })] })
  })

  it('with text, answers the linked files it names', () => {
    doc('n1')
    doc('n2')
    linkFiles('n1', 'proj-1', ['src/a.ts'])
    linkFiles('n2', 'proj-1', ['src/b.ts', 'src/'])
    expect(Object.keys(notesFor('proj-1', { text: '1. src/a.ts (score 0.9)\n2. src/c.ts' }))).toEqual(['src/a.ts'])
  })

  it('shortens long notes to one line', () => {
    doc('long', { preview: `line one\n${'x'.repeat(400)}` })
    linkFiles('long', 'proj-1', ['a.ts'])
    const note = notesFor('proj-1')['a.ts']![0]!.note
    expect(note.startsWith('line one x')).toBe(true)
    expect(note).toHaveLength(280)
  })
})

describe('links', () => {
  it('lists and removes a document\'s links', () => {
    doc('d')
    linkFiles('d', 'proj-1', ['b.ts', 'a.ts', 'a.ts'])
    expect(linksOf(['d', 'none'])).toEqual(new Map([['d', ['a.ts', 'b.ts']]]))
    unlinkDocument('d')
    expect(linksOf(['d']).size).toBe(0)
  })
})

describe('notesProject', () => {
  it('a named repo or project decides, and an unknown one answers nothing', () => {
    expect(notesProject({ repo: 'https://github.com/example/other.git', apiKeyOwner: 'k' })).toBe('proj-2')
    expect(notesProject({ repo: 'https://github.com/example/unknown.git', apiKeyOwner: 'k' })).toBeUndefined()
    expect(notesProject({ projectId: 'proj-2' })).toBe('proj-2')
    expect(notesProject({ projectId: 'nope' })).toBeUndefined()
  })

  it('otherwise the caller\'s latest session', () => {
    testDb.prepare(
      `INSERT INTO session_handoffs (id, from_agent, project, task_summary, context, status, project_id, api_key_name)
       VALUES ('s1', 'agent', 'demo', 's', '{}', 'active', 'proj-1', 'k')`,
    ).run()
    expect(notesProject({ apiKeyOwner: 'k' })).toBe('proj-1')
    expect(notesProject({ apiKeyOwner: 'someone-else' })).toBeUndefined()
    expect(notesProject({})).toBeUndefined()
  })
})
