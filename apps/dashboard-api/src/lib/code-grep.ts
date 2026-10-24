import { spawn } from 'child_process'

// An exact string over the hub's checkouts of an organization's repos. The semantic search ranks
// chunks by meaning, and a literal it was asked for — an opcode, a constant, an error text — is
// not a meaning: in the agent benchmark it missed a `case 144:` in a 21k-line file and an opcode
// table that a grep finds at once. The agent can grep its own checkout; the repos beside it are
// only on the hub.

export interface GrepHit { file: string; line: number; text: string }
export interface GrepFile { file: string; count: number }
export interface GrepResult { hits: GrepHit[]; files: GrepFile[]; truncated: boolean }

export interface GrepOptions {
  ignoreCase?: boolean
  /** The pattern is a plain string, not a regular expression. */
  fixed?: boolean
  /** Git pathspecs, e.g. "*.cs" or "src/". */
  paths?: string[]
  /** Name each matching file with its count of matching lines, as `grep -l` does, instead of listing lines. */
  filesOnly?: boolean
  timeoutMs?: number
  /** Output read before the search is stopped. */
  maxBytes?: number
}

/** A line is cut here: a minified file has lines of hundreds of kilobytes. */
export const MAX_LINE_CHARS = 240

/** `git grep -n -z` output: path NUL line NUL text, one hit per line. A cut-off last line is dropped. */
export function parseGrepOutput(stdout: string, complete: boolean): GrepHit[] {
  const lines = stdout.split('\n')
  if (!complete || lines[lines.length - 1] === '') lines.pop()
  const hits: GrepHit[] = []
  for (const raw of lines) {
    const first = raw.indexOf('\0')
    const second = first < 0 ? -1 : raw.indexOf('\0', first + 1)
    if (second < 0) continue
    const line = Number(raw.slice(first + 1, second))
    if (!Number.isInteger(line)) continue
    const text = raw.slice(second + 1).trim()
    hits.push({ file: raw.slice(0, first), line, text: text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS - 1)}…` : text })
  }
  return hits
}

/** `git grep -c -z` output: path NUL count, one file per line. A cut-off last line is dropped. */
export function parseGrepCounts(stdout: string, complete: boolean): GrepFile[] {
  const lines = stdout.split('\n')
  if (!complete || lines[lines.length - 1] === '') lines.pop()
  const files: GrepFile[] = []
  for (const raw of lines) {
    const sep = raw.indexOf('\0')
    const count = Number(raw.slice(sep + 1))
    if (sep > 0 && Number.isInteger(count)) files.push({ file: raw.slice(0, sep), count })
  }
  return files
}

/** The arguments for one search; `-e` keeps a pattern that starts with "-" from being read as an option. */
export function grepArgs(pattern: string, syntax: '-P' | '-E' | '-F', opts: GrepOptions): string[] {
  return [
    'grep', opts.filesOnly ? '-c' : '-n', '-z', '-I', '--no-color', '--full-name', syntax,
    ...(opts.ignoreCase ? ['-i'] : []),
    '-e', pattern, '--', ...(opts.paths ?? []),
  ]
}

function run(dir: string, args: string[], timeoutMs: number, maxBytes: number): Promise<{ code: number | null; stdout: string; stderr: string; cut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let size = 0
    let stderr = ''
    let cut = false
    const stop = () => { cut = true; child.kill('SIGKILL') }
    const timer = setTimeout(stop, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      if (cut) return
      out.push(chunk)
      size += chunk.length
      if (size >= maxBytes) stop()
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8') })
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: Buffer.concat(out).subarray(0, maxBytes).toString('utf-8'), stderr, cut })
    })
  })
}

/**
 * Search one checkout's tracked files. Perl syntax first — `\d`, `\b` and lookarounds are what an
 * agent writes — and POSIX extended syntax where git was built without PCRE.
 */
export async function grepCheckout(dir: string, pattern: string, opts: GrepOptions = {}): Promise<GrepResult> {
  const timeoutMs = opts.timeoutMs ?? 8000
  const maxBytes = opts.maxBytes ?? 512 * 1024
  const syntaxes: Array<'-P' | '-E' | '-F'> = opts.fixed ? ['-F'] : ['-P', '-E']
  for (const syntax of syntaxes) {
    const res = await run(dir, grepArgs(pattern, syntax, opts), timeoutMs, maxBytes)
    // 1 is "no line matched".
    const complete = res.code === 0 || (res.code === 1 && !res.stderr.trim())
    if (res.cut || complete) {
      return opts.filesOnly
        ? { hits: [], files: parseGrepCounts(res.stdout, !res.cut), truncated: res.cut }
        : { hits: parseGrepOutput(res.stdout, !res.cut), files: [], truncated: res.cut }
    }
    if (syntax === '-P' && /perl|pcre/i.test(res.stderr)) continue
    throw new Error(res.stderr.trim().split('\n')[0] || `git grep exited with ${res.code}`)
  }
  return { hits: [], files: [], truncated: false }
}
