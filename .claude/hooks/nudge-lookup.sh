#!/bin/bash
# Cortex Lookup Nudge (v1) — a reminder, never a block, when a grep is a cortex question.
#
# The session gate only makes an agent call cortex once: after the first discovery call it
# greps freely, and measured over real sessions (mods/cortex-bar/scripts/lookup-audit.mjs)
# cortex answered 3–9% of the searches it could have answered, least of all in subagents.
# This hook reads what a search looks for. A repo-wide search for a symbol or a word gets
# one line of context naming the cortex call that answers it; the search itself still runs,
# since a refused call costs the agent a whole request to recover from.
#
# It stays quiet for literals (env vars, config keys, error strings), for searches in known
# files or outside the repo, and for file-name searches: grep and find are right for those.
# It also stays quiet right after a cortex lookup, when the grep is the agent checking what
# cortex did not answer, and nudges each agent at most once every NUDGE_EVERY searches.
#
# CORTEX_NUDGE=off turns it off; so does gate-off, since the hub it points at is down. It is
# JavaScript in a shell file so the installers can ship it like every other hook; without
# node it does nothing.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"

[ "${CORTEX_NUDGE:-}" = "off" ] && exit 0
[ -s "$STATE_DIR/gate-off" ] && exit 0
command -v node >/dev/null 2>&1 || exit 0

# read, not $(cat << …): bash 3.2, macOS's own, misparses quotes in a heredoc inside $( ).
IFS= read -r -d '' NUDGE_JS << 'NUDGEJS' || true
const fs = require('fs')
const path = require('path')

/** Searches between two nudges to one agent. */
const NUDGE_EVERY = 5
/** A search this many calls after a cortex lookup is checking its answer: no nudge. */
const AFTER_LOOKUP = 3
const LOOKUP = /cortex_(code_search|code_context|code_impact|cypher)$/

const SEARCH_TOOLS = ['rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack']
const FIND_TOOLS = ['find', 'fd', 'fdfind', 'locate']
const PREFIXES = ['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{']
const WRAPPERS = ['command', 'builtin', 'exec', 'env', 'time', 'nice', 'noglob', 'sudo']
const TAKES_ARG = ['-e', '-f', '-g', '-t', '-T', '-m', '-A', '-B', '-C', '-d', '-D', '-j', '-M',
  '--regexp', '--file', '--glob', '--iglob', '--type', '--type-not', '--max-count', '--max-depth',
  '--max-columns', '--threads', '--sort', '--sortr', '--include', '--exclude', '--exclude-dir',
  '--context', '--after-context', '--before-context']
const NON_CODE = /^-$|^\/tmp\/|^\/private\/|^\/var\/|scratchpad|\.claude\/projects|node_modules|\.(log|jsonl|csv|output)$/
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const FILE_NAME = /.\.[A-Za-z0-9]+$/

