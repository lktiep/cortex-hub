// A past session through cortex-bar's own model: its transcript records replayed the way
// the hooks would have counted them live. Pure, so the tests run it; lookup-audit.mjs reads
// the files and prints.

import {
  ALWAYS_JUDGED,
  CORTEX_TOOL,
  LOOKUP_TOOLS,
  LOOKUP_WINDOW,
  applyUse,
  closeLookup,
  estimateTokens,
  hitPaths,
  inProject,
  newLookup,
  qualityOf,
  shortName,
} from '../hooks/model.js'
import { countTool, emptyLookupCounts, lookupKindOf } from '../hooks/lookups.js'

/**
 * @typedef {import('../hooks/model.js').Lookup} Lookup
 * @typedef {import('../hooks/model.js').Use} Use
 * @typedef {import('../hooks/lookups.js').LookupCounts} LookupCounts
 * @typedef {{ id: string, tool: string, input: Record<string, unknown>, agent: string }} ToolUse
 * @typedef {{ isError: boolean, denied: boolean, text: string }} ToolResult
 * @typedef {{ input: number, cacheWrite: number, cacheRead: number, output: number }} Usage
 * @typedef {Usage & { requests: number }} Tokens
 * @typedef {{ root: string, started: string, uses: ToolUse[], results: Map<string, ToolResult>, cortexIds: Set<string>, offered: Set<string>, usage: Map<string, Usage> }} Transcript
 * @typedef {{ calls: number, errors: number, good: number, judged: number, named: number, lookups: Lookup[] }} ToolAudit
 * @typedef {{ calls: number, cortex: number, denied: number, counts: LookupCounts }} Replay
 */

