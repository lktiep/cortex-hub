#!/usr/bin/env node
// lookup-audit: what cortex-bar would have counted in past sessions, read back from their
// Claude Code transcripts. It prints counts only: no command, path, result or session id
// leaves the transcripts.
//
//   node mods/cortex-bar/scripts/lookup-audit.mjs [--last N] [transcript.jsonl | folder ...]
//
// With no path it reads the sessions of the current directory under ~/.claude/projects:
// the newest N (5 unless --last says, 0 for all), each with its subagents.

import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

// The hooks are ES modules in a folder whose package.json does not say so, which Node warns
// about on every run. Any other warning still prints.
const printWarning = process.listeners('warning')
process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if ('code' in warning && warning.code === 'MODULE_TYPELESS_PACKAGE_JSON') return
  for (const listener of printWarning) listener(warning)
})
const { addCounts, addRecord, emptyTranscript, replay } = await import('./replay.js')
const { LOOKUP_KINDS, emptyLookupCounts, formatShare, lookupShare } = await import('../hooks/lookups.js')
const { LOOKUP_TOOLS, LOOKUP_WINDOW, lookupMetrics } = await import('../hooks/model.js')

/**
 * @typedef {import('./replay.js').ToolAudit} ToolAudit
 * @typedef {import('../hooks/lookups.js').LookupCounts} LookupCounts
 * @typedef {{ started: string, agents: number, calls: number, cortex: number, denied: number, counts: LookupCounts }} SessionRow
 */

const USAGE = 'usage: lookup-audit.mjs [--last N] [transcript.jsonl | folder ...]'

/** @param {string} message */
function fail(message) {
  process.stderr.write(message + '\n')
  process.exit(2)
}

/**
 * The main transcripts in a folder of sessions.
 * @param {string} dir
 */
function sessionsIn(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => join(dir, name))
}

/**
 * A session's subagents: <session id>/subagents/*.jsonl next to its transcript.
 * @param {string} file
 */
function subagentsOf(file) {
  const dir = join(dirname(file), basename(file, '.jsonl'), 'subagents')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => join(dir, name))
}

/** @param {string} file */
async function readTranscript(file) {
  const transcript = emptyTranscript()
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of lines) {
    try {
      addRecord(transcript, JSON.parse(line))
    } catch {
      // A line cut short when the session died is skipped.
    }
  }
  return transcript
}