// The simple commands in a shell line, each with whether a pipe feeds it: quotes and
// backslashes read as the shell reads them, redirections and heredoc bodies dropped.
// The same reading as mods/cortex-bar/hooks/lookups.js, which the audit counts with.
function shellCommands(s) {
  const out = []
  let argv = []
  let piped = false
  let word = null
  let dropNext = false
  let delimiterNext = null
  let heredocs = []
  const flushWord = () => {
    if (word === null) return
    if (delimiterNext !== null) heredocs.push({ delimiter: word, tabs: delimiterNext })
    else if (!dropNext) argv.push(word)
    delimiterNext = null
    dropNext = false
    word = null
  }
  const endCommand = (separator) => {
    flushWord()
    if (argv.length > 0) out.push({ argv, piped })
    argv = []
    piped = separator === '|' || separator === '|&'
  }
  let i = 0
  while (i < s.length) {
    const c = s[i]
    const next = s[i + 1] || ''
    if (c === "'") {
      const close = s.indexOf("'", i + 1)
      if (close === -1) return []
      word = (word || '') + s.slice(i + 1, close)
      i = close + 1
    } else if (c === '"') {
      let j = i + 1
      let text = ''
      while (j < s.length && s[j] !== '"') {
        const after = s[j + 1] || ''
        if (s[j] === '\\' && after !== '' && '"\\$`\n'.includes(after)) {
          if (after !== '\n') text += after
          j += 2
        } else {
          text += s[j]
          j += 1
        }
      }
      if (j >= s.length) return []
      word = (word || '') + text
      i = j + 1
    } else if (c === '\\') {
      if (next !== '\n' && next !== '') word = (word || '') + next
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
    } else if ((c === '<' || c === '>' || c === '$') && next === '(') {
      endCommand('(')
      i += 2
    } else if (c === '<' || c === '>' || (c === '&' && next === '>')) {
      if (word !== null && /^\d+$/.test(word)) word = null
      flushWord()
      if (c === '&') i += 1
      const op = (/^(<<<|<<-|<<|>>|>\||<>|<&|>&|<|>)/.exec(s.slice(i)) || [c])[0]
      i += op.length
      if (op === '<<' || op === '<<-') {
        delimiterNext = op === '<<-'
      } else if (op === '<&' || op === '>&') {
        const fd = /^[0-9-]+/.exec(s.slice(i))
        if (fd) i += fd[0].length
        else dropNext = true
      } else {
        dropNext = true
      }
    } else if ('|&;()'.includes(c)) {
      const op = ['||', '|&', '&&', ';;'].find((two) => s.startsWith(two, i)) || c
      endCommand(op)
      i += op.length
    } else {
      word = (word || '') + c
      i += 1
    }
  }
  endCommand(';')
  return out
}

function withoutPrefix(argv) {
  let i = 0
  for (;;) {
    const arg = argv[i]
    if (arg === undefined) return []
    if (PREFIXES.includes(arg) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
      i += 1
    } else if (WRAPPERS.includes(arg)) {
      i += 1
      while (argv[i] && argv[i].startsWith('-')) i += 1
    } else {
      return argv.slice(i)
    }
  }
}

function patternAndTargets(args) {
  const patterns = []
  const positional = []
  let options = true
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (options && arg === '--') {
      options = false
    } else if (options && TAKES_ARG.includes(arg)) {
      if (arg === '-e' || arg === '--regexp') patterns.push(args[i + 1] || '')
      i += 1
    } else if (options && arg.startsWith('--regexp=')) {
      patterns.push(arg.slice('--regexp='.length))
    } else if (!(options && arg.startsWith('-') && arg !== '-')) {
      positional.push(arg)
    }
  }
  if (patterns.length > 0) return { pattern: patterns.join('|'), targets: positional }
  return { pattern: positional[0] || '', targets: positional.slice(1) }
}

function outsideRepo(target, root) {
  if (NON_CODE.test(target) || target === '..' || target.startsWith('../')) return true
  if (!target.startsWith('/') || root === '') return false
  return target !== root && !target.startsWith(root + '/')
}

