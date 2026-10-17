import type { AssignedTask } from '@cortex/shared-types'

// Under Windows' 32 767-char CreateProcess limit for agy's argv prompt, as measured by the
// engine (`EngineAdapter.promptLength`): on Windows that is the quoted length, which quotes inflate.
export const PROMPT_LIMIT = 24_000

const MARK = '[truncated]'
const DESCRIPTION_FLOOR = 8_000
const HEAD_MAX = 200
const BY_MAX = 100
const TEST_COMMAND_MAX = 500

const RULES = [
  '## Rules',
  '- Do not commit, push, or switch branches; the worker does that.',
  '- Stay inside this working tree.',
].join('\n')
// for an engine that refuses commands (EngineAdapter.refusesCommands): a refused command ends its run
const NO_COMMANDS =
  '- Do not run shell commands, not even `ls`, `git` or the tests. This engine runs headless and ' +
  'refuses every command, and a refused command ends your run on the spot, with or without your edits. ' +
  'Read, search and edit with your file tools only.'
const RESUMING = [
  '## Resuming',
  'A previous run of this task was interrupted. The working tree may already hold partial work.',
  'Inspect `git status` and `git diff`, then continue from where it stopped.',
].join('\n')
const RESUMING_NO_COMMANDS = [
  '## Resuming',
  'A previous run of this task was interrupted. The working tree may already hold partial work.',
  'Read the files this task changes to see how far it got, then continue from there.',
].join('\n')

interface ReviewLine {
  by: string
  verdict: string
  feedback: string // newlines already indented
}

interface Parts {
  head: string
  title: string
  description: string
  reviews: ReviewLine[] // newest first
  omitted: number
  files: string
  note: string | null
  tests: string | null
  resumed: boolean
  noCommands: boolean
}

function render(p: Parts): string {
  const out: string[] = [`# ${p.head}: ${p.title}`]
  if (p.description !== '') out.push(p.description)
  if (p.files !== '') out.push(`## Files\n${p.files}`)
  if (p.reviews.length > 0) {
    const lines = p.reviews.map((r) => `- ${r.by} (${r.verdict}): ${r.feedback}`)
    if (p.omitted > 0) {
      lines.push(
        p.omitted === 1
          ? '[truncated: 1 older review omitted]'
          : `[truncated: ${p.omitted} older reviews omitted]`,
      )
    }
    out.push(`## Previous review feedback\n${lines.join('\n')}`)
  }
  if (p.note !== null) out.push(`## Handoff from the previous run\n${p.note}`)
  if (p.resumed) out.push(p.noCommands ? RESUMING_NO_COMMANDS : RESUMING)
  if (p.tests !== null) out.push(p.tests)
  out.push(p.noCommands ? `${RULES}\n${NO_COMMANDS}` : RULES)
  return out.join('\n\n')
}

const oneLine = (s: string): string => s.replace(/\r?\n/g, ' ')

function time(at: string): number {
  const t = Date.parse(at)
  return Number.isNaN(t) ? 0 : t
}

