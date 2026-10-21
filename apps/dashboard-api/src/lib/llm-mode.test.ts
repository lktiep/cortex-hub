import { beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from '../conductor/testing.js'

let testDb: Database.Database
vi.mock('../db/client.js', () => ({ get db() { return testDb } }))

import { llmEnabledFor, llmStatus, setLlmMode } from './llm-mode.js'
import { setupRouter } from '../routes/setup.js'

function routeChat(model: string | null) {
  testDb.prepare("DELETE FROM model_routing WHERE purpose = 'chat'").run()
  if (model) {
    testDb.prepare("INSERT INTO model_routing (purpose, chain) VALUES ('chat', ?)").run(JSON.stringify([{ accountId: 'pa-1', model }]))
  }
}

beforeEach(() => {
  testDb = createTestDb()
  routeChat('gpt-mini')
})

describe('llmStatus', () => {
  it('is on with a routed chat model and nothing turning it off', () => {
    expect(llmStatus({})).toEqual({
      enabled: true, reason: 'configured', setting: null, env: null, chatModel: 'gpt-mini',
      features: { memory: true, recipes: true, evolution: true },
    })
  })

  it('is off without a chat model, whatever was chosen', () => {
    routeChat(null)
    setLlmMode('on')
    expect(llmStatus({ CORTEX_LLM: 'on' })).toMatchObject({ enabled: false, reason: 'no-chat-model', chatModel: null })
  })

  it('follows the setting, and CORTEX_LLM over it', () => {
    setLlmMode('off')
    expect(llmStatus({})).toMatchObject({ enabled: false, reason: 'setting', setting: 'off' })
    expect(llmStatus({ CORTEX_LLM: 'on' })).toMatchObject({ enabled: true, reason: 'env', env: 'on' })
    setLlmMode('on')
    expect(llmStatus({ CORTEX_LLM: 'OFF' })).toMatchObject({ enabled: false, reason: 'env', setting: 'on' })
  })

  it('turns one feature off by its own switch', () => {
    expect(llmStatus({ MEMORY_LLM: 'off' }).features).toEqual({ memory: false, recipes: true, evolution: true })
    expect(llmEnabledFor('recipes', { RECIPE_CAPTURE: 'false' })).toBe(false)
    expect(llmEnabledFor('evolution', { RECIPE_CAPTURE: 'off' })).toBe(true)
  })
})

describe('/api/setup/llm', () => {
  it('reads and sets the mode', async () => {
    const put = (body: unknown) => setupRouter.request('/llm', { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })

    expect((await put({ mode: 'maybe' })).status).toBe(400)
    expect(await (await put({ mode: 'off' })).json()).toMatchObject({ enabled: false, setting: 'off' })
    expect(await (await setupRouter.request('/llm')).json()).toMatchObject({ enabled: false, reason: 'setting' })
  })

  it('keeps onboarding\'s choice when setup completes', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
    const res = await setupRouter.request('/complete', { method: 'POST', body: JSON.stringify({ llmMode: 'off' }), headers: { 'Content-Type': 'application/json' } })
    expect(res.status).toBe(200)
    expect(llmStatus({}).setting).toBe('off')
    vi.restoreAllMocks()
  })
})

describe('features without an LLM', () => {
  it('captures no recipe, rewrites no knowledge, and calls nothing', async () => {
    routeChat(null)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { captureFromTask, captureFromSession } = await import('../services/recipe-capture.js')
    const { runHealthCheck } = await import('../services/knowledge-evolution.js')

    await captureFromTask({ id: 't1', result: 'done', title: 'x' } as unknown as Parameters<typeof captureFromTask>[0])
    await captureFromSession({ sessionId: 's1', summary: 'a'.repeat(80), agentId: null, projectId: null })
    expect(await runHealthCheck()).toMatchObject({ checked: 0, disabled: expect.stringContaining('no LLM') })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM recipe_capture_log').get()).toEqual({ n: 0 })
    vi.restoreAllMocks()
  })
})
