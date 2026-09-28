/**
 * Map a caller's unified diff onto the code graph.
 *
 * GitNexus's own detect_changes runs `git diff` in the repository it indexed. On a hub
 * that is the hub's clone, which never holds anyone's uncommitted work, so every
 * pre-commit check from an agent's machine came back "No changes detected" — a clean
 * bill of health for a diff nobody looked at. The agent has the diff; it sends it, and
 * this does what GitNexus does with its own: find the symbols whose line range covers a
 * changed line, then the execution flows those symbols are steps of.
 *
 * The graph was built from the code as it stood before the change, so the diff is read on
 * its old side: old line numbers, old paths. Code the change adds is not in the graph yet;
 * what it can touch is the code around where it is inserted.
 *
 * The graph is reached through GitNexus's read-only cypher tool, injected as runCypher so
 * the mapping can be tested without a graph.
 */

export type LineRange = { start: number; end: number }

export type DiffFiles = {
  /** Old-side line ranges touched, per old path. A deleted file covers every line. */
  changed: Map<string, LineRange[]>
  /** Files the change creates. The graph cannot know them yet. */
  added: string[]
}

export type ChangedSymbol = {
  id: string
  name: string
  type: string
  filePath: string
  startLine: number
  endLine: number
}

export type AffectedProcess = {
  id: string
  name: string
  process_type: string
  step_count: number | null
  changed_steps: Array<{ symbol: string; step: number | null }>
}

export type DiffImpact = {
  summary: {
    changed_count: number
    affected_count: number
    risk_level: 'none' | 'low' | 'medium' | 'high' | 'critical' | 'unknown'
    files: number
    /** Files the change creates: not in the graph until it is pushed and reindexed. */
    new_files: string[]
    /** Changed files with no indexed symbol on a changed line, or not indexed at all. */
    files_without_symbols: string[]
    message?: string
  }
  changed_symbols: ChangedSymbol[]
  affected_processes: AffectedProcess[]
  /** A graph query failed, so the lists are a lower bound and the risk is unknown. */
  partial?: true
  /** changed_symbols was capped; summary.changed_count is the full count. */
  truncated?: true
}

export type RunCypher = (query: string) => Promise<unknown>

export const MAX_DIFF_CHARS = 2_000_000
const MAX_FILES = 300
const MAX_LISTED_SYMBOLS = 200
const FILE_CONCURRENCY = 6
const ID_BATCH = 100
const WHOLE_FILE: LineRange = { start: 1, end: Number.MAX_SAFE_INTEGER }

/**
 * Old-side line ranges touched by a unified diff, per file. Any context size works:
 * context lines are counted, not marked. A removed line marks itself. An added line has no
 * old number, so an insertion marks the two lines it lands between — unless it replaces
 * removed lines, which already mark the spot.
 *
 * The hunk bodies may be left out — headers and @@ lines only, as
 * `git diff -U0 | grep -E '^(diff |--- |\+\+\+ |@@ )'` prints them — so a large change can
 * be checked without sending every line of it. A hunk with no body marks its header's
 * old-side range instead.
 */
