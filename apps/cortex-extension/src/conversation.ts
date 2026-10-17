import type { AntigravitySDK } from 'antigravity-sdk'
import type { Observation } from './task-tracker.js'

/**
 * The part of antigravity-sdk (1.7.0) this extension uses, all of it public and typed in the
 * package's index.d.ts. asAgentSdk() checks at compile time that the real SDK still fits.
 */
export interface AgentSdk {
  ls: {
    /** The language-server bridge found its port; createCascade throws until it has. */
    readonly isReady: boolean
    /** StartCascade plus the first message: a new, headless conversation. Null when no id came back. */
    createCascade(options: { text: string }): Promise<string | null>
    focusCascade(cascadeId: string): Promise<void>
    cancelCascade(cascadeId: string): Promise<void>
    setTitle(cascadeId: string, title: string): Promise<void>
  }
  cascade: {
    /** Reloads the recent-conversation list. getSessions() only ever returns the list it loaded first. */
    refreshSessions(): Promise<ReadonlyArray<{ readonly id: string; readonly stepCount: number }>>
    /** The command fallback: startNewConversation, then the prompt. The new id, or '' when not detected. */
    createSession(options: { task: string; background?: boolean }): Promise<string>
    focusSession(sessionId: string): Promise<void>
  }
}

/** A type error here means the SDK's typings moved away from AgentSdk. */
export function asAgentSdk(sdk: AntigravitySDK): AgentSdk {
  return sdk
}

export type OpenedConversation =
  | { mode: 'tracked'; conversationId: string; via: 'ls.createCascade' | 'cascade.createSession' }
  /** The prompt went to a new conversation, but its id was not detected. */
  | { mode: 'untracked'; via: 'cascade.createSession' }
  /** No new conversation was opened; `why` says what failed. */
  | { mode: 'none'; why: string }

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Opens a NEW agent conversation for one task and sends it the prompt: the language server's
 * createCascade first, then the SDK's command fallback createSession. It never sends into the chat
 * that happens to be open (cascade.sendPrompt / sendMessage): that conversation is someone else's,
 * and its steps would be taken for the task's.
 */
export async function openTaskConversation(
  sdk: AgentSdk,
  prompt: string,
  options: { focus: boolean; title: string },
  log: (msg: string) => void,
): Promise<OpenedConversation> {
  const problems: string[] = []

  if (sdk.ls.isReady) {
    try {
      const id = await sdk.ls.createCascade({ text: prompt })
      if (id) {
        // A headless conversation is easy to miss in the list; the title says which task it is.
        await sdk.ls.setTitle(id, options.title).catch((e: unknown) => log(`Could not title conversation ${id}: ${messageOf(e)}`))
        if (options.focus) await sdk.ls.focusCascade(id).catch((e: unknown) => log(`Could not show conversation ${id}: ${messageOf(e)}`))
        return { mode: 'tracked', conversationId: id, via: 'ls.createCascade' }
      }
      problems.push('ls.createCascade returned no conversation id')
    } catch (e) {
      problems.push(`ls.createCascade failed: ${messageOf(e)}`)
    }
  } else {
    problems.push('the language-server bridge is not ready')
  }

  try {
    // createSession tells its new conversation from the ones it has cached, so load them first.
    await sdk.cascade.refreshSessions().catch(() => [])
    const id = await sdk.cascade.createSession({ task: prompt, background: !options.focus })
    log(`ls.createCascade unavailable (${problems.join('; ')}); used cascade.createSession`)
    return id ? { mode: 'tracked', conversationId: id, via: 'cascade.createSession' } : { mode: 'untracked', via: 'cascade.createSession' }
  } catch (e) {
    problems.push(`cascade.createSession failed: ${messageOf(e)}`)
  }
  return { mode: 'none', why: problems.join('; ') }
}

/** The task's own conversation in a fresh session list, found by its id. Never "the latest" one. */
export async function observeConversation(sdk: AgentSdk, conversationId: string): Promise<Observation> {
  try {
    const sessions = await sdk.cascade.refreshSessions()
    const own = sessions.find((s) => s.id === conversationId)
    return own ? { kind: 'steps', count: own.stepCount } : { kind: 'missing' }
  } catch {
    return { kind: 'unknown' }
  }
}

/** Brings the task's conversation into view. */
export async function showConversation(sdk: AgentSdk, conversationId: string): Promise<void> {
  if (sdk.ls.isReady) await sdk.ls.focusCascade(conversationId)
  else await sdk.cascade.focusSession(conversationId)
}

/** Stops the agent in the task's conversation; the conversation and its history stay. */
export async function stopConversation(sdk: AgentSdk, conversationId: string): Promise<void> {
  if (sdk.ls.isReady) await sdk.ls.cancelCascade(conversationId)
}
