import { describe, expect, it } from 'vitest'
import { observeConversation, openTaskConversation, showConversation, stopConversation, type AgentSdk } from './conversation.js'

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
      createCascade: async ({ text }) => {
        calls.push(`ls.createCascade:${text}`)
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
const opts = { focus: false, title: 'Cortex: Fix login' }

describe('openTaskConversation', () => {
  it('opens a new headless conversation through the language server and titles it', async () => {
    const { sdk, calls } = fakeSdk()
    expect(await openTaskConversation(sdk, 'P', opts, quiet)).toEqual({ mode: 'tracked', conversationId: 'c-new', via: 'ls.createCascade' })
    expect(calls).toEqual(['ls.createCascade:P', 'ls.setTitle:c-new:Cortex: Fix login'])
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
    expect(logged).toHaveLength(2)
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
      expect(calls[0]).toBe('ls.createCascade:P')
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
