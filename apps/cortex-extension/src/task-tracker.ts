/**
 * When a task this window runs is over, and what to tell the hub and the user until then.
 * Pure: no vscode, no SDK and no clock of its own, so every rule is unit-tested
 * (task-tracker.test.ts) and extension.ts only carries the decisions out.
 *
 * The rule this module exists for: silence is not completion. A task ends because the hub says so
 * (the agent called cortex_task_update, or a lead completed, cancelled or moved it), because the
 * user pressed Mark done / Mark failed / Release task, or because the hard timeout ran out, which
 * reports `failed`. The task's own conversation going quiet earns a needs-attention notice and
 * nothing more: a quiet agent may be finished, or waiting for an approval nobody has seen.
 */

/**
 * How the task's conversation is followed.
 * - `tracked`: a new conversation whose id is known; its step count is polled.
 * - `untracked`: sent to a new conversation, but the IDE did not report its id.
 * - `manual`: no agent API in this window; the prompt went to the clipboard for the user.
 */
export type TrackingMode = 'tracked' | 'untracked' | 'manual'

export interface TrackerTimings {
  /** No new step in the task's conversation for this long: it needs attention. */
  quietMs: number
  /** No result this long after the task started: it is reported failed. */
  timeoutMs: number
  /** At most one "working" progress report per this period. */
  progressEveryMs: number
}

export const DEFAULT_TIMINGS: TrackerTimings = {
  quietMs: 5 * 60_000,
  timeoutMs: 60 * 60_000,
  progressEveryMs: 60_000,
}

/** The hard timeout from the `cortexHub.taskTimeoutMinutes` setting; anything unusable keeps the default. */
export function timingsFor(timeoutMinutes: unknown): TrackerTimings {
  const minutes = typeof timeoutMinutes === 'number' && Number.isFinite(timeoutMinutes) && timeoutMinutes >= 1 ? timeoutMinutes : 60
  return { ...DEFAULT_TIMINGS, timeoutMs: minutes * 60_000 }
}

export interface TaskTracking {
  readonly taskId: string
  readonly title: string
  /** The hub's attempt number, echoed on the outcome so a late report cannot settle a newer attempt. */
  readonly attempt?: number
  readonly mode: TrackingMode
  /** The conversation opened for this task; set in `tracked` mode only. */
  readonly conversationId?: string
  readonly startedAt: number
  /** When the task's conversation last gained a step; the start until then. */
  readonly lastActivityAt: number
  /** The step count last seen in the task's conversation; undefined until it is seen. */
  readonly steps?: number
  /** When a progress report last went to the hub. */
  readonly lastReportAt?: number
  /** A needs-attention notice already went out for the current quiet spell. */
  readonly attentionSent: boolean
}

export interface TrackingStart {
  taskId: string
  title: string
  attempt?: number
  mode: TrackingMode
  conversationId?: string
}

export function startTracking(start: TrackingStart, now: number): TaskTracking {
  return {
    taskId: start.taskId,
    title: start.title,
    attempt: start.attempt,
    mode: start.mode,
    conversationId: start.mode === 'tracked' ? start.conversationId : undefined,
    startedAt: now,
    lastActivityAt: now,
    attentionSent: false,
  }
}

/** The same run of the same task: a button or poll left over from an earlier run must not touch this one. */
export function sameRun(a: TaskTracking | null, b: TaskTracking | null): boolean {
  return a !== null && b !== null && a.taskId === b.taskId && a.attempt === b.attempt && a.startedAt === b.startedAt
}

/** What one poll saw of the task's own conversation, never of any other. */
export type Observation =
  /** Found by its id in the IDE's session list. */
  | { kind: 'steps'; count: number }
  /** Its id is not in the list (the list holds recent conversations only). */
  | { kind: 'missing' }
  /** Nothing to look at (untracked or manual), or the poll failed. */
  | { kind: 'unknown' }

export type Decision =
  | { kind: 'wait' }
  /** Tell the hub the task is moving. */
  | { kind: 'progress'; message: string }
  /** Tell the hub and the user it needs a look. The task stays open. */
  | { kind: 'attention'; message: string }
  /** Report the task failed with this message. */
  | { kind: 'timeout'; message: string }

const minutes = (ms: number): number => Math.max(1, Math.round(ms / 60_000))

/** One poll: the next state and what to do about it. */
export function decide(
  t: TaskTracking, seen: Observation, now: number, timings: TrackerTimings = DEFAULT_TIMINGS,
): { next: TaskTracking; decision: Decision } {
  if (now - t.startedAt >= timings.timeoutMs) {
    return { next: t, decision: { kind: 'timeout', message: timeoutMessage(t, timings) } }
  }

  if (seen.kind === 'steps' && seen.count !== t.steps) {
    const moved: TaskTracking = { ...t, steps: seen.count, lastActivityAt: now, attentionSent: false }
    if (t.lastReportAt !== undefined && now - t.lastReportAt < timings.progressEveryMs) {
      return { next: moved, decision: { kind: 'wait' } }
    }
    const message = t.steps === undefined
      ? `Conversation started (${seen.count} steps so far)`
      : `Working: ${seen.count} steps in its own conversation`
    return { next: { ...moved, lastReportAt: now }, decision: { kind: 'progress', message } }
  }

  if (!t.attentionSent && now - t.lastActivityAt >= timings.quietMs) {
    return {
      next: { ...t, attentionSent: true, lastReportAt: now },
      decision: { kind: 'attention', message: attentionMessage(t, seen, now) },
    }
  }
  return { next: t, decision: { kind: 'wait' } }
}

