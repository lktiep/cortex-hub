import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TASK_MODEL, TASK_MODELS, observeConversation, openTaskConversation, showConversation, stopConversation, taskModelFor,
  type AgentSdk, type ModelTable,
} from './conversation.js'

interface FakeOptions {
  lsReady?: boolean
  cascadeId?: string | null | Error
  sessionId?: string | Error
  sessions?: Array<{ id: string; stepCount: number }> | Error
}

/** An SDK that records every call. Nothing here can send into an existing chat: it has no such method. */
function fakeSdk(o: FakeOptions = {}): { sdk: AgentSdk; calls: string[] } {
  const calls: string[] = []
  const answer = <T>(v: T | Error): Promise<T> => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v))
  const sdk: AgentSdk = {
    ls: {
      isReady: o.lsReady ?? true,
      createCascade: async ({ text, model }) => {
        calls.push(`ls.createCascade:${text}:model=${model}`)
        return answer(o.cascadeId === undefined ? 'c-new' : o.cascadeId)
      },
      focusCascade: async (id) => { calls.push(`ls.focusCascade:${id}`) },
      cancelCascade: async (id) => { calls.push(`ls.cancelCascade:${id}`) },
      setTitle: async (id, title) => { calls.push(`ls.setTitle:${id}:${title}`) },
    },
    cascade: {
      refreshSessions: async () => {
        calls.push('cascade.refreshSessions')
        return answer(o.sessions ?? [])
      },
      createSession: async ({ task, background }) => {
        calls.push(`cascade.createSession:${task}:background=${background}`)
        return answer(o.sessionId ?? 's-new')
      },
      focusSession: async (id) => { calls.push(`cascade.focusSession:${id}`) },
    },
  }
  return { sdk, calls }
}

const quiet = () => {}
/** Stand-in ids, so a test can tell which entry was picked; the real ones come from the SDK's Models. */
const models: ModelTable = { GEMINI_FLASH: 11, GEMINI_PRO_LOW: 12, GEMINI_PRO_HIGH: 13, CLAUDE_SONNET: 14, CLAUDE_OPUS: 15, GPT_OSS: 16 }
const opts = { focus: false, title: 'Cortex: Fix login', model: taskModelFor('claude-opus', models) }

describe('taskModelFor', () => {
  it('maps each setting value to its entry in the SDK\'s Models', () => {
    expect(taskModelFor('gemini-pro-high', models)).toEqual({ name: 'gemini-pro-high', id: 13 })
    expect(taskModelFor('gemini-pro-low', models)).toEqual({ name: 'gemini-pro-low', id: 12 })
    expect(taskModelFor('gemini-flash', models)).toEqual({ name: 'gemini-flash', id: 11 })
    expect(taskModelFor('claude-sonnet', models)).toEqual({ name: 'claude-sonnet', id: 14 })
    expect(taskModelFor('claude-opus', models)).toEqual({ name: 'claude-opus', id: 15 })
    expect(taskModelFor('gpt-oss', models)).toEqual({ name: 'gpt-oss', id: 16 })
  })

  it('a missing or unknown value gets Gemini Pro High, not the SDK\'s Flash default', () => {
    for (const setting of [undefined, null, '', 'GEMINI_PRO_HIGH', 'gpt-5', 1165]) {
      expect(taskModelFor(setting, models)).toEqual({ name: 'gemini-pro-high', id: 13 })
    }
  })

  it('package.json offers the same choices and default', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
      contributes: { configuration: { properties: Record<string, { enum?: string[]; default?: unknown }> } }
    }
    const setting = pkg.contributes.configuration.properties['cortexHub.taskModel']
    expect(setting?.enum).toEqual([...TASK_MODELS])
    expect(setting?.default).toBe(DEFAULT_TASK_MODEL)
  })
})