/** The first n chars, never ending in a lone high surrogate. */
function headOf(s: string, n: number): string {
  if (n <= 0) return ''
  const h = s.slice(0, n)
  const last = h.charCodeAt(h.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? h.slice(0, -1) : h
}

/**
 * The length of `arg` on the command line Node builds for CreateProcess on Windows (libuv's
 * quote_cmd_arg): an argument holding a space, tab or quote is wrapped in quotes, each quote
 * inside gets a backslash, and the backslashes before a quote or before the closing quote
 * are doubled.
 */
export function win32QuotedLength(arg: string): number {
  if (arg === '') return 2
  if (!/[ \t"]/.test(arg)) return arg.length
  if (!/["\\]/.test(arg)) return arg.length + 2
  let n = arg.length + 2
  let backslashes = 0
  for (let i = 0; i < arg.length; i++) {
    const c = arg[i]
    if (c === '\\') {
      backslashes++
      continue
    }
    if (c === '"') n += backslashes + 1
    backslashes = 0
  }
  return n + backslashes // the closing quote
}

export function buildPrompt(
  task: AssignedTask,
  opts: {
    resumed?: boolean
    testCommand?: string | null
    /** How the prompt counts against PROMPT_LIMIT; its length unless the engine says otherwise. */
    measure?: (prompt: string) => number
    /** The engine refuses shell commands (EngineAdapter.refusesCommands), so it is told not to run any. */
    noCommands?: boolean
  } = {},
): string {
  const size = opts.measure ?? ((s: string): number => s.length)
  const sorted = task.reviews
    .map((r, i) => ({ r, i }))
    .sort((a, b) => time(b.r.at) - time(a.r.at) || a.i - b.i)
    .map(({ r }) => ({
      by: oneLine(r.by).slice(0, BY_MAX),
      verdict: r.verdict,
      feedback: r.feedback.replace(/\r?\n/g, '\n  '),
    }))
  const command = opts.testCommand?.trim() ?? ''
  const noCommands = opts.noCommands === true
  const note = task.handoff && task.handoff.note.trim() !== '' ? task.handoff.note : null
  const original = { title: oneLine(task.title), description: task.description, files: task.files.join('\n'), note }

  const p: Parts = {
    head: oneLine(task.key ?? task.id).slice(0, HEAD_MAX),
    title: original.title,
    description: original.description,
    reviews: sorted,
    omitted: 0,
    files: original.files,
    note,
    tests:
      command === ''
        ? null
        : `## Tests\nAfter you finish, the worker runs \`${oneLine(command).slice(0, TEST_COMMAND_MAX)}\` in this working tree; if it fails, the task fails. ${
            noCommands ? 'You cannot run it yourself here (see the rules), so read the tests it runs.' : 'Run it yourself before you stop.'
          }`,
    resumed: opts.resumed === true,
    noCommands,
  }
  const over = (): boolean => size(render(p)) > PROMPT_LIMIT

  /**
   * Set a field to its head so the prompt fits, with the marker appended. The head keeps
   * at least `floor` chars (the prompt may stay over). Nothing is cut when the whole
   * original fits, and an empty original is never touched.
   */
  const fit = (set: (v: string) => void, orig: string, floor: number): void => {
    if (orig === '') return
    set(orig)
    if (!over()) return
    set(MARK)
    let n = Math.max(PROMPT_LIMIT - size(render(p)), floor)
    set(headOf(orig, n) + MARK)
    // the head's own escaping can still overflow: cut it by the overflow until it fits
    while (over() && n > floor) {
      n = Math.max(floor, n - (size(render(p)) - PROMPT_LIMIT))
      set(headOf(orig, n) + MARK)
    }
  }
  const setDescription = (v: string): void => {
    p.description = v
  }

  if (!over()) return render(p)

  // 1. description head, down to its floor
  if (original.description.length > DESCRIPTION_FLOOR) {
    fit(setDescription, original.description, DESCRIPTION_FLOOR)
  }
  // 2. oldest reviews, never the newest; a lone review gets its feedback cut
  while (over() && p.reviews.length > 1) {
    p.reviews = p.reviews.slice(0, -1)
    p.omitted = sorted.length - p.reviews.length
  }
  if (over() && p.reviews.length === 1) {
    const only = sorted[0]!
    const line = p.reviews[0]!
    fit(
      (v) => {
        line.feedback = v
      },
      only.feedback,
      0,
    )
  }
  // 3. files, handoff note, title
  if (over()) fit((v) => { p.files = v }, original.files, 0)
  if (over() && original.note !== null) {
    fit((v) => { p.note = v }, original.note, 0)
  }
  if (over()) fit((v) => { p.title = v }, original.title, 0)
  // 4. description below its floor
  if (over()) fit(setDescription, original.description, 0)
  // 5. give the description whatever room is left
  fit(setDescription, original.description, 0)

  return render(p)
}