export function parseUnifiedDiff(diff: string): DiffFiles {
  const changed = new Map<string, LineRange[]>()
  const added: string[] = []
  const mark = (file: string, range: LineRange) => {
    const list = changed.get(file) ?? []
    list.push(range)
    changed.set(file, list)
  }

  let oldPath: string | null = null
  // The file hunks belong to, and whether their lines are marked: not for a file the
  // change creates (nothing to find) or deletes (already marked whole).
  let path: string | null = null
  let marking = false
  let oldLine = 0
  let oldLeft = 0
  let newLeft = 0
  let afterRemoval = false
  // The last hunk header's old-side range, until a body line shows the body is there.
  let headerOnly: LineRange | null = null

  const closeHunk = () => {
    if (path && marking && headerOnly) mark(path, headerOnly)
    headerOnly = null
    oldLeft = 0
    newLeft = 0
  }

  for (const raw of diff.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw

    // Inside a hunk the header's counts say how many lines belong to it, so a removed
    // line that happens to read "--- x" is never taken for a file header. Only a line no
    // hunk body can contain — the next header — ends a hunk early: its body was left out.
    if (path && (oldLeft > 0 || newLeft > 0)) {
      if (line.startsWith('@@ ') || line.startsWith('diff ')) {
        closeHunk()
      } else {
        const tag = line[0]
        if (tag === '-') {
          if (marking) mark(path, { start: oldLine, end: oldLine })
          oldLine++
          oldLeft--
          afterRemoval = true
          headerOnly = null
        } else if (tag === '+') {
          if (marking && !afterRemoval) mark(path, { start: Math.max(oldLine - 1, 1), end: oldLine })
          newLeft--
          headerOnly = null
        } else if (tag !== '\\') {
          // Context, including a blank context line whose leading space was stripped. A
          // bare empty line is also what ends the text, so it proves no body on its own.
          if (line !== '') headerOnly = null
          oldLine++
          oldLeft--
          newLeft--
          afterRemoval = false
        }
        continue
      }
    }

    if (line.startsWith('diff ')) {
      closeHunk()
      oldPath = null
      // The `--- `/`+++ ` lines that follow settle the path. When they were cut too —
      // headers trimmed to `diff --git` and `@@` lines — the git header still names the
      // file, as long as both sides agree (a rename needs the lines it left out).
      const sameFile = /^diff --git a\/(.+) b\/\1$/.exec(line)
      path = sameFile ? sameFile[1]! : null
      marking = path !== null
    } else if (line.startsWith('--- ')) {
      oldPath = cleanPath(line.slice(4), 'a/')
    } else if (line.startsWith('+++ ')) {
      closeHunk()
      const newPath = cleanPath(line.slice(4), 'b/')
      if (oldPath === null || oldPath === '/dev/null') {
        path = newPath
        marking = false
        if (newPath !== '/dev/null' && !added.includes(newPath)) added.push(newPath)
      } else {
        path = oldPath
        marking = newPath !== '/dev/null'
        if (!marking) mark(oldPath, WHOLE_FILE)
      }
    } else if (path) {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (hunk) {
        closeHunk()
        const start = Number(hunk[1])
        oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2])
        newLeft = hunk[4] === undefined ? 1 : Number(hunk[4])
        // A hunk that only adds lines names the old line *after which* they go.
        oldLine = start + (oldLeft === 0 ? 1 : 0)
        afterRemoval = false
        headerOnly =
          oldLeft === 0 ? { start: Math.max(start, 1), end: start + 1 } : { start, end: start + oldLeft - 1 }
      }
    }
  }
  closeHunk()

  const merged = new Map<string, LineRange[]>()
  for (const [file, ranges] of changed) merged.set(file, coalesce(ranges))
  return { changed: merged, added: added.filter((f) => !merged.has(f)) }
}

function cleanPath(field: string, prefix: string): string {
  // `--- a/x.ts\t2026-01-01 ...` from a non-git diff carries a timestamp after a tab, and
  // git ends a path that contains a space with a tab too.
  let p = field.split('\t')[0] ?? ''
  if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) p = unquote(p.slice(1, -1))
  if (p.startsWith(prefix)) p = p.slice(prefix.length)
  return p
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }

/** Git C-quotes a path with unusual bytes — "a/caf\303\251.ts" — octal escapes being UTF-8 bytes. */
function unquote(quoted: string): string {
  const chars = Array.from(quoted)
  const bytes: number[] = []
  const encoder = new TextEncoder()
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string
    if (ch === '\\' && i + 1 < chars.length) {
      const octal = /^[0-7]{3}$/.exec(chars.slice(i + 1, i + 4).join(''))
      if (octal) {
        bytes.push(parseInt(octal[0], 8))
        i += 3
        continue
      }
      const code = ESCAPES[chars[i + 1] as string]
      if (code !== undefined) {
        bytes.push(code)
        i++
        continue
      }
    }
    bytes.push(...encoder.encode(ch))
  }
  return new TextDecoder().decode(Uint8Array.from(bytes))
}

