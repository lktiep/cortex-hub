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

export function formatCodeMatches(matches: CodeMatch[], snippets = SNIPPET_COUNT, symbols: OutlineSymbol[] = []): string {
  const ranked = matches.filter((m) => m.filePath)
  if (ranked.length === 0) return ''

  // One line per file, in the order its best chunk ranked.
  const files = new Map<string, CodeMatch[]>()
  for (const m of ranked) files.set(place(m), [...(files.get(place(m)) ?? []), m])
  const across = ranked.some((m) => m.repo)
  const out = [`**Best matching files**${across ? ' across your organization\'s repos' : ''} (semantic search over the source):`]
  let i = 0
  let named = false
  for (const [file, hits] of files) {
    const where = hits.map((m) => [lines(m), pct(m.score)].filter(Boolean).join(' ')).join(', ')
    const own = hits[0]!.repo ? [] : symbols.filter((s) => s.file === hits[0]!.filePath)
    const inside = hitSymbols(own, hits.filter((m) => m.startLine).map((m) => [m.startLine!, m.endLine ?? m.startLine!]))
    named ||= inside !== ''
    out.push(`${++i}. ${file} — ${where}${inside ? ` · in ${inside}` : ''}`)
  }

  for (const m of ranked.slice(0, snippets)) {
    if (!m.content) continue
    const ext = m.filePath!.split('.').pop() ?? ''
    out.push('', `### ${place(m)}${m.startLine ? `:${m.startLine}-${m.endLine ?? m.startLine}` : ''}`)
    out.push(`\`\`\`${LANG[ext] ?? ext}`, trimChunk(m.content), '```')
  }
  // Without this an agent read every listed file whole, 9–25k characters for a 1.5k chunk.
  if (ranked.some((m) => m.startLine)) {
    out.push('', `Read just those lines (Read with offset/limit), not the whole file.${named ? ' Callers and callees of a symbol: cortex_code_context.' : ''}`)
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

/**
 * The symbols a hit falls in, named on its file's line, in place of the graph's execution flows.
 * Measured in the agent benchmark: after a search ranked the right file first every time, the
 * flows under it were other features' call chains (~1.2k characters an agent read and never
 * used), and the agent still opened the whole file to find the function it had to change. A
 * whole-file outline after that was no better: a large file's 80 symbols, none of them the one.
 */
export interface OutlineSymbol {
  file: string
  name: string
  type: string
  start: number
  end: number
}

export const OUTLINE_FILES = 5
export const SYMBOLS_PER_FILE = 3
// What an agent reads or changes as a unit. A property or a one-line constant only crowds the line.
const OUTLINE_KINDS = ['Function', 'Method', 'Class', 'Interface', 'TypeAlias', 'Route']

/** The files the outline covers: the best few of the repo being searched, in rank order. */
export function outlineFiles(matches: CodeMatch[]): string[] {
  const files: string[] = []
  for (const m of matches) {
    if (m.repo || !m.filePath || files.includes(m.filePath)) continue
    files.push(m.filePath)
    if (files.length === OUTLINE_FILES) break
  }
  return files
}

/** One file's symbols. One query per file: with several, a large file used up a shared limit. */
export function outlineQuery(file: string): string {
  const path = `'${file.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  return `MATCH (n) WHERE n.filePath = ${path} AND n.startLine IS NOT NULL AND labels(n) IN [${OUTLINE_KINDS.map((k) => `'${k}'`).join(', ')}] ` +
    'RETURN n.filePath AS file, n.name AS name, labels(n) AS type, n.startLine AS s, n.endLine AS e ORDER BY s LIMIT 300'
}

/** The rows of the markdown table the cypher endpoint answers with. */
export function parseOutline(raw: string): OutlineSymbol[] {
  const out: OutlineSymbol[] = []
  for (const line of raw.split('\n')) {
    if (!line.startsWith('|') || line.startsWith('| ---')) continue
    const [file, name, type, s, e] = line.split('|').slice(1, -1).map((c) => c.trim())
    const start = Number(s)
    if (!file || !name || file === 'file' || !Number.isFinite(start)) continue
    out.push({ file, name, type: type ?? '', start, end: Number(e) || start })
  }
  return out
}

/** The symbols of the files, asked in parallel through `ask` (a cypher query to its raw table). */
export async function fetchOutline(files: string[], ask: (query: string) => Promise<string>): Promise<OutlineSymbol[]> {
  const tables = await Promise.all(files.map((f) => ask(outlineQuery(f)).catch(() => '')))
  return tables.flatMap(parseOutline)
}

/**
 * "name L<start>-<end>" for the innermost symbols the hit ranges fall in — a method, not the
 * class around it — at most a few; '' when no hit falls in one.
 */
export function hitSymbols(symbols: OutlineSymbol[], ranges: Array<[number, number]>): string {
  const hit = symbols.filter((s) => OUTLINE_KINDS.includes(s.type) && ranges.some(([a, b]) => s.start <= b && s.end >= a))
  const inner = hit.filter((s) => !hit.some((o) => o !== s && o.start >= s.start && o.end <= s.end && (o.start > s.start || o.end < s.end)))
  const seen = new Set<string>()
  const shown = inner.sort((a, b) => a.start - b.start).filter((s) => {
    const key = `${s.name}@${s.start}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (shown.length === 0) return ''
  const more = shown.length > SYMBOLS_PER_FILE ? `, +${shown.length - SYMBOLS_PER_FILE} more` : ''
  return shown.slice(0, SYMBOLS_PER_FILE).map((s) => `${s.name} L${s.start}-${s.end}`).join(', ') + more
}
