import { describe, expect, it } from 'vitest'
import type { ConductorTask } from '../api'
import type { PlanTask } from './model'
import { actionErrorMessage, availableActions } from './actions'

function task(over: Partial<PlanTask> = {}, row: Partial<ConductorTask> = {}): PlanTask {
  return {
    id: 't1', key: 'A', title: 'A', kind: 'work', approver: null, status: 'pending', state: 'ready',
    parentId: null, groupId: null, deps: [], externalDeps: 0, files: [], estimate: 1, priority: 0,
    primary: { executor: 'claude', model: 'opus', effort: 'high' }, route: null,
    waitReason: null, waitUntil: null, escalated: false, rejectCount: 0, failCount: 0, agent: null,
    reviews: [], row: { pinned_agent: 'w1', ...row } as ConductorTask, ...over,
  }
}

describe('availableActions', () => {
  it('a review task can be approved or rejected; a done task cannot', () => {
    expect(availableActions(task({ state: 'review' })).review).toBe(true)
    expect(availableActions(task({ state: 'done' })).review).toBe(false)
  })
  it('a user gate awaiting approval can be reviewed; a lead gate is read-only on the dashboard', () => {
    expect(availableActions(task({ kind: 'gate', state: 'needs_user' })).review).toBe(true)
    expect(availableActions(task({ kind: 'gate', state: 'gate_lead' })).review).toBe(false)
  })
  it('clear escalation is offered only for escalated tasks', () => {
    expect(availableActions(task({ state: 'escalated' })).clearEscalation).toBe(true)
    expect(availableActions(task({ state: 'ready' })).clearEscalation).toBe(false)
  })
  it('route editing is offered for unfinished work tasks only', () => {
    expect(availableActions(task()).route).toBe(true)
    expect(availableActions(task({ kind: 'gate', state: 'needs_user' })).route).toBe(false)
    expect(availableActions(task({ kind: 'group' })).route).toBe(false)
    expect(availableActions(task({ state: 'done' })).route).toBe(false)
    expect(availableActions(task({ state: 'stopped' })).route).toBe(false)
  })
})

describe('actionErrorMessage', () => {
  it('maps 409, 403 and a 400 cycle', () => {
    expect(actionErrorMessage({ status: 409, message: 'x' })).toBe('x — the view has been refreshed.')
    expect(actionErrorMessage({ status: 403, message: 'Not your task' })).toBe('Not your task')
    expect(actionErrorMessage({ status: 400, message: 'bad', data: { cycle: ['A', 'B', 'A'] } }))
      .toBe('That change would create a cycle: A → B → A')
    expect(actionErrorMessage(new Error('boom'))).toBe('boom')
  })
  it("a 409 shows the hub's reason", () => {
    expect(actionErrorMessage({ status: 409, message: 'nothing to return: cancel the gate or reroute its dependencies' }))
      .toBe('nothing to return: cancel the gate or reroute its dependencies — the view has been refreshed.')
  })
  it('a 409 without a hub message (empty or api.ts synthesised) keeps the generic sentence', () => {
    const generic = 'This task changed state on the hub — the view has been refreshed.'
    expect(actionErrorMessage({ status: 409, message: '' })).toBe(generic)
    expect(actionErrorMessage({ status: 409 })).toBe(generic)
    expect(actionErrorMessage({ status: 409, message: 'API error: 409' })).toBe(generic)
  })
})