const HOW_IT_ENDS = 'It is not marked done until the agent reports with cortex_task_update or someone presses Mark done or Mark failed in the IDE.'

function attentionMessage(t: TaskTracking, seen: Observation, now: number): string {
  const quiet = minutes(now - t.lastActivityAt)
  switch (t.mode) {
    case 'tracked':
      if (t.steps !== undefined && seen.kind !== 'missing') {
        return `Needs attention: no new step in its conversation for ${quiet} min (at ${t.steps} steps). The agent may be finished or waiting for an approval. ${HOW_IT_ENDS}`
      }
      return `Needs attention: its conversation ${t.conversationId ?? ''} is not in the IDE's list of recent conversations, so its progress cannot be followed; no new step seen for ${quiet} min. ${HOW_IT_ENDS}`
    case 'untracked':
      return `Needs attention: started in a new conversation whose id the IDE did not report, so it is not followed; no result after ${quiet} min. ${HOW_IT_ENDS}`
    case 'manual':
      return `Needs attention: manual mode, no result reported after ${quiet} min. Waiting for Mark done, Mark failed or Release task in the IDE.`
  }
}

function timeoutMessage(t: TaskTracking, timings: TrackerTimings): string {
  const limit = minutes(timings.timeoutMs)
  const seen = t.mode === 'tracked' && t.steps !== undefined ? ` Its conversation was at ${t.steps} steps.` : ''
  return `No result after ${limit} min (cortexHub.taskTimeoutMinutes), so the IDE extension stopped waiting and reports it failed.${seen} Check the conversation in the IDE before retrying.`
}

/**
 * A `task.revoked` the hub sent for the running task. `completed` and `failed` most often come
 * from the agent's own cortex_task_update, so its conversation is left alone; any other reason
 * (cancelled, deleted, rerouted, a lease reclaim) means someone else owns the task now, and its
 * conversation is stopped so that two agents do not work on one task.
 */
export function revokeStopsConversation(reason: string): boolean {
  return reason !== 'completed' && reason !== 'failed'
}

/** The buttons a user reports a task's result with. */
export type UserReport = 'Mark done' | 'Mark failed' | 'Release task'
export const USER_REPORTS: readonly UserReport[] = ['Mark done', 'Mark failed', 'Release task']

export type Outcome =
  | { kind: 'complete'; status: 'completed' | 'failed'; result: { summary: string; error?: string } }
  | { kind: 'decline'; reason: string }

/** What a button sends to the hub. Release hands the task back, for another agent to take. */
export function outcomeFor(report: UserReport): Outcome {
  switch (report) {
    case 'Mark done':
      return { kind: 'complete', status: 'completed', result: { summary: 'Marked done by the user in the IDE' } }
    case 'Mark failed':
      return { kind: 'complete', status: 'failed', result: { summary: 'Marked failed by the user in the IDE', error: 'Marked failed by the user in the IDE' } }
    case 'Release task':
      return { kind: 'decline', reason: 'Released by the user in the IDE' }
  }
}

/** The paste shortcut named in the clipboard toast: Cmd+V on macOS, Ctrl+V on Windows and Linux. */
export function pasteShortcut(platform: string): 'Cmd+V' | 'Ctrl+V' {
  return platform === 'darwin' ? 'Cmd+V' : 'Ctrl+V'
}

const REPORT_HINT = 'press Mark done or Mark failed when the agent has finished, or Release task to hand it back'

/** The toast for a task this window cannot follow, by mode. `platform` is `process.platform`. */
export function untrackedToast(title: string, mode: 'untracked' | 'manual', platform: string): string {
  if (mode === 'manual') {
    return `Cortex: the prompt for "${title}" is on the clipboard. Paste it into a new AI chat with ${pasteShortcut(platform)}. This task will not be tracked automatically: ${REPORT_HINT}.`
  }
  return `Cortex: "${title}" went to a new agent conversation, but the IDE did not report its id, so this task will not be tracked automatically: ${REPORT_HINT}.`
}

/** The progress message that tells the hub a task is not followed automatically. */
export function untrackedProgress(mode: 'untracked' | 'manual'): string {
  if (mode === 'manual') {
    return 'Manual mode: this IDE window has no agent API, so the prompt was copied to the clipboard for the user to paste. Nothing tracks it automatically; waiting for the user to report the result.'
  }
  return 'Untracked: started in a new conversation whose id the IDE did not report. Waiting for cortex_task_update from the agent or a result from the user.'
}

/** The prompt for a task's conversation. The footer is how the agent itself reports the result. */
export function taskPrompt(taskId: string, description: string): string {
  return [
    `[Cortex Task ${taskId}]`,
    '',
    description,
    '',
    '---',
    `When you have finished, report the result to Cortex: call cortex_task_update with taskId "${taskId}" and status "completed" and a one-line summary as message, or status "failed" with the reason. Until then the task stays open.`,
  ].join('\n')
}

/**
 * Titles this window declines: review tasks belong to a reviewer agent, and running them here used
 * to loop. A word match, so that "preview" is not a review.
 */
export function isReviewTask(title: string): boolean {
  return /\breview/i.test(title)
}