/** A result saying the call never ran: a hook or the person refused it. */
const DENIED =
  /^\s*(?:<tool_use_error>)?\s*(?:PreToolUse:\S+ hook|Permission to use \S+|The user doesn't want to|User rejected)/
/** The calls that open a file, which is how a lookup is judged. */
const USES = ['Read', 'Bash', 'Edit', 'Write', 'NotebookEdit']

/** @returns {Transcript} */
export function emptyTranscript() {
  return {
    root: '',
    started: '',
    uses: [],
    results: new Map(),
    cortexIds: new Set(),
    offered: new Set(),
    usage: new Map(),
  }
}

/** @param {unknown} n */
function count(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * A tool result's content as the model read it.
 * @param {unknown} content
 */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

/**
 * One parsed transcript line. Only the text of cortex results is kept: the measures read
 * nothing else of a result but whether it failed.
 * @param {Transcript} transcript
 * @param {any} record a transcript line, whatever its shape
 */
export function addRecord(transcript, record) {
  if (typeof record !== 'object' || record === null) return
  if (transcript.root === '' && typeof record.cwd === 'string') transcript.root = record.cwd
  if (transcript.started === '' && typeof record.timestamp === 'string') {
    transcript.started = record.timestamp
  }
  const attachment = record.attachment
  if (record.type === 'attachment' && attachment?.type === 'deferred_tools_delta') {
    for (const name of [...(attachment.addedNames ?? []), ...(attachment.readdedNames ?? [])]) {
      if (typeof name === 'string' && CORTEX_TOOL.test(name)) transcript.offered.add(shortName(name))
    }
  }
  // A response is written once per content block, each line with the same usage.
  const usage = record.message?.usage
  if (record.type === 'assistant' && typeof record.message?.id === 'string' && usage) {
    transcript.usage.set(record.message.id, {
      input: count(usage.input_tokens),
      cacheWrite: count(usage.cache_creation_input_tokens),
      cacheRead: count(usage.cache_read_input_tokens),
      output: count(usage.output_tokens),
    })
  }
  const content = record.message?.content
  if (!Array.isArray(content)) return
  for (const part of content) {
    if (record.type === 'assistant' && part?.type === 'tool_use') {
      const id = String(part.id)
      const tool = String(part.name)
      if (CORTEX_TOOL.test(tool)) transcript.cortexIds.add(id)
      const agent = typeof record.agentId === 'string' ? record.agentId : ''
      transcript.uses.push({ id, tool, input: part.input ?? {}, agent })
    } else if (record.type === 'user' && part?.type === 'tool_result') {
      const id = String(part.tool_use_id)
      const text = textOf(part.content)
      const isError = part.is_error === true
      transcript.results.set(id, {
        isError,
        denied: isError && DENIED.test(text),
        text: transcript.cortexIds.has(id) ? text : '',
      })
    }
  }
}

/**
 * @param {Map<string, ToolAudit>} tools
 * @param {string} name
 * @returns {ToolAudit}
 */
function auditOf(tools, name) {
  let audit = tools.get(name)
  if (audit === undefined) {
    audit = { calls: 0, errors: 0, good: 0, judged: 0, named: 0, lookups: [] }
    tools.set(name, audit)
  }
  return audit
}

/**
 * @param {ToolUse} use a Read, Bash, Edit, Write or NotebookEdit
 * @param {string} root
 * @returns {Use}
 */
function useOf(use, root) {
  if (use.tool === 'Bash') return { command: String(use.input.command ?? '') }
  const path = String((use.tool === 'NotebookEdit' ? use.input.notebook_path : use.input.file_path) ?? '')
  // Only a file read or edited counts against a lookup; a new file is not a miss.
  const stray = use.tool === 'Read' || use.tool === 'Edit' ? inProject(path, root) : undefined
  return stray === undefined ? { path } : { path, stray }
}

/**
 * The measures of one transcript, which is one agent loop: its own fallback window and its
 * own open lookups. Its cortex calls are added to `tools`, which several transcripts share.
 * A call with no result (an interrupted turn) and a refused one ran nothing and are left out.
 * @param {Transcript} transcript
 * @param {Map<string, ToolAudit>} tools
 * @returns {Replay}
 */
export function replay(transcript, tools) {
  let counts = emptyLookupCounts()
  /** @type {Lookup[]} */
  let open = []
  /** @type {Lookup[]} */
  const closed = []
  let calls = 0
  let cortex = 0
  let denied = 0
  for (const use of transcript.uses) {
    const result = transcript.results.get(use.id)
    if (result === undefined) continue
    if (result.denied) {
      denied += 1
      continue
    }
    calls += 1
    const name = CORTEX_TOOL.test(use.tool) ? shortName(use.tool) : ''
    const lookup = LOOKUP_TOOLS.includes(name)
    if (name !== '') {
      cortex += 1
      const audit = auditOf(tools, name)
      audit.calls += 1
      if (name === 'session_start') {
        closed.push(...open.map(closeLookup))
        open = []
      }
      if (result.isError) {
        audit.errors += 1
      } else {
        const quality = qualityOf(name, result.text)
        if (quality !== undefined) {
          audit.judged += 1
          if (quality.ok) audit.good += 1
        }
        const paths = lookup ? hitPaths(result.text) : []
        if (paths.length > 0) audit.named += 1
        if (lookup && (paths.length > 0 || ALWAYS_JUDGED.includes(name))) {
          const returned = estimateTokens(result.text)
          open.push(newLookup({ toolUseId: use.id, name, epoch: 0, returned, paths }))
          closed.push(...open.splice(0, Math.max(0, open.length - LOOKUP_WINDOW)).map(closeLookup))
        }
      }
    } else if (!result.isError && USES.includes(use.tool)) {
      open = applyUse(open, useOf(use, transcript.root))
    }
    try {
      const kind = lookup ? null : lookupKindOf(use.tool, use.input, transcript.root)
      counts = countTool(counts, { agent: use.agent, cortex: lookup, kind })
    } catch {
      // A command the classifier cannot read is not counted.
    }
  }
  for (const done of [...closed, ...open.map(closeLookup)]) auditOf(tools, done.name).lookups.push(done)
  return { calls, cortex, denied, counts }
}

/**
 * Two transcripts' counts together. The fallback windows do not carry over: each loop
 * kept its own.
 * @param {LookupCounts} a
 * @param {LookupCounts} b
 * @returns {LookupCounts}
 */
export function addCounts(a, b) {
  const native = { ...a.native }
  for (const [kind, count] of Object.entries(b.native)) native[kind] = (native[kind] ?? 0) + count
  return { cortex: a.cortex + b.cortex, native, fallback: a.fallback + b.fallback, since: {} }
}

/**
 * The tokens of a set of model requests, each counted once.
 * @param {Iterable<Usage>} usages
 * @returns {Tokens}
 */
export function tokensOf(usages) {
  const tokens = { requests: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }
  for (const usage of usages) {
    tokens.requests += 1
    tokens.input += usage.input
    tokens.cacheWrite += usage.cacheWrite
    tokens.cacheRead += usage.cacheRead
    tokens.output += usage.output
  }
  return tokens
}

/**
 * The share of the prompt read from the cache, or null with no prompt at all.
 * @param {Usage} tokens
 */
export function cacheHit(tokens) {
  const prompt = tokens.input + tokens.cacheWrite + tokens.cacheRead
  return prompt > 0 ? tokens.cacheRead / prompt : null
}
