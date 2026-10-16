import type { AssignedTask, TaskReview } from '@cortex/shared-types'

// Under Windows' 32 767-char CreateProcess limit for agy's argv prompt.
export const PROMPT_LIMIT = 24_000

const MARK = '[truncated]'
const RULES = [
  '## Rules',
  '- Do not commit, push, or switch branches; the worker does that.',
  '- Stay inside this working tree.',
].join('\n')
const RESUMING = [
  '## Resuming',
  'A previous run of this task was interrupted. The working tree may already hold partial work.',
  'Inspect `git status` and `git diff`, then continue from where it stopped.',
].join('\n')

interface Parts {
  head: string // "<key|id>"
  title: string
  description: string
  reviews: TaskReview[] // newest first, already cut
  omitted: number
  files: string
  note: string | null
  resumed: boolean
}

function render(p: Parts): string {
  const out: string[] = [`# ${p.head}: ${p.title}`]
  if (p.description !== '') out.push(p.description)
  if (p.files !== '') out.push(`## Files\n${p.files}`)
  if (p.reviews.length > 0 || p.omitted > 0) {
    const lines = p.reviews.map((r) => `- ${r.by} (${r.verdict}): ${r.feedback}`)
    if (p.omitted > 0) lines.push(`[truncated: ${p.omitted} older reviews omitted]`)
    out.push(`## Previous review feedback\n${lines.join('\n')}`)
  }
  if (p.note !== null) out.push(`## Handoff from the previous run\n${p.note}`)
  if (p.resumed) out.push(RESUMING)
  out.push(RULES)
  return out.join('\n\n')
}

function time(at: string): number {
  const t = Date.parse(at)
  return Number.isNaN(t) ? 0 : t
}

type CutField = 'description' | 'files' | 'title'

/** Keep the head of a string field so the whole prompt fits, ending in the marker. */
function cut(p: Parts, field: CutField | 'note'): void {
  const original = (field === 'note' ? p.note : p[field]) ?? ''
  const set = (v: string): void => {
    if (field === 'note') p.note = v
    else p[field] = v
  }
  set(MARK)
  const room = PROMPT_LIMIT - render(p).length
  set(original.slice(0, Math.max(0, room)) + MARK)
}

export function buildPrompt(task: AssignedTask, opts: { resumed?: boolean } = {}): string {
  const reviews = task.reviews
    .map((r, i) => ({ r, i }))
    .sort((a, b) => time(b.r.at) - time(a.r.at) || a.i - b.i)
    .map((x) => x.r)
  const p: Parts = {
    head: task.key ?? task.id,
    title: task.title,
    description: task.description,
    reviews,
    omitted: 0,
    files: task.files.join('\n'),
    note: task.handoff ? task.handoff.note : null,
    resumed: opts.resumed === true,
  }
  const fits = (): boolean => render(p).length <= PROMPT_LIMIT

  if (fits()) return render(p)
  cut(p, 'description')
  if (fits()) return render(p)

  const all = p.reviews
  while (p.reviews.length > 0 && !fits()) {
    p.reviews = p.reviews.slice(0, -1)
    p.omitted = all.length - p.reviews.length
  }
  if (fits()) return render(p)

  cut(p, 'files')
  if (fits()) return render(p)
  if (p.note !== null) cut(p, 'note')
  if (fits()) return render(p)
  cut(p, 'title')
  return render(p)
}
