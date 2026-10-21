// How cortex_code_search shows the semantic arm's hits. That arm is the one the retrieval
// benchmark measures (target file inside the top 10 for every gold query), so it goes first,
// as a ranked list of files an agent can act on, followed by a few trimmed snippets. It used
// to come last, after the execution flows, as five raw 2000-character chunks: ~9k characters
// per search, each chunk opening mid-line, and the same file printed once per chunk.

export interface CodeMatch {
  score: number
  filePath?: string
  content?: string
  chunkIndex?: number
  /** Where the chunk sits in the hub's checkout, when its text is still there. */
  startLine?: number
  endLine?: number
}

/** Matches shown with code; the rest are listed by path only. */
export const SNIPPET_COUNT = 3
export const SNIPPET_CHARS = 1200

const LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', mjs: 'javascript', cs: 'csharp', py: 'python',
  go: 'go', rs: 'rust', java: 'java', sh: 'bash', ps1: 'powershell', sql: 'sql',
}

/**
 * A chunk is cut at a character count, so all but the first open mid-line. Start at the first
 * whole line, drop the "// File:" header the indexer adds (the heading names the file), and
 * cut at a line end.
 */
export function trimChunk(content: string, max = SNIPPET_CHARS): string {
  let text = content
  if (text.startsWith('// File: ')) {
    text = text.slice(text.indexOf('\n') + 1)
  } else {
    const nl = text.indexOf('\n')
    if (nl >= 0 && nl < 200) text = text.slice(nl + 1)
  }
  text = text.replace(/^\s*\n/, '').trimEnd()
  if (text.length > max) {
    const cut = text.lastIndexOf('\n', max)
    text = `${text.slice(0, cut > max / 2 ? cut : max)}\n…`
  }
  return text
}

const pct = (score: number) => `${Math.round(score * 100)}%`
const lines = (m: CodeMatch) => (m.startLine ? `L${m.startLine}-${m.endLine ?? m.startLine}` : '')

export function formatCodeMatches(matches: CodeMatch[]): string {
  const ranked = matches.filter((m) => m.filePath)
  if (ranked.length === 0) return ''

  // One line per file, in the order its best chunk ranked.
  const files = new Map<string, string[]>()
  for (const m of ranked) {
    const where = files.get(m.filePath!) ?? []
    where.push([lines(m), pct(m.score)].filter(Boolean).join(' '))
    files.set(m.filePath!, where)
  }
  const out = ['**Best matching files** (semantic search over the source):']
  let i = 0
  for (const [file, where] of files) {
    out.push(`${++i}. ${file} — ${where.join(', ')}`)
  }

  for (const m of ranked.slice(0, SNIPPET_COUNT)) {
    if (!m.content) continue
    const ext = m.filePath!.split('.').pop() ?? ''
    out.push('', `### ${m.filePath}${m.startLine ? `:${m.startLine}-${m.endLine ?? m.startLine}` : ''}`)
    out.push(`\`\`\`${LANG[ext] ?? ext}`, trimChunk(m.content), '```')
  }
  // Without this an agent read every listed file whole, 9–25k characters for a 1.5k chunk.
  if (ranked.some((m) => m.startLine)) {
    out.push('', 'To see more, read just those lines (Read with offset/limit) rather than the whole file.')
  }
  return out.join('\n')
}
