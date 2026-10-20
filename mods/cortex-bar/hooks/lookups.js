// Which native searches a cortex lookup could have answered. Pure, like model.js: the mod
// counts them as they run, scripts/lookup-audit.mjs over past transcripts. Every kind is a
// guess from the command alone, so the numbers it feeds are estimates.

/**
 * @typedef {'symbol' | 'word' | 'literal' | 'in-file' | 'find-file' | 'non-code'} LookupKind
 * @typedef {{ argv: string[], piped: boolean }} ShellCommand
 * @typedef {{ cortex: number, native: Record<string, number>, fallback: number, since: Record<string, number> }} LookupCounts
 * @typedef {{ cortex: number, addressable: number, share: number | null }} LookupShare
 */

/**
 * The kinds, in the order the pane lists them. `addressable`: a cortex lookup answers it
 * (code_context a symbol, code_search a word or a regex); the rest are rg's or find's job.
 * @type {{ id: LookupKind, label: string, addressable: boolean, answer: string }[]}
 */
export const LOOKUP_KINDS = [
  { id: 'symbol', label: 'symbol', addressable: true, answer: 'code_context could answer' },
  { id: 'word', label: 'word or regex', addressable: true, answer: 'code_search could answer' },
  { id: 'literal', label: 'literal', addressable: false, answer: 'rg is right' },
  { id: 'in-file', label: 'in known files', addressable: false, answer: 'rg is right' },
  { id: 'find-file', label: 'file by name', addressable: false, answer: 'find or Glob is right' },
  { id: 'non-code', label: 'not repo code', addressable: false, answer: 'logs, tmp, other dirs' },
]

/** A grep this many tool calls after a cortex lookup, in the same loop, is a fallback. */
export const FALLBACK_WINDOW = 3

const SEARCH_TOOLS = ['rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack']
const FIND_TOOLS = ['find', 'fd', 'fdfind', 'locate']
/** Words before the command itself: `if rg …`, `env X=1 rg …`, `time rg …`. */
const PREFIXES = ['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{']
const WRAPPERS = ['command', 'builtin', 'exec', 'env', 'time', 'nice', 'noglob', 'sudo']
/** Search options that take the next word as their value. */
const TAKES_ARG = [
  '-e',
  '-f',
  '-g',
  '-t',
  '-T',
  '-m',
  '-A',
  '-B',
  '-C',
  '-d',
  '-D',
  '-j',
  '-M',
  '--regexp',
  '--file',
  '--glob',
  '--iglob',
  '--type',
  '--type-not',
  '--max-count',
  '--max-depth',
  '--max-columns',
  '--threads',
  '--sort',
  '--sortr',
  '--include',
  '--exclude',
  '--exclude-dir',
  '--context',
  '--after-context',
  '--before-context',
]
/** Not code in this repo: temp and system dirs, transcripts, logs, dependencies, stdin. */
const NON_CODE =
  /^-$|^\/tmp\/|^\/private\/|^\/var\/|scratchpad|\.claude\/projects|node_modules|\.(log|jsonl|csv|output)$/
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/
/** A file, not a dir: a name with an extension after at least one other character. */
const FILE_NAME = /.\.[A-Za-z0-9]+$/

/**
 * The simple commands in a shell line, each with whether a pipe feeds it. Quotes and
 * backslashes are read the way the shell reads them, redirections and their targets are
 * dropped, and heredoc bodies are skipped. An unterminated quote gives nothing.
 * @param {string} command
 * @returns {ShellCommand[]}
 */
