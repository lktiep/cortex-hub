// Task outcomes: what a finished task produced (pull request, branch, commit, tests) and what pressing
// Approve on it does. Pure module — no React, no DOM.
import type { ConductorTask } from '../api'
import { compareText, parseJson } from './model'
import type { PlanState, PlanTask } from './model'

export type TestsState = 'passed' | 'failed' | 'none'

export interface TaskOutcome {
  summary: string
  /** `number` is null for a pull request URL that is not a GitHub `/pull/N` (and then there is no checks page). */
  pr: { url: string; number: number | null; checksUrl: string | null } | null
  compareUrl: string | null
  /** `url` is null when no repository base could be derived: the name is shown as plain text. */
  branch: { name: string; url: string | null } | null
  commit: { sha: string; short: string; url: string | null } | null
  tests: TestsState
  testOutput: string | null
  error: string | null
  raw: string
}

/** Summaries longer than this many lines start folded. */
export const SUMMARY_FOLD_LINES = 8
/** A line of wrapped prose in the drawer holds about this many characters. */
const CHARS_PER_LINE = 90

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const PR_PATH = /^(\/[^/]+\/[^/]+)\/pull\/(\d+)(?:\/|$)/
const COMPARE_PATH = /^(\/[^/]+\/[^/]+)\/compare\//
// A GitHub PR URL in free text, for agents that report one only in prose.
const PR_IN_TEXT = /https:\/\/[^\s<>()"'`]+\/pull\/\d+/
const COMPARE_IN_TEXT = /Compare:\s*(\S+)/
const SHA = /^[0-9a-f]{7,64}$/i

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** The first non-empty string among `keys` of `obj`. */
function text(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  return null
}

/**
 * A link the dashboard may render: `https:` anywhere, `http:` only to this machine. Anything else
 * (`javascript:`, `data:`, plain `http:`, credentials in the URL, garbage) is dropped.
 */
export function safeUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/[).,;]+$/, '')
  if (trimmed === '' || /\s/.test(trimmed)) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.username !== '' || url.password !== '') return null
  if (url.protocol === 'https:') return url
  if (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)) return url
  return null
}

function parsePr(value: unknown): TaskOutcome['pr'] {
  const url = safeUrl(value)
  if (!url) return null
  const m = PR_PATH.exec(url.pathname)
  if (!m) return { url: url.href, number: null, checksUrl: null }
  const canonical = `${url.origin}${m[1]}/pull/${m[2]}`
  return { url: url.href, number: Number(m[2]), checksUrl: `${canonical}/checks` }
}

/** `https://host/<owner>/<repo>` from a pull request or compare URL, or null. */
function repoBase(...urls: Array<string | null>): string | null {
  for (const u of urls) {
    const url = u ? safeUrl(u) : null
    if (!url) continue
    const m = PR_PATH.exec(url.pathname) ?? COMPARE_PATH.exec(url.pathname)
    if (m) return `${url.origin}${m[1]}`
  }
  return null
}

