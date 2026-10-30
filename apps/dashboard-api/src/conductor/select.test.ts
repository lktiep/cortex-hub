import { beforeAll, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { EngineInfo, RouteSpec } from '@cortex/shared-types'
import { routeKey } from './rows.js'
import { createTestDb } from './testing.js'

let testDb: Database.Database
vi.mock('../db/client.js', () => ({ get db() { return testDb } }))

import {
  quotaModelMatches, routeChain, routeOrder, selectAssignments, servesProject,
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
    routes: [route('claude', 'opus')], pinnedAgent: null, declined: [], lastAgent: null, inPlan: false,
    ...over,
  }
}

function worker(agentId: string, over: Partial<CandidateWorker> = {}): CandidateWorker {
  return {
    agentId, host: `host-${agentId}`, projectId: null, protocol: 2,
    capabilities: [], engines: [CLAUDE], defaultExecutor: null, busy: false, idleSince: 0,
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

  describe('after a route failed', () => {
    const AGY_LOW = route('agy', 'gemini-4-argon-low')
    const OPUS = route('claude', 'opus')
    const chain = { routes: [AGY_LOW, OPUS], failedRoutes: [routeKey(AGY_LOW)] }

    it('gives the task to its fallback when the fallback has an idle worker', () => {
      const r = select({
        pending: [task('a', chain)],
        workers: [worker('agy', { engines: [AGY], idleSince: 1 }), worker('cl', { engines: [CLAUDE], idleSince: 2 })],
      })
      expect(r.assign).toEqual([{ taskId: 'a', agentId: 'cl', route: OPUS }])
    })

    it('waits for a busy fallback rather than retry the route that failed', () => {
      const r = select({
        pending: [task('a', chain)],
        workers: [worker('agy', { engines: [AGY] }), worker('cl', { engines: [CLAUDE], busy: true })],
      })
      expect(r.assign).toEqual([])
      expect(r.wait).toEqual([{ taskId: 'a', reason: null, until: null }])
    })

    it('retries the failed route when no other route can run: no worker for it, or out of quota', () => {
      const alone = select({ pending: [task('a', chain)], workers: [worker('agy', { host: 'h1', engines: [AGY] })] })
      expect(alone.assign).toEqual([{ taskId: 'a', agentId: 'agy', route: AGY_LOW }])

      const outOfQuota = select({
        pending: [task('a', chain)],
        workers: [worker('agy', { host: 'h1', engines: [AGY] }), worker('cl', { host: 'h2', engines: [CLAUDE] })],
        quota: [quota('h2', 'claude', 'opus', T1)],
      })
      expect(outOfQuota.assign).toEqual([{ taskId: 'a', agentId: 'agy', route: AGY_LOW }])
    })

    it('one worker with both engines runs the fallback route', () => {
      const r = select({ pending: [task('a', chain)], workers: [worker('w1', { engines: [AGY, CLAUDE] })] })
      expect(r.assign).toEqual([{ taskId: 'a', agentId: 'w1', route: OPUS }])
    })
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

  // The A2 worker runs `route.executor ?? defaultExecutor`, and an agy engine reports no default
  // model, so a quota on a model-null route arrives as (host, agy, '*') (review C-1).
  describe('a route without an executor runs on the worker\'s default executor', () => {
    const AGY_NO_DEFAULT: EngineInfo = { ...AGY, defaultModel: null }
    const both = worker('w1', { host: 'h1', engines: [AGY_NO_DEFAULT, CLAUDE], defaultExecutor: 'agy' })
    const agyOnly = worker('w1', { host: 'h1', engines: [AGY_NO_DEFAULT], defaultExecutor: 'agy' })
    const starAgy = [quota('h1', 'agy', '*', T1)]

    it('scenario C: a * row on the default engine blocks the route, though another engine is free', () => {
      const alone = select({ pending: [task('a', { routes: [route(null, null)] })], workers: [both], quota: starAgy })
      expect(alone.assign).toEqual([])
      expect(alone.wait).toEqual([{ taskId: 'a', reason: 'capacity', until: T1 }])

      const chained = select({
        pending: [task('a', { routes: [route(null, null), route('claude', 'opus')] })], workers: [both], quota: starAgy,
      })
      expect(chained.assign).toEqual([{ taskId: 'a', agentId: 'w1', route: route('claude', 'opus') }])
    })

    it('scenarios A and D: a * row skips an agy route without a model, and an unrouted task, on that host', () => {
      for (const r of [route('agy', null), route(null, null)]) {
        const blocked = select({ pending: [task('a', { routes: [r] })], workers: [agyOnly], quota: starAgy })
        expect(blocked.assign, JSON.stringify(r)).toEqual([])
        expect(blocked.wait, JSON.stringify(r)).toEqual([{ taskId: 'a', reason: 'capacity', until: T1 }])

        const elsewhere = worker('w2', { host: 'h2', engines: [AGY_NO_DEFAULT], defaultExecutor: 'agy' })
        const moved = select({ pending: [task('a', { routes: [r] })], workers: [agyOnly, elsewhere], quota: starAgy })
        expect(moved.assign, JSON.stringify(r)).toEqual([{ taskId: 'a', agentId: 'w2', route: r }])
      }
    })

    it('a model the default engine does not list does not fit, whatever the other engines list', () => {
      const r = select({ pending: [task('a', { routes: [route(null, 'opus')] })], workers: [both] })
      expect(r.assign).toEqual([])
      expect(r.wait).toEqual([{ taskId: 'a', reason: 'no_worker', until: null }])

      const listed = select({ pending: [task('a', { routes: [route(null, 'gemini-4-argon-low')] })], workers: [both] })
      expect(listed.assign).toEqual([{ taskId: 'a', agentId: 'w1', route: route(null, 'gemini-4-argon-low') }])
    })

    it('a quota on another engine does not block the default engine', () => {
      const r = select({
        pending: [task('a', { routes: [route(null, null)] })], workers: [both], quota: [quota('h1', 'claude', '*', T1)],
      })
      expect(r.assign).toEqual([{ taskId: 'a', agentId: 'w1', route: route(null, null) }])
    })

    it('a worker without a default executor still counts every engine', () => {
      const r = select({
        pending: [task('a', { routes: [route(null, null)] })],
        workers: [{ ...both, defaultExecutor: null }],
        quota: starAgy,
      })
      expect(r.assign).toEqual([{ taskId: 'a', agentId: 'w1', route: route(null, null) }])
    })

    it('an unrouted task still fits a worker whose default executor has no engine', () => {
      const r = select({
        pending: [task('a', { routes: [route(null, null)] })],
        workers: [worker('w1', { engines: [], defaultExecutor: 'agy' })],
      })
      expect(r.assign).toEqual([{ taskId: 'a', agentId: 'w1', route: route(null, null) }])
    })
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

  it('a legacy worker on a project-scoped key serves only its project and project-less tasks', () => {
    const scoped = worker('old', { protocol: 1, engines: [], projectId: 'p1' })
    const free = (projectId: string | null) => task('a', { projectId, routes: [route(null, null)] })
    expect(select({ pending: [free('p1')], workers: [scoped] }).assign).toHaveLength(1)
    expect(select({ pending: [free(null)], workers: [scoped] }).assign).toHaveLength(1)
    expect(select({ pending: [free('p2')], workers: [scoped] }).wait).toEqual([{ taskId: 'a', reason: 'no_worker', until: null }])
  })

  it('a legacy worker is never given a plan task, even one pinned to it; a v2 worker is', () => {
    const legacy = worker('ide', { protocol: 1, engines: [] })
    const free = route(null, null)
    const planned = select({ pending: [task('a', { inPlan: true, routes: [free] })], workers: [legacy] })
    expect(planned.assign).toEqual([])
    expect(planned.wait).toEqual([{ taskId: 'a', reason: 'no_worker', until: null }])

    const pinned = select({ pending: [task('a', { inPlan: true, routes: [free], pinnedAgent: 'ide' })], workers: [legacy] })
    expect(pinned.wait).toEqual([{ taskId: 'a', reason: 'no_worker', until: null }])

    const both = select({ pending: [task('a', { inPlan: true, routes: [free] })], workers: [legacy, worker('cli')] })
    expect(both.assign).toEqual([{ taskId: 'a', agentId: 'cli', route: free }])

    const loose = select({ pending: [task('a', { routes: [free], pinnedAgent: 'ide' })], workers: [legacy] })
    expect(loose.assign).toEqual([{ taskId: 'a', agentId: 'ide', route: free }])
  })
})

describe('servesProject', () => {
  it('an unscoped legacy worker serves any project; a scoped one or a v2 worker its own and project-less tasks', () => {
    expect(servesProject({ protocol: 1, projectId: null }, { projectId: 'p1' })).toBe(true)
    expect(servesProject({ protocol: 1, projectId: 'p1' }, { projectId: 'p2' })).toBe(false)
    expect(servesProject({ protocol: 1, projectId: 'p1' }, { projectId: null })).toBe(true)
    expect(servesProject({ protocol: 2, projectId: null }, { projectId: 'p1' })).toBe(false)
    expect(servesProject({ protocol: 2, projectId: null }, { projectId: null })).toBe(true)
    expect(servesProject({ protocol: 2, projectId: 'p1' }, { projectId: 'p1' })).toBe(true)
  })

  it('a worker on an org-bound key serves its organizations\' tasks and the project-less ones its key created', () => {
    const bound = { protocol: 1 as const, projectId: null, apiKeyOrgs: new Set(['org-a']), apiKeyOwner: 'key-a' }
    expect(servesProject(bound, { projectId: 'p1', orgId: 'org-a' })).toBe(true)
    expect(servesProject(bound, { projectId: 'p2', orgId: 'org-b' })).toBe(false)
    expect(servesProject(bound, { projectId: 'p3' })).toBe(false)
    expect(servesProject(bound, { projectId: null, apiKeyOwner: 'key-a' })).toBe(true)
    expect(servesProject(bound, { projectId: null, apiKeyOwner: 'key-b' })).toBe(false)
    expect(servesProject(bound, { projectId: null })).toBe(false)
  })
})

describe('routeOrder', () => {
  const a = route('agy', 'gemini-4-argon-low')
  const b = route('claude', 'opus')
  const c = route('claude', 'sonnet')
  const flags = (o: ReturnType<typeof routeOrder>) => o.map(({ route: r, failed }) => `${r.model}${failed ? '!' : ''}`)

  it('keeps the chain when nothing failed', () => {
    expect(flags(routeOrder([a, b, c], []))).toEqual(['gemini-4-argon-low', 'opus', 'sonnet'])
  })

  it('moves failed routes last, the longest-ago failure first, and ignores keys not in the chain', () => {
    const order = routeOrder([a, b, c], [routeKey(b), routeKey(route('codex', null)), routeKey(a)])
    expect(flags(order)).toEqual(['sonnet', 'opus!', 'gemini-4-argon-low!'])
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
