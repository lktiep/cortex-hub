import { describe, expect, it } from 'vitest'
import type { ConductorTask } from '../api'
import type { PlanTask } from './model'
import { modelOptions, pinOptions, routeBodyFromForm, routeFormFrom } from './route-form'
import { worker } from './test-fixtures'

function task(over: Partial<PlanTask> = {}, row: Partial<ConductorTask> = {}): PlanTask {
  return {
    id: 't1', key: 'A', title: 'A', kind: 'work', approver: null, status: 'pending', state: 'ready',
    parentId: null, groupId: null, deps: [], externalDeps: 0, files: [], estimate: 1, priority: 0,
    primary: { executor: 'claude', model: 'opus', effort: 'high' }, route: null,
    waitReason: null, waitUntil: null, escalated: false, rejectCount: 0, failCount: 0, agent: null,
    reviews: [], row: { pinned_agent: 'w1', ...row } as ConductorTask, ...over,
  }
}

describe('routeBodyFromForm', () => {
  const f = routeFormFrom(task())
  it('sends only what changed against the baseline', () => {
    expect(f).toEqual({ executor: 'claude', model: 'opus', effort: 'high', pinnedAgent: 'w1' })
    expect(routeBodyFromForm(f, f)).toEqual({})
    expect(routeBodyFromForm({ ...f, executor: 'codex' }, f)).toEqual({ executor: 'codex' })
    expect(routeBodyFromForm({ ...f, executor: '' }, f)).toEqual({ executor: null })
    expect(routeBodyFromForm({ ...f, model: '' }, f)).toEqual({ model: null })
    expect(routeBodyFromForm({ ...f, effort: ' low ' }, f)).toEqual({ effort: 'low' })
    expect(routeBodyFromForm({ ...f, pinnedAgent: '' }, f)).toEqual({ pinnedAgent: null })
  })
  it('treats a null route as empty fields', () => {
    const n = task({ primary: null }, { pinned_agent: null })
    expect(routeFormFrom(n)).toEqual({ executor: '', model: '', effort: '', pinnedAgent: '' })
  })
  it('an untouched form is not a change even after the task was rerouted by the lead', () => {
    const baseline = routeFormFrom(task())
    const form = { ...baseline } // the user never touched it
    const refreshed = task({ primary: { executor: 'codex', model: 'gpt', effort: 'low' } }, { pinned_agent: 'w2' })
    expect(routeFormFrom(refreshed)).not.toEqual(baseline)
    expect(Object.keys(routeBodyFromForm(form, baseline))).toHaveLength(0)
  })
})

describe('modelOptions', () => {
  it('lists the models of the executor, once, without the wildcard', () => {
    const ws = [
      worker({ agentId: 'a', engines: [{ executor: 'claude', models: ['opus', '*'], defaultModel: null }, { executor: 'codex', models: ['gpt'], defaultModel: null }] }),
      worker({ agentId: 'b', engines: [{ executor: 'claude', models: ['opus', 'sonnet'], defaultModel: null }] }),
    ]
    expect(modelOptions(ws, 'claude')).toEqual(['opus', 'sonnet'])
    expect(modelOptions(ws, '')).toEqual([])
  })
})

describe('pinOptions', () => {
  const ws = [worker({ agentId: 'w1' }), worker({ agentId: 'w2' })]
  it('lists online workers', () => {
    expect(pinOptions(ws, '')).toEqual([{ value: 'w1', label: 'w1' }, { value: 'w2', label: 'w2' }])
    expect(pinOptions(ws, 'w2')).toHaveLength(2)
  })
  it('keeps an offline pin visible, labelled offline', () => {
    expect(pinOptions(ws, 'worker-7')).toEqual([
      { value: 'w1', label: 'w1' }, { value: 'w2', label: 'w2' }, { value: 'worker-7', label: 'worker-7 (offline)' },
    ])
  })
})
