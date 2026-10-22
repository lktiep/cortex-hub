import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

let testDb: InstanceType<typeof Database>

vi.mock('../db/client.js', () => ({
  get db() {
    return testDb
  },
}))

vi.mock('./intel.js', () => ({ getGitNexusRepos: vi.fn() }))

import { Hono } from 'hono'
import { statsRouter, searchScope } from './stats.js'

const app = new Hono()
app.route('/api/metrics', statsRouter)

const REWORD = 'rewording of a query'

function log(tool: string, params: Record<string, unknown> = {}) {
  testDb.prepare('INSERT INTO query_logs (agent_id, tool, params) VALUES (?, ?, ?)').run('key-1', tool, JSON.stringify(params))
}

async function hintsFor(search?: Record<string, string>): Promise<string[]> {
  const qs = new URLSearchParams({ currentTool: 'cortex_code_search', ...search })
  const res = await app.request(`/api/metrics/hints/key-1?${qs}`)
  expect(res.status).toBe(200)
  return ((await res.json()) as { hints: string[] }).hints
}

beforeEach(() => {
  testDb = new Database(':memory:')
  testDb.exec(readFileSync(join(__dirname, '../db/schema.sql'), 'utf-8'))
  log('cortex_session_start')
})

describe('reword hint', () => {
  it('flags the same question asked of the same repo again', async () => {
    log('cortex_code_search', { query: 'npc talk packet opcode', repo: 'server' })
    log('cortex_code_search', { query: 'talk npc opcode handler', repo: 'server' })
    expect((await hintsFor()).join()).toContain(REWORD)
  })

  it('does not flag the same question asked of another repo', async () => {
    log('cortex_code_search', { query: 'npc talk packet opcode', repo: 'server' })
    log('cortex_code_search', { query: 'talk npc opcode handler', repo: 'tools' })
    expect((await hintsFor()).join()).not.toContain(REWORD)
  })

  it('ignores searches from before the latest session start on the same key', async () => {
    log('cortex_code_search', { query: 'npc talk packet opcode' })
    log('cortex_session_start')
    log('cortex_code_search', { query: 'talk npc opcode handler' })
    expect((await hintsFor()).join()).not.toContain(REWORD)
  })

  it('judges the query hub-mcp sends when its log row has not landed yet', async () => {
    log('cortex_code_search', { query: 'npc talk packet opcode', repo: 'server' })
    expect((await hintsFor({ query: 'talk npc opcode handler', repo: 'server' })).join()).toContain(REWORD)
    expect((await hintsFor({ query: 'talk npc opcode handler', repo: 'tools' })).join()).not.toContain(REWORD)
  })

  it('does not count the sent query against its own log row', async () => {
    log('cortex_code_search', { query: 'npc talk packet opcode', repo: 'server' })
    expect((await hintsFor({ query: 'npc talk packet opcode', repo: 'server' })).join()).not.toContain(REWORD)
  })
})

describe('searchScope', () => {
  it('treats a repo name, its URL and "*" the way the search does', () => {
    expect(searchScope({ repo: 'https://example.com/org/Server.git' })).toBe(searchScope({ repo: 'server' }))
    expect(searchScope({ repo: '*' })).toBe(searchScope({}))
    expect(searchScope({ repo: 'server', branch: 'dev' })).not.toBe(searchScope({ repo: 'server' }))
  })
})