describe('openTaskConversation', () => {
  it('opens a new headless conversation through the language server and titles it', async () => {
    const { sdk, calls } = fakeSdk()
    expect(await openTaskConversation(sdk, 'P', opts, quiet)).toEqual({ mode: 'tracked', conversationId: 'c-new', via: 'ls.createCascade' })
    expect(calls).toEqual(['ls.createCascade:P:model=15', 'ls.setTitle:c-new:Cortex: Fix login'])
  })

  it('opens it with the chosen model and logs which one', async () => {
    const { sdk, calls } = fakeSdk()
    const logged: string[] = []
    await openTaskConversation(sdk, 'P', { ...opts, model: taskModelFor(undefined, models) }, (m) => logged.push(m))
    expect(calls[0]).toBe('ls.createCascade:P:model=13')
    expect(logged).toContain('Opened conversation c-new with gemini-pro-high (model 13)')
  })

  it('a model createCascade refuses still falls back to createSession, on the IDE\'s model', async () => {
    for (const cascadeId of [new Error('unknown model'), null]) {
      const { sdk, calls } = fakeSdk({ cascadeId })
      const logged: string[] = []
      expect(await openTaskConversation(sdk, 'P', opts, (m) => logged.push(m))).toEqual({ mode: 'tracked', conversationId: 's-new', via: 'cascade.createSession' })
      expect(calls).toEqual(['ls.createCascade:P:model=15', 'cascade.refreshSessions', 'cascade.createSession:P:background=true'])
      expect(logged.join('\n')).toContain('ls.createCascade with claude-opus')
      expect(logged.join('\n')).toContain('model selected in the IDE')
    }
  })

  it('shows it only when focusOnAssign is on', async () => {
    const { sdk, calls } = fakeSdk()
    await openTaskConversation(sdk, 'P', { ...opts, focus: true }, quiet)
    expect(calls).toContain('ls.focusCascade:c-new')
  })

  it('a failed title or focus does not lose the conversation', async () => {
    const { sdk } = fakeSdk()
    sdk.ls.setTitle = async () => { throw new Error('no annotations') }
    sdk.ls.focusCascade = async () => { throw new Error('no focus') }
    const logged: string[] = []
    const opened = await openTaskConversation(sdk, 'P', { ...opts, focus: true }, (m) => logged.push(m))
    expect(opened).toMatchObject({ mode: 'tracked', conversationId: 'c-new' })
    expect(logged.filter((m) => m.startsWith('Could not'))).toHaveLength(2)
  })

  it('falls back to createSession, after refreshing its cache, when the language server is not ready', async () => {
    const { sdk, calls } = fakeSdk({ lsReady: false })
    expect(await openTaskConversation(sdk, 'P', opts, quiet)).toEqual({ mode: 'tracked', conversationId: 's-new', via: 'cascade.createSession' })
    expect(calls).toEqual(['cascade.refreshSessions', 'cascade.createSession:P:background=true'])
  })

  it('falls back when createCascade returns no id or throws', async () => {
    for (const cascadeId of [null, new Error('rpc refused')]) {
      const { sdk, calls } = fakeSdk({ cascadeId })
      expect(await openTaskConversation(sdk, 'P', opts, quiet)).toMatchObject({ mode: 'tracked', conversationId: 's-new' })
      expect(calls[0]).toBe('ls.createCascade:P:model=15')
      expect(calls).toContain('cascade.createSession:P:background=true')
    }
  })

  it('a new conversation whose id was not detected is untracked, not attached to another one', async () => {
    const { sdk } = fakeSdk({ lsReady: false, sessionId: '' })
    expect(await openTaskConversation(sdk, 'P', opts, quiet)).toEqual({ mode: 'untracked', via: 'cascade.createSession' })
  })

  it('when nothing can open a conversation it says why, for the manual fallback', async () => {
    const { sdk } = fakeSdk({ cascadeId: new Error('rpc refused'), sessionId: new Error('command not found') })
    const opened = await openTaskConversation(sdk, 'P', opts, quiet)
    expect(opened.mode).toBe('none')
    expect(opened).toMatchObject({ why: expect.stringContaining('rpc refused') })
    expect(opened).toMatchObject({ why: expect.stringContaining('command not found') })
  })
})

describe('observeConversation', () => {
  it('reads its own conversation from a fresh list, never the first entry', async () => {
    const sessions = [{ id: 'old-chat', stepCount: 1094 }, { id: 'c-new', stepCount: 7 }]
    const { sdk, calls } = fakeSdk({ sessions })
    expect(await observeConversation(sdk, 'c-new')).toEqual({ kind: 'steps', count: 7 })
    expect(calls).toEqual(['cascade.refreshSessions'])
  })

  it('missing from the list, or a failed poll, is not a step count', async () => {
    expect(await observeConversation(fakeSdk({ sessions: [{ id: 'old-chat', stepCount: 1094 }] }).sdk, 'c-new')).toEqual({ kind: 'missing' })
    expect(await observeConversation(fakeSdk({ sessions: new Error('diagnostics failed') }).sdk, 'c-new')).toEqual({ kind: 'unknown' })
  })
})

describe('show and stop', () => {
  it('use the language server when it is ready, the command bridge otherwise', async () => {
    const ready = fakeSdk()
    await showConversation(ready.sdk, 'c1')
    await stopConversation(ready.sdk, 'c1')
    expect(ready.calls).toEqual(['ls.focusCascade:c1', 'ls.cancelCascade:c1'])

    const notReady = fakeSdk({ lsReady: false })
    await showConversation(notReady.sdk, 'c1')
    await stopConversation(notReady.sdk, 'c1')
    expect(notReady.calls).toEqual(['cascade.focusSession:c1'])
  })
})