function isFile(target) {
  if (/[*?[{$]/.test(target)) return false
  return FILE_NAME.test(target.slice(target.lastIndexOf('/') + 1))
}

// A symbol: every alternative an identifier, one of them shaped like code. A literal: an
// UPPER_SNAKE name or text with a space, quote, `:`, `=` or `/`. Anything else is a word.
function alternativesOf(pattern) {
  const bare = pattern.replace(/\\[b<>]/g, '').replace(/[()]/g, '')
  return bare.split(/\\\||\|/).filter((part) => part !== '')
}
const shaped = (name) => /[a-z][A-Z]|[a-z]_[a-z]|^[A-Z][a-z]+[A-Z]/.test(name) || /^[A-Z].*[a-z]/.test(name)

function patternKind(pattern) {
  if (pattern === '') return 'literal'
  const alternatives = alternativesOf(pattern)
  if (alternatives.length > 0 && alternatives.every((part) => IDENTIFIER.test(part)) && alternatives.some(shaped)) {
    return 'symbol'
  }
  if (/[A-Z][A-Z0-9]*_[A-Z0-9_]+/.test(pattern) || /[\s"':=/]/.test(pattern)) return 'literal'
  return 'word'
}

function contentKind(pattern, targets, root) {
  if (targets.length > 0 && targets.every((target) => outsideRepo(target, root))) return 'non-code'
  if (targets.length > 0 && targets.every(isFile)) return 'in-file'
  return patternKind(pattern)
}

function commandSearch(argv, root) {
  const [program = '', ...rest] = argv
  let name = program.slice(program.lastIndexOf('/') + 1)
  let args = rest
  if (name === 'git') {
    let i = 0
    while (args[i] && args[i].startsWith('-')) i += args[i] === '-C' || args[i] === '-c' ? 2 : 1
    if (args[i] === 'ls-files') return { kind: 'find-file', pattern: '' }
    if (args[i] !== 'grep') return null
    name = 'grep'
    args = args.slice(i + 1)
  }
  if (FIND_TOOLS.includes(name)) return { kind: 'find-file', pattern: '' }
  if (!SEARCH_TOOLS.includes(name)) return null
  if (args.includes('--files')) return { kind: 'find-file', pattern: '' }
  const { pattern, targets } = patternAndTargets(args)
  return { kind: contentKind(pattern, targets, root), pattern }
}

function searchOf(tool, input, root) {
  if (tool === 'Grep') {
    const pattern = typeof input.pattern === 'string' ? input.pattern : ''
    const targets = typeof input.path === 'string' && input.path !== '' ? [input.path] : []
    return { kind: contentKind(pattern, targets, root), pattern }
  }
  if (tool !== 'Bash' || typeof input.command !== 'string') return null
  for (const { argv, piped } of shellCommands(input.command)) {
    if (piped) continue
    const search = commandSearch(withoutPrefix(argv), root)
    if (search !== null) return search
  }
  return null
}

function nudgeFor({ kind, pattern }) {
  const quoted = JSON.stringify(pattern.length > 80 ? pattern.slice(0, 80) : pattern)
  if (kind === 'symbol') {
    const name = alternativesOf(pattern).find(shaped) || pattern
    return `Cortex: this search is for the symbol ${name}. cortex_code_context(name: ${JSON.stringify(name)}) ` +
      'answers where it is defined, who calls it and what it calls in one call, without reading ' +
      'grep hits. Grep stays right for an exact literal. This search runs either way.'
  }
  return `Cortex: a search for ${quoted} across the repo is a question about the code. ` +
    `cortex_code_search(query: ${quoted}, limit: 10) ranks the files that answer it; read all ten ` +
    'before choosing. Grep stays right for an exact literal. This search runs either way.'
}

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { raw += chunk })
process.stdin.on('end', () => {
  let event
  try { event = JSON.parse(raw) } catch { return }
  const tool = String(event.tool_name || '')
  const agent = [event.session_id, event.agent_id || 'main'].filter(Boolean).join('-')
    .replace(/[^A-Za-z0-9_-]/g, '').slice(0, 160) || 'main'
  const dir = path.join(process.env.STATE_DIR, 'nudge')
  const file = path.join(dir, agent)
  let state = { sinceLookup: null, sinceNudge: null }
  try { state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) } } catch {}
  const save = () => {
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file, JSON.stringify(state))
    } catch {}
  }

  if (LOOKUP.test(tool)) {
    state.sinceLookup = 0
    return save()
  }
  if (state.sinceLookup !== null) state.sinceLookup += 1
  let search = null
  try { search = searchOf(tool, event.tool_input || {}, process.env.PROJECT_DIR || '') } catch {}
  const addressable = search !== null && (search.kind === 'symbol' || search.kind === 'word')
  if (!addressable) return save()
  if (state.sinceNudge !== null) state.sinceNudge += 1
  const checking = state.sinceLookup !== null && state.sinceLookup <= AFTER_LOOKUP
  const recent = state.sinceNudge !== null && state.sinceNudge < NUDGE_EVERY
  if (checking || recent) return save()
  state.sinceNudge = 0
  save()
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: nudgeFor(search) },
  }))
})
NUDGEJS
STATE_DIR="$STATE_DIR" PROJECT_DIR="$PROJECT_DIR" node -e "$NUDGE_JS" 2>/dev/null
exit 0