export function shellCommands(command) {
  /** @type {ShellCommand[]} */
  const out = []
  /** @type {string[]} */
  let argv = []
  let piped = false
  /** @type {string | null} */
  let word = null
  let dropNext = false
  /** @type {boolean | null} the next word is a heredoc delimiter; true for `<<-` */
  let delimiterNext = null
  /** @type {{ delimiter: string, tabs: boolean }[]} */
  let heredocs = []

  const flushWord = () => {
    if (word === null) return
    if (delimiterNext !== null) heredocs.push({ delimiter: word, tabs: delimiterNext })
    else if (!dropNext) argv.push(word)
    delimiterNext = null
    dropNext = false
    word = null
  }
  /** @param {string} separator */
  const endCommand = (separator) => {
    flushWord()
    if (argv.length > 0) out.push({ argv, piped })
    argv = []
    piped = separator === '|' || separator === '|&'
  }

  const s = command
  let i = 0
  while (i < s.length) {
    const c = s[i] ?? ''
    const next = s[i + 1] ?? ''
    if (c === "'") {
      const close = s.indexOf("'", i + 1)
      if (close === -1) return []
      word = (word ?? '') + s.slice(i + 1, close)
      i = close + 1
    } else if (c === '"') {
      let j = i + 1
      let text = ''
      while (j < s.length && s[j] !== '"') {
        const after = s[j + 1] ?? ''
        if (s[j] === '\\' && '"\\$`\n'.includes(after) && after !== '') {
          if (after !== '\n') text += after
          j += 2
        } else {
          text += s[j]
          j += 1
        }
      }
      if (j >= s.length) return []
      word = (word ?? '') + text
      i = j + 1
    } else if (c === '\\') {
      if (next !== '\n' && next !== '') word = (word ?? '') + next
      i += 2
    } else if (c === ' ' || c === '\t') {
      flushWord()
      i += 1
    } else if (c === '#' && word === null) {
      while (i < s.length && s[i] !== '\n') i += 1
    } else if (c === '\n') {
      endCommand('\n')
      i += 1
      for (const { delimiter, tabs } of heredocs) {
        for (;;) {
          if (i >= s.length) return out
          const end = s.indexOf('\n', i)
          const line = s.slice(i, end === -1 ? s.length : end)
          i = end === -1 ? s.length : end + 1
          if ((tabs ? line.replace(/^\t+/, '') : line) === delimiter) break
        }
      }
      heredocs = []
    } else if ((c === '<' || c === '>') && next === '(') {
      endCommand('(')
      i += 2
    } else if (c === '$' && next === '(') {
      endCommand('(')
      i += 2
    } else if (c === '<' || c === '>' || (c === '&' && next === '>')) {
      // `2>` names a file descriptor, not an argument; `x>` ends the word x.
      if (word !== null && /^\d+$/.test(word)) word = null
      flushWord()
      if (c === '&') i += 1
      const op = /^(<<<|<<-|<<|>>|>\||<>|<&|>&|<|>)/.exec(s.slice(i))?.[0] ?? c
      i += op.length
      if (op === '<<' || op === '<<-') {
        delimiterNext = op === '<<-'
      } else if (op === '<&' || op === '>&') {
        const fd = /^[0-9-]+/.exec(s.slice(i))?.[0]
        if (fd) i += fd.length
        else dropNext = true
      } else {
        dropNext = true
      }
    } else if ('|&;()'.includes(c)) {
      const op = ['||', '|&', '&&', ';;'].find((two) => s.startsWith(two, i)) ?? c
      endCommand(op)
      i += op.length
    } else {
      word = (word ?? '') + c
      i += 1
    }
  }
  endCommand(';')
  return out
}

/**
 * The command without the words before it: keywords, wrappers and `VAR=value`.
 * @param {string[]} argv
 */
function withoutPrefix(argv) {
  let i = 0
  for (;;) {
    const arg = argv[i]
    if (arg === undefined) return []
    if (PREFIXES.includes(arg) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
      i += 1
    } else if (WRAPPERS.includes(arg)) {
      i += 1
      while (argv[i]?.startsWith('-')) i += 1
    } else {
      return argv.slice(i)
    }
  }
}

/**
 * A search's pattern and the paths it searches. Several `-e` are one alternation.
 * @param {string[]} args the words after the command
 */
function patternAndTargets(args) {
  /** @type {string[]} */
  const patterns = []
  /** @type {string[]} */
  const positional = []
  let options = true
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? ''
    if (options && arg === '--') {
      options = false
    } else if (options && TAKES_ARG.includes(arg)) {
      if (arg === '-e' || arg === '--regexp') patterns.push(args[i + 1] ?? '')
      i += 1
    } else if (options && arg.startsWith('--regexp=')) {
      patterns.push(arg.slice('--regexp='.length))
    } else if (!(options && arg.startsWith('-') && arg !== '-')) {
      positional.push(arg)
    }
  }
  if (patterns.length > 0) return { pattern: patterns.join('|'), targets: positional }
  return { pattern: positional[0] ?? '', targets: positional.slice(1) }
}

/**
 * @param {string} path
 * @param {string} root
 */
function outsideRepo(path, root) {
  if (NON_CODE.test(path) || path === '..' || path.startsWith('../')) return true
  if (!path.startsWith('/') || root === '') return false
  return path !== root && !path.startsWith(root + '/')
}