/** Whitespace or a control character: not a git ref or sha. */
function hasSpaceOrControl(s: string): boolean {
  return /\s/.test(s) || [...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
}

function branchOf(name: string | null, base: string | null): TaskOutcome['branch'] {
  const n = name?.trim() ?? ''
  if (n === '' || n.length > 255 || hasSpaceOrControl(n)) return null
  const path = n.split('/').map(encodeURIComponent).join('/')
  return { name: n, url: base ? `${base}/tree/${path}` : null }
}

function commitOf(sha: string | null, base: string | null): TaskOutcome['commit'] {
  const s = sha?.trim() ?? ''
  if (s === '' || s.length > 64 || hasSpaceOrControl(s)) return null
  const hex = SHA.test(s)
  return { sha: s, short: hex ? s.slice(0, 7) : s, url: hex && base ? `${base}/commit/${s}` : null }
}

/**
 * Worker results put the test failure first in `error` ("tests failed (exit N)"). A failed task that
 * reports test output and no error at all counts as failed tests too; a failed task whose error is
 * something else (push, commit, no changes) ran its tests before that and they passed.
 */
function testsOf(error: string | null, testOutput: string | null, status: string): TestsState {
  const testError = error !== null && error.split('\n').some((l) => /^tests failed\b/i.test(l.trim()))
  if (testError) return 'failed'
  if (testOutput === null) return 'none'
  if (status === 'failed' && error === null) return 'failed'
  return 'passed'
}

/** The task's result, parsed defensively: worker results, any MCP agent JSON, or plain text. */
export function taskOutcome(row: ConductorTask): TaskOutcome | null {
  const raw = row.result
  if (raw === null || raw === undefined || raw.trim() === '') return null
  const parsed = parseJson<unknown>(raw, undefined)
  // A list (subtasks, findings) is a structured result with its own view in the drawer.
  if (Array.isArray(parsed)) return null
  if (!isRecord(parsed)) {
    const summary = typeof parsed === 'string' ? parsed : raw
    return {
      summary, pr: parsePr(PR_IN_TEXT.exec(summary)?.[0]), compareUrl: null, branch: null, commit: null,
      tests: 'none', testOutput: null, error: null, raw,
    }
  }
  const summary = text(parsed, 'summary', 'message', 'text') ?? ''
  const pr = parsePr(text(parsed, 'prUrl', 'pr_url', 'pullRequestUrl')) ?? parsePr(PR_IN_TEXT.exec(summary)?.[0])
  const compareUrl = safeUrl(text(parsed, 'compareUrl', 'compare_url') ?? COMPARE_IN_TEXT.exec(summary)?.[1])?.href ?? null
  const base = repoBase(pr?.url ?? null, compareUrl)
  const testOutput = text(parsed, 'testOutput', 'test_output')
  const error = text(parsed, 'error')
  const outcome: TaskOutcome = {
    summary,
    pr,
    compareUrl,
    branch: branchOf(text(parsed, 'branch'), base),
    commit: commitOf(text(parsed, 'commit', 'sha'), base),
    tests: testsOf(error, testOutput, row.status),
    testOutput,
    error,
    raw,
  }
  // Structured results with nothing of the above (findings, subtasks) have their own views.
  const empty = summary === '' && !pr && !compareUrl && !outcome.branch && !outcome.commit && !testOutput && !error
  return empty ? null : outcome
}

/** Whether a summary is long enough to start folded. */
export function isLongSummary(summary: string): boolean {
  const lines = summary.split('\n')
  if (lines.length > SUMMARY_FOLD_LINES) return true
  const wrapped = lines.reduce((n, l) => n + Math.max(1, Math.ceil(l.length / CHARS_PER_LINE)), 0)
  return wrapped > SUMMARY_FOLD_LINES
}

/** "PR #12", or "PR" for a pull request without a number; null without one. */
export function prLabel(outcome: TaskOutcome | null): string | null {
  if (!outcome?.pr) return null
  return outcome.pr.number === null ? 'PR' : `PR #${outcome.pr.number}`
}

export const TESTS_LABEL: Record<TestsState, string> = {
  passed: 'tests passed',
  failed: 'tests failed',
  none: 'tests not run',
}

/** Up to this many PR numbers are listed for a gate; past it, only the count. */
const MAX_LISTED_PRS = 3

/**
 * The artifacts of a task in a few words, for lists: "PR #12 · tests passed" for work, and for a gate its
 * dependencies' ("PRs #11, #12 · tests failed: B1"). Null when there is nothing to report.
 */
export function artifactLine(task: PlanTask, byId: Map<string, PlanTask>): string | null {
  if (task.kind === 'group') return null
  if (task.kind === 'work') {
    const o = taskOutcome(task.row)
    return [prLabel(o), o && o.tests !== 'none' ? TESTS_LABEL[o.tests] : null].filter(Boolean).join(' · ') || null
  }
  const deps = task.deps
    .map((id) => byId.get(id))
    .filter((d): d is PlanTask => d !== undefined)
    .sort((a, b) => compareText(a.key, b.key))
    .map((d) => ({ key: d.key, outcome: taskOutcome(d.row) }))
  const prs = deps.flatMap((d) => (d.outcome?.pr ? [d.outcome.pr.number] : []))
  const numbers = prs.filter((n): n is number => n !== null)
  let prPart: string | null = null
  if (prs.length === 1) prPart = numbers.length === 1 ? `PR #${numbers[0]}` : 'PR'
  else if (prs.length > 1) {
    prPart = numbers.length === prs.length && prs.length <= MAX_LISTED_PRS
      ? `PRs ${numbers.map((n) => `#${n}`).join(', ')}`
      : `${prs.length} PRs`
  }
  const failed = deps.filter((d) => d.outcome?.tests === 'failed').map((d) => d.key)
  const passed = deps.filter((d) => d.outcome?.tests === 'passed').length
  let testsPart: string | null = null
  if (failed.length > 0) testsPart = `tests failed: ${listKeys(failed)}`
  else if (passed > 0) testsPart = passed === deps.length ? 'tests passed' : `tests passed ${passed}/${deps.length}`
  return [prPart, testsPart].filter(Boolean).join(' · ') || null
}

// ── approve context ──

export interface ApproveDep {
  id: string
  key: string
  title: string
  state: PlanState
  /** Completed on the hub, which is what a gate's approval needs. */
  done: boolean
  outcome: TaskOutcome | null
}

export interface ApproveContext {
  /** "Approve B3" or "Approve gate G1". */
  label: string
  /** Keys of the tasks that leave `blocked` when this is approved. */
  unblocks: string[]
  /** A gate's direct dependencies (groups stand for their last tasks); [] for work. */
  deps: ApproveDep[]
  /** Keys of a gate's dependencies that are not completed. */
  waitingOn: string[]
  /** A gate's dependencies outside this plan, which the dashboard cannot see. */
  external: number
  /** Why Approve is disabled, or null. */
  disabled: string | null
  /** One line under the button: what approving does, or why it cannot. */
  line: string
  reject: {
    /** Keys of the tasks a rejection sends back to their workers. */
    returns: string[]
    placeholder: string
    disabled: string | null
  }
}

const completed = (t: PlanTask) => t.row.status === 'completed'

/** "B1", "B1 and B2", "B1, B2 and B3". */
export function listKeys(keys: string[]): string {
  if (keys.length <= 1) return keys.join('')
  return `${keys.slice(0, -1).join(', ')} and ${keys[keys.length - 1]}`
}

/** Raw `depends_on` ids, groups and tasks outside the plan included — what the hub checks. */
function rawDeps(task: PlanTask): string[] {
  const deps = parseJson<unknown>(task.row.depends_on, [])
  return Array.isArray(deps) ? [...new Set(deps.filter((d): d is string => typeof d === 'string'))] : []
}

/**
 * Blocked tasks that approving `task` releases: the hub moves a `blocked` dependent to `pending` once every
 * dependency is completed. Dependents with dependencies outside the plan are left out, as unknown.
 */
function unblockedBy(task: PlanTask, byId: Map<string, PlanTask>): string[] {
  const out: string[] = []
  for (const t of byId.values()) {
    if (t.kind === 'group' || t.state !== 'blocked' || t.externalDeps > 0 || !t.deps.includes(task.id)) continue
    const others = t.deps.filter((d) => d !== task.id).map((d) => byId.get(d))
    if (others.every((d) => d !== undefined && completed(d))) out.push(t.key)
  }
  return out.sort(compareText)
}

function mergeNote(prs: number): string | null {
  if (prs === 0) return null
  return prs === 1 ? 'the PR is not merged by this' : `the ${prs} PRs are not merged by this`
}

/**
 * What Approve and Reject do on `task`, after the hub's review rules: approving work in review marks it
 * done and releases its dependents (the PR stays open); approving a gate needs every dependency completed;
 * rejecting a gate sends its completed direct work dependencies back to their workers.
 */
export function approveContext(task: PlanTask, byId: Map<string, PlanTask>): ApproveContext {
  const unblocks = unblockedBy(task, byId)
  const unblocksPart = unblocks.length > 0 ? `unblocks ${listKeys(unblocks)}` : null

  if (task.kind !== 'gate') {
    const outcome = taskOutcome(task.row)
    const note = outcome?.pr
      ? mergeNote(1)
      : outcome?.branch ? `branch ${outcome.branch.name} is not merged by this` : null
    const escalates = task.rejectCount >= 1 ? ' It was rejected before, so this escalates it.' : ''
    return {
      label: `Approve ${task.key}`,
      unblocks,
      deps: [],
      waitingOn: [],
      external: 0,
      disabled: null,
      line: [`Marks ${task.key} done`, unblocksPart, note].filter(Boolean).join(' · '),
      reject: {
        returns: [task.key],
        placeholder: `Why ${task.key} goes back — it reruns on its branch with this feedback (required).${escalates}`,
        disabled: null,
      },
    }
  }

  const deps: ApproveDep[] = task.deps
    .map((id) => byId.get(id))
    .filter((d): d is PlanTask => d !== undefined)
    .sort((a, b) => compareText(a.key, b.key))
    .map((d) => ({ id: d.id, key: d.key, title: d.title, state: d.state, done: completed(d), outcome: taskOutcome(d.row) }))
  const raw = rawDeps(task).map((id) => byId.get(id)).filter((d): d is PlanTask => d !== undefined)
  const waitingOn = deps.filter((d) => !d.done).map((d) => d.key)
  // A group stands for its last tasks; it can still be open after they finish (an earlier task failed).
  if (waitingOn.length === 0) {
    for (const g of raw) if (g.kind === 'group' && !completed(g)) waitingOn.push(g.key)
  }
  const disabled = waitingOn.length > 0
    ? `${listKeys(waitingOn)} ${waitingOn.length === 1 ? 'is' : 'are'} not done yet — every dependency must be completed first`
    : null
  const external = task.externalDeps
  const externalPart = external > 0 ? `also needs ${external} task${external === 1 ? '' : 's'} outside this plan` : null
  const line = disabled ?? [
    `Closes gate ${task.key}`,
    unblocksPart,
    externalPart,
    mergeNote(deps.filter((d) => d.outcome?.pr).length),
  ].filter(Boolean).join(' · ')

  // Only completed direct work goes back, not a group's children (hub: reviewTask).
  const returns = raw.filter((d) => d.kind === 'work' && completed(d)).map((d) => d.key).sort(compareText)
  const reject = returns.length > 0
    ? {
        returns,
        placeholder: `Why ${listKeys(returns)} ${returns.length === 1 ? 'goes' : 'go'} back — rerun with this feedback, and ${task.key} waits for them again (required)`,
        disabled: null,
      }
    : {
        returns,
        placeholder: 'No completed work feeds this gate, so there is nothing to send back',
        disabled: 'nothing to return: cancel the gate or reroute its dependencies',
      }
  return { label: `Approve gate ${task.key}`, unblocks, deps, waitingOn, external, disabled, line, reject }
}