/** @param {string} iso */
function localTime(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '?'
  /** @param {number} n */
  const two = (n) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ` +
    `${two(date.getHours())}:${two(date.getMinutes())}`
  )
}

/**
 * Left-aligned first column, the rest right-aligned.
 * @param {(string | number)[][]} table the header first
 */
function printTable(table) {
  const columns = (table[0] ?? []).length
  const widths = Array.from({ length: columns }, (_, col) =>
    Math.max(...table.map((row) => String(row[col] ?? '').length)),
  )
  for (const row of table) {
    const cells = row.map((cell, col) =>
      col === 0 ? String(cell).padEnd(widths[col] ?? 0) : String(cell).padStart(widths[col] ?? 0),
    )
    process.stdout.write(cells.join('  ').trimEnd() + '\n')
  }
}

/** @param {SessionRow} row */
function sessionCells(row) {
  const { share } = lookupShare(row.counts)
  const native = row.counts.native
  const other = LOOKUP_KINDS.filter((kind) => !kind.addressable).reduce(
    (sum, kind) => sum + (native[kind.id] ?? 0),
    0,
  )
  return [
    row.started,
    row.agents,
    row.calls,
    row.cortex,
    row.counts.cortex,
    native.symbol ?? 0,
    native.word ?? 0,
    other,
    share === null ? '-' : formatShare(share),
    row.counts.fallback,
  ]
}

/**
 * @param {string} name
 * @param {ToolAudit} audit
 */
function toolCells(name, audit) {
  const answered = audit.calls - audit.errors
  if (!LOOKUP_TOOLS.includes(name)) {
    const ok = audit.judged > 0 ? `${audit.good}/${audit.judged}` : '-'
    return [name, audit.calls, audit.errors, ok, '-', '-', '-', '-', '-', '-']
  }
  const metrics = lookupMetrics(audit.lookups)
  const judged = metrics.used + metrics.missed
  /** @param {number} hits */
  const rate = (hits) => (judged > 0 ? `${hits}/${judged}` : '-')
  return [
    name,
    audit.calls,
    audit.errors,
    `${audit.named}/${answered}`,
    metrics.used,
    metrics.missed,
    metrics.count - metrics.used - metrics.missed,
    rate(metrics.at1),
    rate(metrics.at3),
    rate(metrics.at10),
  ]
}

let last = 5
/** @type {string[]} */
const targets = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i] ?? ''
  if (arg === '-h' || arg === '--help') {
    process.stdout.write(USAGE + '\n')
    process.exit(0)
  } else if (arg === '--last') {
    i += 1
    last = Number(argv[i])
    if (!Number.isInteger(last) || last < 0) fail(USAGE)
  } else {
    targets.push(arg)
  }
}
if (targets.length === 0) {
  targets.push(join(homedir(), '.claude', 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-')))
}

/** @type {string[]} */
const found = []
for (const target of targets) {
  if (!existsSync(target)) fail('lookup-audit: no sessions here (pass a transcript or a folder of them)')
  found.push(...(statSync(target).isDirectory() ? sessionsIn(target) : [target]))
}
const newest = found
  .map((file) => ({ file, mtime: statSync(file).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)
  .slice(0, last > 0 ? last : undefined)
if (newest.length === 0) fail('lookup-audit: no transcripts there')

/** @type {Map<string, ToolAudit>} */
const tools = new Map()
/** @type {Set<string>} */
const offered = new Set()
/** @type {SessionRow[]} */
const rows = []
for (const { file } of newest) {
  const files = [file, ...subagentsOf(file)]
  /** @type {SessionRow} */
  const row = { started: '', agents: files.length, calls: 0, cortex: 0, denied: 0, counts: emptyLookupCounts() }
  for (const each of files) {
    const transcript = await readTranscript(each)
    if (row.started === '') row.started = transcript.started
    for (const name of transcript.offered) offered.add(name)
    const replayed = replay(transcript, tools)
    row.calls += replayed.calls
    row.cortex += replayed.cortex
    row.denied += replayed.denied
    row.counts = addCounts(row.counts, replayed.counts)
  }
  rows.push(row)
}
rows.sort((a, b) => a.started.localeCompare(b.started))

/** @type {SessionRow} */
const all = { started: 'all', agents: 0, calls: 0, cortex: 0, denied: 0, counts: emptyLookupCounts() }
for (const row of rows) {
  all.agents += row.agents
  all.calls += row.calls
  all.cortex += row.cortex
  all.denied += row.denied
  all.counts = addCounts(all.counts, row.counts)
}

process.stdout.write(
  `${rows.length} sessions, ${all.agents} agent transcripts, ${all.calls} tool calls ` +
    `(${all.denied} refused calls left out). An estimate: the kinds read the command, not ` +
    `what the agent meant.\n\n`,
)
printTable([
  ['started', 'agents', 'calls', 'cortex', 'code lookups', 'symbol', 'word', 'other', 'share', 'fallback'],
  ...rows.map((row) => sessionCells({ ...row, started: localTime(row.started) })),
  sessionCells(all),
])
process.stdout.write(
  '\nshare: cortex code lookups / (those + greps for a symbol or a word, which code_context or\n' +
    '  code_search could answer). other: literals, lines in known files, files by name, logs.\n' +
    `fallback: such a grep within ${LOOKUP_WINDOW} calls of a cortex code lookup, in the same agent.\n\n`,
)

const byCalls = [...tools.entries()].sort((a, b) => b[1].calls - a[1].calls || a[0].localeCompare(b[0]))
printTable([
  ['cortex tool', 'calls', 'err', 'result ok', 'used', 'missed', 'unused', 'hit@1', 'hit@3', 'hit@10'],
  ...byCalls.map(([name, audit]) => toolCells(name, audit)),
])
process.stdout.write(
  '\nresult ok: searches that found something, diffs with a known risk, approved plans; for\n' +
    '  code lookups, answers that named a file. used: a file it named was opened next; missed:\n' +
    '  only other files were; unused: none. hit@k: of those used or missed, the file opened\n' +
    '  was in its top k.\n',
)
const never = [...offered].filter((name) => !tools.has(name)).sort()
if (offered.size > 0) {
  process.stdout.write(
    `\nOffered but never called (${never.length} of ${offered.size}): ${never.join(', ') || 'none'}\n`,
  )
}
const rare = byCalls.filter(([, audit]) => audit.calls <= 2).map(([name, audit]) => `${name} ${audit.calls}`)
if (rare.length > 0) process.stdout.write(`Called once or twice: ${rare.reverse().join(', ')}\n`)