/** @param {string} path */
function isFile(path) {
  if (/[*?[{$]/.test(path)) return false
  return FILE_NAME.test(path.slice(path.lastIndexOf('/') + 1))
}

/**
 * What a pattern looks for. A symbol: every alternative an identifier and one shaped like
 * code (camelCase, snake_case, PascalCase). A literal: an UPPER_SNAKE name, or text with a
 * space, a quote, `:`, `=` or `/`. Anything else is a word or a regex.
 * @param {string} pattern
 * @returns {LookupKind}
 */
export function patternKind(pattern) {
  if (pattern === '') return 'literal'
  const bare = pattern.replace(/\\[b<>]/g, '').replace(/[()]/g, '')
  const alternatives = bare.split(/\\\||\|/).filter((part) => part !== '')
  /** @param {string} name */
  const shaped = (name) =>
    /[a-z][A-Z]|[a-z]_[a-z]|^[A-Z][a-z]+[A-Z]/.test(name) || /^[A-Z].*[a-z]/.test(name)
  if (
    alternatives.length > 0 &&
    alternatives.every((part) => IDENTIFIER.test(part)) &&
    alternatives.some(shaped)
  ) {
    return 'symbol'
  }
  if (/[A-Z][A-Z0-9]*_[A-Z0-9_]+/.test(pattern) || /[\s"':=/]/.test(pattern)) return 'literal'
  return 'word'
}

/**
 * @param {string} pattern
 * @param {string[]} targets
 * @param {string} root
 * @returns {LookupKind}
 */
function contentKind(pattern, targets, root) {
  if (targets.length > 0 && targets.every((target) => outsideRepo(target, root))) {
    return 'non-code'
  }
  if (targets.length > 0 && targets.every(isFile)) return 'in-file'
  return patternKind(pattern)
}

/**
 * @param {string[]} argv a command without its prefix
 * @param {string} root
 * @returns {LookupKind | null}
 */
function commandKind(argv, root) {
  const [path = '', ...rest] = argv
  let name = path.slice(path.lastIndexOf('/') + 1)
  let args = rest
  if (name === 'git') {
    let i = 0
    while (args[i]?.startsWith('-')) i += args[i] === '-C' || args[i] === '-c' ? 2 : 1
    if (args[i] === 'ls-files') return 'find-file'
    if (args[i] !== 'grep') return null
    name = 'grep'
    args = args.slice(i + 1)
  }
  if (FIND_TOOLS.includes(name)) return 'find-file'
  if (!SEARCH_TOOLS.includes(name)) return null
  if (args.includes('--files')) return 'find-file'
  const { pattern, targets } = patternAndTargets(args)
  return contentKind(pattern, targets, root)
}

/**
 * The first search a shell line runs itself. One fed by a pipe filters another command's
 * output, so it is not a lookup.
 * @param {string} command
 * @param {string} [root] the project root; a path outside it is not repo code
 * @returns {LookupKind | null}
 */
export function bashLookupKind(command, root = '') {
  for (const { argv, piped } of shellCommands(command)) {
    if (piped) continue
    const kind = commandKind(withoutPrefix(argv), root)
    if (kind !== null) return kind
  }
  return null
}

/**
 * @param {Record<string, unknown>} input the tool's arguments
 * @param {string} [root]
 * @returns {LookupKind}
 */
export function grepLookupKind(input, root = '') {
  const pattern = typeof input.pattern === 'string' ? input.pattern : ''
  const path = typeof input.path === 'string' && input.path !== '' ? [input.path] : []
  return contentKind(pattern, path, root)
}

/**
 * What a tool call looked for, or null for one that is not a native lookup.
 * @param {string} tool
 * @param {Record<string, unknown>} input the tool's arguments
 * @param {string} [root]
 * @returns {LookupKind | null}
 */
export function lookupKindOf(tool, input, root = '') {
  if (tool === 'Bash') {
    return typeof input.command === 'string' ? bashLookupKind(input.command, root) : null
  }
  if (tool === 'Grep') return grepLookupKind(input, root)
  if (tool === 'Glob') return 'find-file'
  return null
}

/** @returns {LookupCounts} */
export function emptyLookupCounts() {
  return { cortex: 0, native: {}, fallback: 0, since: {} }
}

/** @param {string | null} kind */
function addressable(kind) {
  return LOOKUP_KINDS.some((k) => k.id === kind && k.addressable)
}

/**
 * The counts after one more tool call. `cortex` for a cortex code lookup, `kind` for a
 * native one; any other call only moves the fallback window of its loop. Returns the same
 * object when nothing changed.
 * @param {LookupCounts} counts
 * @param {{ agent?: string, cortex?: boolean, kind?: LookupKind | null }} call
 * @returns {LookupCounts}
 */
export function countTool(counts, { agent = '', cortex = false, kind = null }) {
  if (cortex) {
    return { ...counts, cortex: counts.cortex + 1, since: { ...counts.since, [agent]: 0 } }
  }
  const before = counts.since[agent]
  if (kind === null && before === undefined) return counts
  const step = before === undefined ? undefined : before + 1
  const since = { ...counts.since }
  if (step === undefined || step >= FALLBACK_WINDOW) delete since[agent]
  else since[agent] = step
  const fallback = step !== undefined && step <= FALLBACK_WINDOW && addressable(kind)
  return {
    cortex: counts.cortex,
    native: kind === null ? counts.native : { ...counts.native, [kind]: (counts.native[kind] ?? 0) + 1 },
    fallback: counts.fallback + (fallback ? 1 : 0),
    since,
  }
}

/**
 * Cortex lookups against the greps a cortex lookup could have answered. `share` is null
 * until there is either.
 * @param {LookupCounts} counts
 * @returns {LookupShare}
 */
export function lookupShare(counts) {
  const could = LOOKUP_KINDS.filter((kind) => kind.addressable).reduce(
    (sum, kind) => sum + (counts.native[kind.id] ?? 0),
    0,
  )
  const all = counts.cortex + could
  return { cortex: counts.cortex, addressable: could, share: all === 0 ? null : counts.cortex / all }
}

/** @param {number} share a fraction */
export function formatShare(share) {
  const percent = share * 100
  return (percent > 0 && percent < 1 ? '<1' : String(Math.round(percent))) + '%'
}
