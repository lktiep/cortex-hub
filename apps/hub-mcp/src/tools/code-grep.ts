// What cortex_code_grep answers: the hub's grep over each repo's default branch, grouped by repo
// and file, one line per hit, so the answer reads like rg's — or, with files, one matching file
// per line with its count, as `rg -c` reads.

export interface GrepRepo {
  repo: string
  total: number
  hits: Array<{ file: string; line: number; text: string }>
  files?: Array<{ file: string; count: number }>
  truncated: boolean
  error?: string
}

export interface GrepData {
  pattern: string
  filesOnly?: boolean
  searched?: string[]
  notCloned?: string[]
  results?: GrepRepo[]
}

/** Hits listed for one file before the rest are only counted. */
export const HITS_PER_FILE = 8

export function formatGrep(data: GrepData): string {
  const results = data.results ?? []
  const matched = results.filter((r) => r.total > 0)
  const searched = data.searched?.length ?? results.length
  const total = matched.reduce((n, r) => n + r.total, 0)
  const more = matched.some((r) => r.truncated)
  const unit = data.filesOnly ? 'file(s)' : 'line(s)'
  const out = [
    matched.length
      ? `grep ${JSON.stringify(data.pattern)}: ${total}${more ? '+' : ''} ${unit} in ${matched.length} of ${searched} repo(s), on each repo's default branch.`
      : `grep ${JSON.stringify(data.pattern)}: no match in ${searched} repo(s), on each repo's default branch.`,
  ]

  for (const r of matched) {
    if (data.filesOnly) {
      const files = r.files ?? []
      out.push('', `## ${r.repo} — ${r.total}${r.truncated ? '+' : ''} file(s)${files.length < r.total ? `, ${files.length} shown` : ''}`)
      for (const f of files) out.push(`${f.file} (${f.count})`)
      continue
    }
    const byFile = new Map<string, GrepRepo['hits']>()
    for (const h of r.hits) byFile.set(h.file, [...(byFile.get(h.file) ?? []), h])
    out.push('', `## ${r.repo} — ${r.total}${r.truncated ? '+' : ''} line(s)${r.hits.length < r.total ? `, ${r.hits.length} shown` : ''}`)
    for (const [file, hits] of byFile) {
      for (const h of hits.slice(0, HITS_PER_FILE)) out.push(`${file}:${h.line}: ${h.text}`)
      if (hits.length > HITS_PER_FILE) out.push(`${file}: … ${hits.length - HITS_PER_FILE} more`)
    }
  }

  const failed = results.filter((r) => r.error)
  if (failed.length) out.push('', `Not searched: ${failed.map((r) => `${r.repo} (${r.error})`).join('; ')}`)
  if (data.notCloned?.length) out.push('', `No checkout on the hub yet: ${data.notCloned.join(', ')}`)
  if (more) out.push('', `More ${data.filesOnly ? 'files' : 'lines'} matched than were listed: narrow with path (e.g. "*.cs") or repo.`)
  if (matched.length && data.filesOnly) out.push('', 'The lines of one: cortex_code_grep(pattern, repo, path: file). Read one with cortex_code_read(repo, file).')
  else if (matched.length) out.push('', 'Read one with cortex_code_read(repo, file, startLine, endLine).')
  return out.join('\n')
}