function coalesce(ranges: LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const out: LineRange[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end)
    else out.push({ ...r })
  }
  return out
}

/** Cypher string literal. Paths come from the caller's diff, so nothing is interpolated raw. */
function lit(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Rows from GitNexus's cypher tool. It answers with HTTP 200 whatever happened, as text
 * with a "---\nNext:" footer: a JSON {markdown, row_count} table, the sentence "Query
 * returned 0 rows.", or "Error: ...". A failed query must never read as an empty result —
 * that is exactly the false all-clear this module exists to remove — so anything that is
 * not a table or the zero-rows sentence throws. Cells are read by column name and empty
 * cells are kept, so a null never shifts the columns after it.
 */
export function parseCypherTable(result: unknown): Array<Record<string, string>> {
  let payload: unknown = result
  const raw = (result as { raw?: unknown } | null)?.raw
  if (typeof raw === 'string') {
    const end = raw.indexOf('\n---')
    const body = (end >= 0 ? raw.slice(0, end) : raw).trim()
    if (/^Query returned 0 rows\b/.test(body)) return []
    try {
      payload = JSON.parse(body)
    } catch {
      throw new Error(body.split('\n')[0] || 'Empty answer from the graph')
    }
  }
  const md = (payload as { markdown?: unknown } | null)?.markdown
  if (typeof md !== 'string') {
    if ((payload as { row_count?: unknown } | null)?.row_count === 0) return []
    const error = (payload as { error?: unknown } | null)?.error
    throw new Error(typeof error === 'string' ? error : 'Unrecognised answer from the graph')
  }

  const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
  const lines = md.split('\n').filter((l) => l.trim().startsWith('|'))
  const header = lines[0] ? cells(lines[0]) : []
  return lines
    .slice(1)
    .filter((l) => !/^\|\s*-{3,}/.test(l.trim()))
    .map((l) => {
      const values = cells(l)
      return Object.fromEntries(header.map((h, i) => [h, values[i] ?? '']))
    })
}

const toInt = (v: string | undefined): number | null => {
  const n = Number(v)
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : null
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i] as T)
    }
  })
  await Promise.all(workers)
  return out
}

function riskOf(processCount: number): DiffImpact['summary']['risk_level'] {
  if (processCount === 0) return 'low'
  if (processCount <= 5) return 'medium'
  if (processCount <= 15) return 'high'
  return 'critical'
}

