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
  /** Set on a hit from a search across the organization's repos: the repo it is in. */
  repo?: string
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

const place = (m: CodeMatch) => (m.repo ? `${m.repo}: ${m.filePath}` : m.filePath!)

export function formatCodeMatches(matches: CodeMatch[]): string {
  const ranked = matches.filter((m) => m.filePath)
  if (ranked.length === 0) return ''

  // One line per file, in the order its best chunk ranked.
  const files = new Map<string, string[]>()
  for (const m of ranked) {
    const where = files.get(place(m)) ?? []
    where.push([lines(m), pct(m.score)].filter(Boolean).join(' '))
    files.set(place(m), where)
  }
  const across = ranked.some((m) => m.repo)
  const out = [`**Best matching files**${across ? ' across your organization\'s repos' : ''} (semantic search over the source):`]
  let i = 0
  for (const [file, where] of files) {
    out.push(`${++i}. ${file} — ${where.join(', ')}`)
  }

  for (const m of ranked.slice(0, SNIPPET_COUNT)) {
    if (!m.content) continue
    const ext = m.filePath!.split('.').pop() ?? ''
    out.push('', `### ${place(m)}${m.startLine ? `:${m.startLine}-${m.endLine ?? m.startLine}` : ''}`)
    out.push(`\`\`\`${LANG[ext] ?? ext}`, trimChunk(m.content), '```')
  }
  // Without this an agent read every listed file whole, 9–25k characters for a 1.5k chunk.
  if (ranked.some((m) => m.startLine)) {
    out.push('', 'To see more, read just those lines (Read with offset/limit) rather than the whole file.')
  }
  return out.join('\n')
}

/** Other repos shown under a search of the current one, and files from each: a few. */
export const OTHER_REPOS = 5
export const FILES_PER_OTHER_REPO = 2

/**
 * What the organization's other repos hold for the query, one line per repo, under a search of
 * the repo the agent is in. The organization is the unit that shares code — a game's client,
 * server and tools — so the related code next door stays in view without a second search, and
 * without crowding out the current repo's own hits.
 */
export function formatOtherRepos(matches: CodeMatch[]): string {
  const repos = new Map<string, string[]>()
  for (const m of matches.filter((x) => x.repo && x.filePath)) {
    const files = repos.get(m.repo!) ?? []
    if (files.length >= FILES_PER_OTHER_REPO || (files.length === 0 && repos.size >= OTHER_REPOS)) continue
    files.push([m.filePath, lines(m), pct(m.score)].filter(Boolean).join(' '))
    repos.set(m.repo!, files)
  }
  if (repos.size === 0) return ''
  const out = ['**In other repos of your organization:**']
  for (const [repo, files] of repos) out.push(`- ${repo} — ${files.join(', ')}`)
  out.push('Search one with `repo: "<name>"`, or all of them with `repo: "*"`.')
  return out.join('\n')
}
