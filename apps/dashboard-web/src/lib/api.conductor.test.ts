// Tests for the conductor tree, review and route clients in api.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getConductorAgents,
  getConductorTree,
  reviewConductorTask,
  routeConductorTask,
} from './api'

const fetchMock = vi.fn()

function reply(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }))
}

// The (url, init) of the first fetch call, typed for the assertions
function firstCall(): { url: string; init: { method: string; body: string; headers: Record<string, string> } } {
  const call = fetchMock.mock.calls[0] as [string, { method: string; body: string; headers: Record<string, string> }]
  return { url: String(call[0]), init: call[1] }
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('conductor api clients', () => {
  it('getConductorTree requests GET /api/conductor/:id/tree', async () => {
    const tree = { root: { id: 'abc' }, tasks: [{ id: 't1' }], workers: [{ agentId: 'w1' }] }
    reply(tree)
    await expect(getConductorTree('abc')).resolves.toEqual(tree)
    const { url, init } = firstCall()
    expect(url.endsWith('/api/conductor/abc/tree')).toBe(true)
    expect(init.method).toBe('GET')
  })

  it('reviewConductorTask posts the verdict and sends no X-API-Key-Owner header', async () => {
    reply({ task: { id: 'g1' } })
    await reviewConductorTask('g1', { verdict: 'reject', feedback: 'tighten copy', by: 'dashboard' })
    const { url, init } = firstCall()
    expect(url.endsWith('/api/conductor/g1/review')).toBe(true)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ verdict: 'reject', feedback: 'tighten copy', by: 'dashboard' })
    expect(Object.keys(init.headers).some((k) => /x-api-key-owner/i.test(k))).toBe(false)
  })

  it('routeConductorTask posts only the given fields', async () => {
    reply({ task: { id: 't1' } })
    await routeConductorTask('t1', { clearEscalation: true })
    const { url, init } = firstCall()
    expect(url.endsWith('/api/conductor/t1/route')).toBe(true)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ clearEscalation: true })
  })

  it("a 409 from review rejects with ApiError status 409 and the hub's error text", async () => {
    reply({ error: 'nothing to return: cancel the gate or reroute its dependencies' }, 409)
    await expect(reviewConductorTask('g1', { verdict: 'approve' })).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      message: 'nothing to return: cancel the gate or reroute its dependencies',
    })
  })

  it('a 400 from route exposes the cycle in ApiError.data', async () => {
    reply({ error: 'dependency cycle: A -> B -> A', cycle: ['A', 'B', 'A'] }, 400)
    const err = await routeConductorTask('A', { dependsOn: ['B'] }).catch((e: unknown) => e)
    expect(err).toMatchObject({ name: 'ApiError', status: 400 })
    expect((err as { data: { cycle: string[] } }).data.cycle).toEqual(['A', 'B', 'A'])
  })

  it('getConductorAgents passes sessions through', async () => {
    const body = {
      agents: [],
      online: 0,
      sessions: [
        { sessionId: 's1', agentId: 'a1', hostname: null, ide: null, branch: 'main', projectId: null, apiKeyName: null, lastActivity: '2026-10-16T00:00:00Z' },
      ],
    }
    reply(body)
    await expect(getConductorAgents()).resolves.toEqual(body)
  })
})