/** Same thresholds as GitNexus's detect_changes, so the two read the same. */
export async function analyzeDiff(diff: string, runCypher: RunCypher): Promise<DiffImpact> {
  const parsed = parseUnifiedDiff(diff)
  // A path with a control character cannot be a real file, and has no business in a query.
  const sane = (f: string) => f.length > 0 && !/[\u0000-\u001f]/.test(f)
  const files = [...parsed.changed.keys()].filter(sane)
  const newFiles = parsed.added.filter(sane)

  if (files.length === 0) {
    const unparsed = newFiles.length === 0 && diff.trim().length > 0
    return {
      summary: {
        changed_count: 0,
        affected_count: 0,
        // Only new files: nothing that exists yet is touched.
        risk_level: unparsed ? 'unknown' : newFiles.length > 0 ? 'low' : 'none',
        files: newFiles.length,
        new_files: newFiles,
        files_without_symbols: [],
        message: unparsed
          ? 'No file headers recognised in the diff. Pass the output of `git diff --staged` or `git diff HEAD` as it is.'
          : newFiles.length > 0
            ? 'The change only adds files, so no indexed code is touched.'
            : 'The diff is empty: nothing to analyze.',
      },
      changed_symbols: [],
      affected_processes: [],
      ...(unparsed && { partial: true as const }),
    }
  }

  let partial = files.length > MAX_FILES
  const scanned = files.slice(0, MAX_FILES)

  const perFile = await mapLimit(scanned, FILE_CONCURRENCY, async (file) => {
    const ranges = parsed.changed.get(file) ?? []
    const lo = ranges[0]?.start ?? 1
    const hi = ranges[ranges.length - 1]?.end ?? lo
    const query =
      `MATCH (n) WHERE (n.filePath = ${lit(file)} OR n.filePath ENDS WITH ${lit(`/${file}`)}) ` +
      `AND n.startLine IS NOT NULL AND n.endLine IS NOT NULL ` +
      `AND n.startLine <= ${hi} AND n.endLine >= ${lo} AND NOT n.id STARTS WITH "BasicBlock:" ` +
      `RETURN n.id AS id, n.name AS name, labels(n) AS type, n.filePath AS filePath, ` +
      `n.startLine AS startLine, n.endLine AS endLine ORDER BY n.startLine LIMIT 2000`
    try {
      const rows = parseCypherTable(await runCypher(query))
      // Prefer the exact path; a suffix match only stands in when the index root differs.
      const exact = rows.filter((r) => r.filePath === file)
      const hits = (exact.length > 0 ? exact : rows).filter((r) => {
        const start = toInt(r.startLine)
        const end = toInt(r.endLine)
        return start !== null && end !== null && ranges.some((g) => start <= g.end && end >= g.start)
      })
      return { file, hits, failed: false }
    } catch {
      return { file, hits: [] as Array<Record<string, string>>, failed: true }
    }
  })

  const changed = new Map<string, ChangedSymbol>()
  const withoutSymbols: string[] = []
  for (const { file, hits, failed } of perFile) {
    if (failed) partial = true
    else if (hits.length === 0) withoutSymbols.push(file)
    for (const r of hits) {
      if (!r.id || changed.has(r.id)) continue
      changed.set(r.id, {
        id: r.id,
        name: r.name ?? r.id,
        type: r.type ?? '',
        filePath: r.filePath ?? file,
        startLine: toInt(r.startLine) ?? 0,
        endLine: toInt(r.endLine) ?? 0,
      })
    }
  }

  const processes = new Map<string, AffectedProcess>()
  const ids = [...changed.keys()]
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const batch = ids.slice(i, i + ID_BATCH)
    const query =
      `MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process) WHERE n.id IN [${batch.map(lit).join(', ')}] ` +
      `RETURN n.id AS nodeId, p.id AS pid, p.heuristicLabel AS label, p.processType AS processType, ` +
      `p.stepCount AS stepCount, r.step AS step`
    try {
      for (const r of parseCypherTable(await runCypher(query))) {
        if (!r.pid) continue
        const proc = processes.get(r.pid) ?? {
          id: r.pid,
          name: r.label || r.pid,
          process_type: r.processType ?? '',
          step_count: toInt(r.stepCount),
          changed_steps: [],
        }
        proc.changed_steps.push({ symbol: changed.get(r.nodeId ?? '')?.name ?? r.nodeId ?? '', step: toInt(r.step) })
        processes.set(r.pid, proc)
      }
    } catch {
      partial = true
    }
  }

  const symbols = [...changed.values()].sort(
    (a, b) => a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine,
  )
  return {
    summary: {
      changed_count: changed.size,
      affected_count: processes.size,
      risk_level: partial ? 'unknown' : riskOf(processes.size),
      files: files.length + newFiles.length,
      new_files: newFiles,
      files_without_symbols: withoutSymbols,
      ...(partial && {
        message:
          files.length > MAX_FILES
            ? `Only the first ${MAX_FILES} of ${files.length} files were analyzed; split the change to see all of it.`
            : 'A graph query failed, so this is a lower bound. Re-run before treating the change as safe.',
      }),
    },
    changed_symbols: symbols.slice(0, MAX_LISTED_SYMBOLS),
    affected_processes: [...processes.values()],
    ...(partial && { partial: true as const }),
    ...(symbols.length > MAX_LISTED_SYMBOLS && { truncated: true as const }),
  }
}
