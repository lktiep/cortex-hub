import { beforeAll, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { EngineInfo, RouteSpec } from '@cortex/shared-types'
import { createTestDb } from './testing.js'

let testDb: Database.Database
vi.mock('../db/client.js', () => ({ get db() { return testDb } }))

import {
  quotaModelMatches, routeChain, selectAssignments,
  type CandidateTask, type CandidateWorker, type QuotaRow, type SelectionInput,
} from './dispatcher.js'

beforeAll(() => { testDb = createTestDb() })

const NOW = '2026-10-16T12:00:00Z'
const T1 = '2026-10-16T13:00:00Z'
const T2 = '2026-10-16T14:00:00Z'
const PAST = '2026-10-16T11:00:00Z'

const CLAUDE: EngineInfo = { executor: 'claude', models: ['opus', 'sonnet'], defaultModel: 'opus' }
const AGY: EngineInfo = { executor: 'agy', models: ['gemini-4-argon-low', 'gemini-4-argon-high'], defaultModel: 'gemini-4-argon-low' }

function route(executor: RouteSpec['executor'], model: string | null): RouteSpec {
  return { executor, model, effort: null }
}

function task(id: string, over: Partial<CandidateTask> = {}): CandidateTask {
  return {
    id, projectId: null, priority: 5, createdAt: '2026-10-16T10:00:00Z',
    dependsOn: [], requiredCapabilities: [], files: [],
    routes: [route('claude', 'opus')], pinnedAgent: null, declined: [], lastAgent: null,
    ...over,
  }
}

function worker(agentId: string, over: Partial<CandidateWorker> = {}): CandidateWorker {
  return {
    agentId, host: `host-${agentId}`, projectId: null, protocol: 2,
    capabilities: [], engines: [CLAUDE], busy: false, idleSince: 0,
    ...over,
  }
}

function quota(host: string, executor: string, model: string, exhaustedUntil: string): QuotaRow {
  return { host, executor, model, exhaustedUntil }
}

function select(over: Partial<SelectionInput>) {
  return selectAssignments({
    pending: [], completedIds: new Set(), lockedFiles: [], workers: [], quota: [], now: NOW,
    ...over,
  })
}

describe('selectAssignments', () => {
  it('skips tasks whose dependencies are not complete', () => {
    const r = select({
      pending: [task('a', { dependsOn: ['x', 'y'] }), task('b', { dependsOn: ['y'] })],
      completedIds: new Set(['y']),
      workers: [worker('w1'), worker('w2')],
    })
    expect(r.assign.map((a) => a.taskId)).toEqual(['b'])
    expect(r.wait).toEqual([{ taskId: 'b', reason: null, until: null }])
  })

  it('orders by priority then age', () => {
    const byPriority = select({
      pending: [task('p5', { priority: 5, createdAt: '2026-10-16T09:00:00Z' }), task('p1', { priority: 1 })],
      workers: [worker('w1')],
    })
    expect(byPriority.assign).toEqual([{ taskId: 'p1', agentId: 'w1', route: route('claude', 'opus') }])

    const byAge = select({
      pending: [task('young', { createdAt: '2026-10-16T11:00:00Z' }), task('old', { createdAt: '2026-10-16T09:00:00Z' })],
      workers: [worker('w1')],
    })
    expect(byAge.assign.map((a) => a.taskId)).toEqual(['old'])
  })

  it('one task per worker per pass', () => {
    const r = select({ pending: [task('a'), task('b')], workers: [worker('w1')] })
    expect(r.assign.map((a) => a.taskId)).toEqual(['a'])
    expect(r.wait).toEqual([
      { taskId: 'a', reason: null, until: null },
      { taskId: 'b', reason: null, until: null },
    ])
  })

  it('skips busy workers', () => {
    const r = select({ pending: [task('a')], workers: [worker('w1', { busy: true }), worker('w2')] })
    expect(r.assign).toEqual([{ taskId: 'a', agentId: 'w2', route: route('claude', 'opus') }])

    const none = select({ pending: [task('a')], workers: [worker('w1', { busy: true })] })
    expect(none.assign).toEqual([])
    expect(none.wait).toEqual([{ taskId: 'a', reason: null, until: null }])
  })

  it('file lock against active tasks and within the pass', () => {
    const locked = select({
      pending: [task('a', { files: ['src/a.ts'] })],
      lockedFiles: [['src/a.ts']],
      workers: [worker('w1')],
    })
    expect(locked.assign).toEqual([])
    expect(locked.wait).toEqual([{ taskId: 'a', reason: 'lock', until: null }])

    const inPass = select({
      pending: [task('first', { files: ['src/b/'] }), task('second', { files: ['src/b/'], createdAt: '2026-10-16T11:00:00Z' })],
      workers: [worker('w1'), worker('w2')],
    })
    expect(inPass.assign.map((a) => a.taskId)).toEqual(['first'])
    expect(inPass.wait).toEqual([
      { taskId: 'first', reason: null, until: null },
      { taskId: 'second', reason: 'lock', until: null },
    ])
  })

  it('falls back along the route chain', () => {
    const r = select({
      pending: [task('a', { routes: [route('agy', 'gemini-4-argon-low'), route('claude', 'opus')] })],
      workers: [worker('w1', { host: 'h1', engines: [AGY, CLAUDE] })],
      quota: [quota('h1', 'agy', 'gemini-4-argon-*', T1)],
    })
    expect(r.assign).toEqual([{ taskId: 'a', agentId: 'w1', route: route('claude', 'opus') }])
  })

  it('quota pattern match', () => {
    expect(quotaModelMatches('claude-sonnet-5-5-*', 'claude-sonnet-5-5-low')).toBe(true)
    expect(quotaModelMatches('*', 'x')).toBe(true)
    expect(quotaModelMatches('gemini-4-argon-low', 'gemini-4-argon-high')).toBe(false)
  })

  it('quota is per host', () => {
    const r = select({
      pending: [task('a', { routes: [route('agy', 'gemini-4-argon-low'), route('claude', 'opus')] })],
      workers: [
        worker('w1', { host: 'h1', engines: [AGY, CLAUDE], idleSince: 1 }),
        worker('w2', { host: 'h2', engines: [AGY], idleSince: 2 }),
      ],
      quota: [quota('h1', 'agy', 'gemini-4-argon-*', T1)],
    })
    expect(r.assign).toEqual([{ taskId: 'a', agentId: 'w2', route: route('agy', 'gemini-4-argon-low') }])
  })

  it('capacity wait names the earliest reset', () => {
    const r = select({
      pending: [task('a', { routes: [route('agy', 'gemini-4-argon-low'), route('claude', 'opus')] })],
      workers: [worker('w1', { host: 'h1', engines: [AGY, CLAUDE] })],
      quota: [
        quota('h1', 'agy', 'gemini-4-argon-*', T2),
        quota('h1', 'claude', 'opus', T1),
        quota('h1', 'agy', '*', PAST),
      ],
    })
    expect(r.assign).toEqual([])
    expect(r.wait).toEqual([{ taskId: 'a', reason: 'capacity', until: T1 }])
  })

  it('executor-null route is blocked only when every fitting engine is blocked', () => {
    const base = {
      pending: [task('a', { routes: [route(null, null)] })],
      workers: [worker('w1', { host: 'h1', engines: [CLAUDE, AGY] })],
    }
    const oneBlocked = select({ ...base, quota: [quota('h1', 'agy', 'gemini-4-argon-*', T2)] })
    expect(oneBlocked.assign).toEqual([{ taskId: 'a', agentId: 'w1', route: route(null, null) }])

    const bothBlocked = select({
      ...base,
      quota: [quota('h1', 'agy', 'gemini-4-argon-*', T2), quota('h1', 'claude', 'opus', T1)],
    })
    expect(bothBlocked.assign).toEqual([])
    expect(bothBlocked.wait).toEqual([{ taskId: 'a', reason: 'capacity', until: T1 }])
  })

  it('an engine without a default model is blocked on a model-null route only by * rows', () => {
    const base = {
      pending: [task('a', { routes: [route('claude', null)] })],
      workers: [worker('w1', { host: 'h1', engines: [{ ...CLAUDE, defaultModel: null }] })],
    }
    expect(select({ ...base, quota: [quota('h1', 'claude', 'opus', T1)] }).assign).toHaveLength(1)
    expect(select({ ...base, quota: [quota('h1', 'claude', '*', T1)] }).wait)
      .toEqual([{ taskId: 'a', reason: 'capacity', until: T1 }])
  })

  it('no_worker when no engine fits', () => {
    const r = select({
      pending: [task('a', { routes: [route('codex', null)] })],
      workers: [worker('w1'), worker('w2')],
    })
    expect(r.assign).toEqual([])
    expect(r.wait).toEqual([{ taskId: 'a', reason: 'no_worker', until: null }])
  })

  it('an engine must list the route model', () => {
    const opusOnly: EngineInfo = { executor: 'claude', models: ['opus'], defaultModel: 'opus' }
    const r = select({ pending: [task('a', { routes: [route('claude', 'haiku')] })], workers: [worker('w1', { engines: [opusOnly] })] })
    expect(r.assign).toEqual([])
    expect(r.wait).toEqual([{ taskId: 'a', reason: 'no_worker', until: null }])
  })

  it('an engine listing * fits any model', () => {
    const anyCodex: EngineInfo = { executor: 'codex', models: ['*'], defaultModel: null }
    const r = select({ pending: [task('a', { routes: [route('codex', 'x')] })], workers: [worker('w1', { engines: [anyCodex] })] })
    expect(r.assign).toEqual([{ taskId: 'a', agentId: 'w1', route: route('codex', 'x') }])
  })

  it('an executor-null route with a model counts only engines that list it for quota', () => {
    const r = select({
      pending: [task('a', { routes: [route(null, 'opus')] })],
      workers: [worker('w1', { host: 'h1', engines: [CLAUDE, AGY] })],
      quota: [quota('h1', 'claude', 'opus', T1)],
    })
    expect(r.assign).toEqual([])
    expect(r.wait).toEqual([{ taskId: 'a', reason: 'capacity', until: T1 }])
  })

  it('pins and declines', () => {
    const pinned = select({
      pending: [task('a', { pinnedAgent: 'w2' })],
      workers: [worker('w1', { idleSince: 1 }), worker('w2', { idleSince: 2 })],
    })
    expect(pinned.assign.map((a) => a.agentId)).toEqual(['w2'])

    const declined = select({ pending: [task('a', { declined: ['w1'] })], workers: [worker('w1')] })
    expect(declined.assign).toEqual([])
    expect(declined.wait).toEqual([{ taskId: 'a', reason: 'no_worker', until: null }])
  })

  it('matches workers to the task project', () => {
    const projectWorker = worker('w1', { projectId: 'p1' })
    expect(select({ pending: [task('a', { projectId: 'p1' })], workers: [projectWorker] }).assign).toHaveLength(1)
    expect(select({ pending: [task('a')], workers: [projectWorker] }).assign).toHaveLength(1)
    expect(select({ pending: [task('a', { projectId: 'p2' })], workers: [projectWorker] }).wait)
      .toEqual([{ taskId: 'a', reason: 'no_worker', until: null }])
    expect(select({ pending: [task('a', { projectId: 'p1' })], workers: [worker('w2')] }).wait)
      .toEqual([{ taskId: 'a', reason: 'no_worker', until: null }])
  })

  it('requires every capability', () => {
    const r = select({
      pending: [task('a', { requiredCapabilities: ['gpu', 'docker'] })],
      workers: [worker('w1', { capabilities: ['gpu'], idleSince: 1 }), worker('w2', { capabilities: ['docker', 'gpu'], idleSince: 2 })],
    })
    expect(r.assign.map((a) => a.agentId)).toEqual(['w2'])
  })

  it('prefers the last agent, then the longest idle', () => {
    const workers = [worker('w1', { idleSince: 100 }), worker('w2', { idleSince: 200 })]
    expect(select({ pending: [task('a', { lastAgent: 'w2' })], workers }).assign.map((a) => a.agentId)).toEqual(['w2'])
    expect(select({ pending: [task('a')], workers }).assign.map((a) => a.agentId)).toEqual(['w1'])
  })

  it('legacy worker takes only executor-null routes', () => {
    const legacy = worker('old', { protocol: 1, engines: [] })
    const free = select({ pending: [task('a', { projectId: 'p1', routes: [route(null, null)] })], workers: [legacy] })
    expect(free.assign).toEqual([{ taskId: 'a', agentId: 'old', route: route(null, null) }])

    const typed = select({ pending: [task('b', { routes: [route('claude', null)] })], workers: [legacy] })
    expect(typed.assign).toEqual([])
    expect(typed.wait).toEqual([{ taskId: 'b', reason: 'no_worker', until: null }])
  })
})

describe('routeChain', () => {
  const primary = route('agy', 'gemini-4-argon-low')
  const defaults = [route('claude', 'opus')]

  it('uses the default fallback when the task has none', () => {
    expect(routeChain(primary, null, defaults)).toEqual([primary, route('claude', 'opus')])
  })

  it('an empty fallback means the primary only', () => {
    expect(routeChain(primary, [], defaults)).toEqual([primary])
  })

  it('drops duplicates', () => {
    const chain = routeChain(route('claude', 'opus'), [route('claude', 'opus'), route('agy', null), route('agy', null)], defaults)
    expect(chain).toEqual([route('claude', 'opus'), route('agy', null)])
  })

  it('keeps routes that differ only in effort', () => {
    const high: RouteSpec = { executor: 'claude', model: 'opus', effort: 'high' }
    const low: RouteSpec = { executor: 'claude', model: 'opus', effort: 'low' }
    expect(routeChain(high, [low], defaults)).toEqual([high, low])
  })
})
