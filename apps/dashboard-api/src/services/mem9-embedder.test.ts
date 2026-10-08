import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type * as SharedMem9 from '@cortex/shared-mem9'

const reposDir = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/mem9-embedder-test-${process.pid}`
  process.env.REPOS_DIR = dir
  return dir
})

// ── A Qdrant collection in memory, answering the filters the embedder sends ──

interface StoredPoint {
  id: string
  vector: number[]
  payload: Record<string, unknown>
}

type Condition = { key: string; match: { value?: unknown; any?: unknown[] } }

const qdrant = vi.hoisted(() => ({ points: new Map<string, StoredPoint>() }))
const embedCalls = vi.hoisted(() => ({ texts: [] as string[], fail: false }))
const routing = vi.hoisted(() => ({ models: [] as string[] }))

function matches(payload: Record<string, unknown>, filter?: { must?: Condition[]; must_not?: Condition[] }): boolean {
  const test = (c: Condition) =>
    c.match.any ? c.match.any.includes(payload[c.key]) : payload[c.key] === c.match.value
  return (filter?.must ?? []).every(test) && !(filter?.must_not ?? []).some(test)
}

vi.mock('@cortex/shared-mem9', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedMem9>()

  // A deterministic stand-in for a model: the vector is a function of the text.
  const vectorOf = (text: string) => [text.length, text.charCodeAt(0) || 0, 1]

  class Embedder {
    async embed(text: string) {
      return vectorOf(text)
    }
    async embedBatch(texts: string[]) {
      if (embedCalls.fail) throw new Error('model down')
      embedCalls.texts.push(...texts)
      return texts.map(vectorOf)
    }
  }

  class VectorStore {
    async count(filter?: { must?: Condition[]; must_not?: Condition[] }) {
      return [...qdrant.points.values()].filter((p) => matches(p.payload, filter)).length
    }
    async ensureCollection() {
      return { sparseVectorEnabled: true }
    }
    async ensurePayloadIndex() {}
    async scrollAll(filter: { must?: Condition[] }, opts: { vector?: boolean } = {}) {
      return [...qdrant.points.values()]
        .filter((p) => matches(p.payload, filter))
        .map((p) => ({ id: p.id, payload: p.payload, ...(opts.vector ? { vector: p.vector } : {}) }))
    }
    async upsertBatch(points: StoredPoint[]) {
      for (const p of points) qdrant.points.set(p.id, { id: p.id, vector: p.vector, payload: p.payload })
    }
    async deletePoints(ids: string[]) {
      for (const id of ids) qdrant.points.delete(id)
    }
  }

  return { ...actual, Embedder, VectorStore }
})

vi.mock('../db/client.js', () => ({
  db: {
    prepare: (sql: string) => ({
      get: (accountId?: string) => {
        if (sql.includes('model_routing')) {
          return routing.models.length > 0
            ? { chain: JSON.stringify(routing.models.map((model) => ({ accountId: 'acc-1', model }))) }
            : undefined
        }
        return { id: accountId, api_base: 'http://ollama:11434', api_key: null, type: 'ollama' }
      },
    }),
  },
}))

import { embedProject, chunkPointId, chunkContentHash, embeddingFingerprint } from './mem9-embedder.js'

const PROJECT = 'proj-test'
const repo = join(reposDir, PROJECT)

function writeTree(files: Record<string, string>) {
  rmSync(repo, { recursive: true, force: true })
  mkdirSync(repo, { recursive: true })
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repo, path, '..'), { recursive: true })
    writeFileSync(join(repo, path), content)
  }
}

// Long enough to make several chunks, so an edit at the end leaves the first alone.
const big = (tag: string) =>
  Array.from({ length: 120 }, (_, i) => `export const value${i} = '${i === 119 ? tag : 'same'}'`).join('\n')

const tree = {
  'src/a.ts': big('one'),
  'src/b.ts': 'export function b() { return 2 }\n',
}

const branchPoints = (branch: string) => [...qdrant.points.values()].filter((p) => p.payload['branch'] === branch)

describe('chunk identity', () => {
  it('gives the same chunk the same id and any change another', () => {
    const parts = {
      projectId: 'p', branch: 'main', filePath: 'a.ts', chunkIndex: 0,
      contentHash: chunkContentHash('x'), embedFp: embeddingFingerprint(['all-minilm'], 384),
    }
    const id = chunkPointId(parts)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(chunkPointId({ ...parts })).toBe(id)
    expect(chunkPointId({ ...parts, branch: 'dev' })).not.toBe(id)
    expect(chunkPointId({ ...parts, chunkIndex: 1 })).not.toBe(id)
    expect(chunkPointId({ ...parts, contentHash: chunkContentHash('y') })).not.toBe(id)
    expect(chunkPointId({ ...parts, embedFp: embeddingFingerprint(['bge-m3'], 1024) })).not.toBe(id)
  })

  it('names the model chain and the dimensions in the fingerprint', () => {
    expect(embeddingFingerprint([], 384)).toBe('auto@384')
    expect(embeddingFingerprint(['all-minilm', 'bge-m3'], 384)).toBe('all-minilm>bge-m3@384')
  })
})

describe('embedProject — incremental', () => {
  beforeEach(() => {
    qdrant.points.clear()
    embedCalls.texts = []
    embedCalls.fail = false
    routing.models = ['all-minilm']
  })

  afterAll(() => rmSync(reposDir, { recursive: true, force: true }))

  it('embeds every chunk the first time and none when nothing changed', async () => {
    writeTree(tree)
    const first = await embedProject(PROJECT, 'main', 'job-1')
    expect(first.status).toBe('done')
    expect(first.chunks).toBeGreaterThan(2)
    expect(first.embedded).toBe(first.chunks)
    expect(branchPoints('main')).toHaveLength(first.chunks)
    expect(branchPoints('main').every((p) => typeof p.payload['content_hash'] === 'string')).toBe(true)

    embedCalls.texts = []
    const again = await embedProject(PROJECT, 'main', 'job-2')
    expect(again).toMatchObject({ status: 'done', chunks: first.chunks, embedded: 0, unchanged: first.chunks, removed: 0 })
    expect(embedCalls.texts).toEqual([])
  })

  it('re-embeds only the chunks an edit touched and deletes what they replaced', async () => {
    writeTree(tree)
    const first = await embedProject(PROJECT, 'main', 'job-1')
    const before = new Set(branchPoints('main').map((p) => p.id))

    writeTree({ ...tree, 'src/a.ts': big('two') })
    embedCalls.texts = []
    const edited = await embedProject(PROJECT, 'main', 'job-2')

    // The edited line sits in every chunk that overlaps it, and only those.
    const touched = branchPoints('main').filter((p) => String(p.payload['content']).includes("'two'"))
    expect(touched.length).toBeGreaterThan(0)
    expect(touched.length).toBeLessThan(first.chunks - 1)
    expect(edited).toMatchObject({ status: 'done', embedded: touched.length, removed: touched.length })
    expect(embedCalls.texts.every((text) => text.includes("'two'"))).toBe(true)
    expect(branchPoints('main')).toHaveLength(first.chunks)
    expect(branchPoints('main').filter((p) => !before.has(p.id))).toEqual(touched)
  })

  it('drops the points of a deleted file', async () => {
    writeTree(tree)
    await embedProject(PROJECT, 'main', 'job-1')
    writeTree({ 'src/a.ts': tree['src/a.ts'] })
    const result = await embedProject(PROJECT, 'main', 'job-2')
    expect(result).toMatchObject({ embedded: 0, removed: 1 })
    expect(branchPoints('main').some((p) => p.payload['file_path'] === 'src/b.ts')).toBe(false)
  })

  it('reuses the vectors of another branch instead of asking the model', async () => {
    writeTree(tree)
    const main = await embedProject(PROJECT, 'main', 'job-1')

    embedCalls.texts = []
    const feature = await embedProject(PROJECT, 'feat/x', 'job-2')
    expect(feature).toMatchObject({ status: 'done', chunks: main.chunks, embedded: 0, reused: main.chunks })
    expect(embedCalls.texts).toEqual([])
    expect(branchPoints('main')).toHaveLength(main.chunks)
    expect(branchPoints('feat/x')).toHaveLength(main.chunks)
  })

  it('does not reuse vectors written by another embedding model', async () => {
    writeTree(tree)
    const first = await embedProject(PROJECT, 'main', 'job-1')

    routing.models = ['nomic-embed-text']
    embedCalls.texts = []
    const switched = await embedProject(PROJECT, 'main', 'job-2')
    expect(switched).toMatchObject({ embedded: first.chunks, reused: 0, removed: first.chunks })
    expect(branchPoints('main').every((p) => p.payload['embed_fp'] === 'nomic-embed-text@3')).toBe(true)
  })

  it('replaces points written before ids were derived', async () => {
    writeTree(tree)
    qdrant.points.set('legacy-1', {
      id: 'legacy-1',
      vector: [1, 2, 3],
      payload: { project_id: PROJECT, branch: 'main', file_path: 'src/b.ts', chunk_index: 0 },
    })
    const result = await embedProject(PROJECT, 'main', 'job-1')
    expect(result.removed).toBe(1)
    expect(qdrant.points.has('legacy-1')).toBe(false)
  })

  it('keeps the stale points when the model fails, so the branch is not left empty', async () => {
    writeTree(tree)
    await embedProject(PROJECT, 'main', 'job-1')
    const before = branchPoints('main').length

    writeTree({ ...tree, 'src/a.ts': big('three') })
    embedCalls.fail = true
    const failed = await embedProject(PROJECT, 'main', 'job-2')
    expect(failed.status).toBe('error')
    expect(failed.removed).toBe(0)
    expect(failed.errors[0]).toMatch(/src\/a\.ts#\d+: Error: model down/)
    expect(branchPoints('main')).toHaveLength(before)
  })
})
