// cortex-bar: the Cortex Hub tool calls of this session, drawn above the prompt as a
// stacked bar (one color per category) with where /cs stands, and a colored tag under each
// cortex tool row. What it draws is model.js; this file times and measures the calls,
// follows which files the agent opens after a lookup, reads the hooks' markers and turns
// rows into elements.

import {
  LOOKUP_TOOLS,
  MARKERS,
  addCall,
  applyUse,
  bandModel,
  categoryOf,
  closeLookup,
  emptyStats,
  estimateTokens,
  firstLine,
  fitRow,
  groupTag,
  hitPaths,
  newLookup,
  paneModel,
  qualityOf,
  rowTag,
  shortName,
  summarizeArgs,
  textProps,
  withSizes,
} from './model.js'

const STATE_DIR = '.cortex/.session-state'
const PANE_ID = 'cortex-calls'
const RECENT_LIMIT = 50
const REFRESH_DELAY_MS = 400
/** How many finished calls keep their time for their tags. */
const TIMED_LIMIT = 200
const CORTEX_TOOL = /^mcp__.+__cortex_/
/** How many of the newest lookups a file the agent opens can still count for. */
const LOOKUP_WINDOW = 3
/** How many lookups are kept for their tags. */
const LOOKUP_LIMIT = 500
/** Lookups judged even when their result names no file: an empty one is a miss too. */
const ALWAYS_JUDGED = ['code_search', 'code_context']
/**
 * The surfaces that raise no AbovePrompt (Claude Code for VS Code, which Antigravity and
 * Cursor run too, and the mobile app): there the newest cortex row carries the band.
 */
const NO_BAND = ['vscode', 'mobile']
/** Cells the transcript indents a tool row's lines by, kept free so a tag never wraps. */
const TRANSCRIPT_INDENT = 6

/**
 * @typedef {import('claude-code').EngineInterface} Engine
 * @typedef {import('./model.js').Call} Call
 * @typedef {import('./model.js').Running} Running
 * @typedef {import('./model.js').Row} Row
 * @typedef {import('./model.js').Verdict} Verdict
 * @typedef {import('./model.js').Lookup} Lookup
 * @typedef {import('./model.js').Use} Use
 */

// Module state lives as long as this load: a hot reload or a new session starts it over.
let visible = true
let stats = emptyStats()
/** @type {Call[]} */
let recent = []
/** @type {Running[]} */
let inFlight = []
/** @type {string[] | null} */
let markers = null
/**
 * Finished calls by tool_use_id, for the tags under their rows: kept apart from `recent`
 * so a new session or a reset does not strip the times off the rows already drawn.
 * @type {Map<string, Call>}
 */
const timed = new Map()
let callIds = 0
/** @type {import('claude-code').Timer | null} */
let refreshTimer = null
/** The project root, which repo-relative hit paths are under. */
let root = ''
/**
 * Lookups by tool_use_id, oldest first. A reset closes them and starts a new epoch: the
 * measures count the current epoch only, the tags keep showing the older ones.
 * @type {Map<string, Lookup>}
 */
const lookups = new Map()
let epoch = 0

function resetCalls() {
  stats = emptyStats()
  recent = []
  for (const [id, lookup] of lookups) lookups.set(id, closeLookup(lookup))
  epoch += 1
}

/** The lookups the measures count. */
function currentLookups() {
  return [...lookups.values()].filter((lookup) => lookup.epoch === epoch)
}

/** The lookups a file opened now still counts for, oldest first. */
function openLookups() {
  return currentLookups().filter((lookup) => !lookup.closed)
}

/**
 * The /cs markers in the project, or null when it has no state dir (not a cortex project).
 * A marker counts only with the `tool=` evidence the tracker writes, which is what the
 * gates require too; gate-off holds the reason someone gave instead.
 * @param {Engine} $
 * @returns {Promise<string[] | null>}
 */
async function readMarkers($) {
  try {
    const dir = (await $.session.root()) + '/' + STATE_DIR
    if (!(await $.fs.exists(dir))) return null
    const entries = await $.fs.list(dir)
    const present = MARKERS.filter((name) =>
      entries.some((entry) => entry.name === name && entry.kind === 'file' && entry.size > 0),
    )
    const texts = await Promise.all(present.map((name) => $.fs.read(dir + '/' + name)))
    return present.filter((name, i) =>
      name === 'gate-off' ? texts[i]?.trim() !== '' : Boolean(texts[i]?.includes('tool=')),
    )
  } catch {
    return markers
  }
}

/** @param {Engine} $ */
async function refreshMarkers($) {
  const found = await readMarkers($)
  if (JSON.stringify(found) === JSON.stringify(markers)) return
  markers = found
  $.ui.invalidate('ui.render')
}

/**
 * The tracker writes its marker after the tool returns, so look a moment later.
 * @param {Engine} $
 */
function scheduleRefresh($) {
  refreshTimer?.cancel()
  refreshTimer = $.clock.after(REFRESH_DELAY_MS, () => {
    refreshTimer = null
    refreshMarkers($)
  })
}

/**
 * @param {import('claude-code').ToolCallResult} result
 * @returns {Verdict}
 */
function verdictOf(result) {
  if (result.deny !== undefined) return { ok: false, error: 'denied: ' + firstLine(result.deny) }
  if (result.isError) return { ok: false, error: firstLine(result.text ?? 'error') }
  return { ok: true, error: '' }
}

/**
 * The result as the model read it: core sets `text`; a hook's own answer may carry a
 * string `result` instead.
 * @param {import('claude-code').ToolCallResult | undefined} result
 */
function resultText(result) {
  if (!result || result.deny !== undefined) return ''
  if (typeof result.text === 'string') return result.text
  return typeof result.result === 'string' ? result.result : ''
}

/**
 * Sizes the files a lookup returned, after the fact: the tool's answer never waits on it.
 * @param {Engine} $
 * @param {string} toolUseId
 * @param {string[]} paths
 */
async function measureHits($, toolUseId, paths) {
  const bytes = await Promise.all(
    paths.map((path) =>
      $.fs
        .stat(path.startsWith('/') || root === '' ? path : root + '/' + path)
        .then((stat) => (stat.kind === 'file' ? stat.size : 0))
        .catch(() => 0),
    ),
  )
  const lookup = lookups.get(toolUseId)
  if (!lookup) return
  lookups.set(toolUseId, withSizes(lookup, bytes))
  $.ui.invalidate('ui.render')
}

/**
 * A new lookup: the oldest open ones beyond the window close, and its hits get sized.
 * @param {Engine} $
 * @param {Call} call
 * @param {string} text
 */
function startLookup($, call, text) {
  const paths = hitPaths(text)
  if (paths.length === 0 && !ALWAYS_JUDGED.includes(call.name)) return
  lookups.set(
    call.toolUseId,
    newLookup({ toolUseId: call.toolUseId, name: call.name, epoch, returned: call.tokens, paths }),
  )
  const open = openLookups()
  for (const old of open.slice(0, Math.max(0, open.length - LOOKUP_WINDOW))) {
    lookups.set(old.toolUseId, closeLookup(old))
  }
  for (const oldest of lookups.keys()) {
    if (lookups.size <= LOOKUP_LIMIT) break
    lookups.delete(oldest)
  }
  if (paths.length > 0) measureHits($, call.toolUseId, paths)
}

/**
 * A file the agent opened, counted for the open lookups.
 * @param {Engine} $
 * @param {Use} use
 */
function noteUse($, use) {
  const open = openLookups()
  if (open.length === 0) return
  const after = applyUse(open, use)
  let changed = false
  after.forEach((lookup, i) => {
    if (lookup === open[i]) return
    lookups.set(lookup.toolUseId, lookup)
    changed = true
  })
  if (changed) $.ui.invalidate('ui.render')
}

/**
 * A path the way the hits name it: relative to the project root, or undefined outside it.
 * @param {string} path
 */
function inProject(path) {
  if (!path.startsWith('/')) return path.replace(/^\.\//, '')
  return root !== '' && path.startsWith(root + '/') ? path.slice(root.length + 1) : undefined
}

/**
 * @param {Engine} $
 * @param {Running} started
 * @param {Verdict} verdict
 * @param {import('claude-code').ToolCallResult} [result]
 */
async function finishCall($, started, verdict, result) {
  const endedAt = await $.clock.now().catch(() => started.at)
  inFlight = inFlight.filter((call) => call.id !== started.id)
  const text = resultText(result)
  /** @type {Call} */
  const call = {
    toolUseId: started.toolUseId,
    name: started.name,
    category: categoryOf(started.name),
    args: started.args,
    at: endedAt,
    ms: endedAt - started.at,
    tokens: estimateTokens(text),
    ...verdict,
  }
  // Measuring is best effort: a result in a shape the parsers do not expect is left
  // unjudged, never an error in the tool's answer.
  try {
    const quality = verdict.ok ? qualityOf(started.name, text) : undefined
    if (quality) call.quality = quality
    if (verdict.ok && LOOKUP_TOOLS.includes(started.name)) startLookup($, call, text)
  } catch {
    // left unjudged
  }
  stats = addCall(stats, call)
  recent = [...recent, call].slice(-RECENT_LIMIT)
  timed.set(call.toolUseId, call)
  for (const oldest of timed.keys()) {
    if (timed.size <= TIMED_LIMIT) break
    timed.delete(oldest)
  }
  $.ui.invalidate('ui.render')
  scheduleRefresh($)
}

/**
 * The pane, or the same list as text where no pane can be placed (a `-p` run).
 * @param {Engine} $
 * @returns {Promise<import('claude-code').CommandRunResult>}
 */
async function openCalls($) {
  const opened = await $.ui.open({
    id: PANE_ID,
    title: 'Cortex calls',
    focus: true,
    closeOnEscape: true,
  })
  if (opened.isPlaced) return {}
  const rows = paneModel({ stats, recent, inFlight, lookups: currentLookups() })
  return { text: rows.map((row) => row.map((span) => span.text).join('')).join('\n') }
}

/**
 * The band's rows for a transcript row on a surface without the band, when that row holds
 * the newest cortex call; nothing anywhere else.
 * @param {{ surface: string, viewport?: { columns: number } }} e
 * @param {(string | undefined)[]} toolUseIds the cortex calls the row draws
 * @returns {Row[]}
 */
function bandBelow(e, toolUseIds) {
  if (!NO_BAND.includes(e.surface)) return []
  const newest = inFlight[inFlight.length - 1] ?? recent[recent.length - 1]
  if (!newest || !toolUseIds.includes(newest.toolUseId)) return []
  const columns = Math.min(transcriptColumns(e) ?? 80, 100)
  return bandModel({
    stats,
    recent,
    inFlight,
    markers,
    lookups: currentLookups(),
    columns,
    maxRows: 4,
  })
}

/**
 * Cells a line under a transcript row has, less the transcript's own indent; unknown
 * where the surface has not measured.
 * @param {{ viewport?: { columns: number } }} e
 */
function transcriptColumns(e) {
  return e.viewport ? Math.max(20, e.viewport.columns - TRANSCRIPT_INDENT) : undefined
}

/**
 * One line per row. A Text shrinks and wraps when its row runs out of room, which breaks
 * the columns, so each span sits in a Box that keeps its width; only a span marked
 * `truncate` gives way, and it is cut short instead of wrapping. A row whose fixed spans
 * are wider than `columns` is cut first.
 * @param {import('claude-code').ElementConstructor<import('claude-code').BoxProps>} Box
 * @param {import('claude-code').ElementConstructor<import('claude-code').TextProps>} Text
 * @param {Row[]} rows
 * @param {number | undefined} columns
 */
function drawRows(Box, Text, rows, columns) {
  return rows.map((row) =>
    Box({
      flexDirection: 'row',
      children: fitRow(row, columns).map((span) =>
        Box({ flexShrink: span.truncate ? 1 : 0, children: [Text(textProps(span))] }),
      ),
    }),
  )
}

/** @param {import('claude-code').On} on */
export function register(on) {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'cortex-bar',
      description: 'Show or hide the Cortex tool-call bar above the prompt',
      argumentHint: '[on|off|reset]',
      immediate: true,
    })
    await $.command.register({
      name: 'cortex-calls',
      description: 'List the Cortex tool calls of this session',
      immediate: true,
    })
    visible = (await $.store.get('visible')) !== false
    root = await $.session.root().catch(() => '')
    markers = await readMarkers($)
    $.ui.invalidate('ui.render')
    return result
  })

  // /clear starts a new conversation and session-init.sh wipes the markers with it.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    const result = await next(e)
    if (e.source === 'clear') resetCalls()
    $.ui.invalidate('ui.render')
    scheduleRefresh($)
    return result
  })

  on('command.run', { command: ['cortex-bar', 'cortex-calls'] }, async ($, e) => {
    if (e.command === 'cortex-calls') return openCalls($)
    const arg = e.args.trim().toLowerCase()
    if (arg === 'reset') {
      resetCalls()
      $.ui.invalidate('ui.render')
      return { text: 'cortex-bar: call counts cleared' }
    }
    if (arg !== '' && arg !== 'on' && arg !== 'off') {
      return { text: 'usage: /cortex-bar [on|off|reset]' }
    }
    visible = arg === '' ? !visible : arg === 'on'
    await $.store.set('visible', visible)
    $.ui.invalidate('ui.render')
    return { text: visible ? 'cortex-bar: shown' : 'cortex-bar: hidden (/cortex-bar shows it)' }
  })

  // Every cortex tool, whatever the MCP server is named: mcp__<server>__cortex_<name>.
  on('tool.call', { tool: CORTEX_TOOL }, async ($, e, next) => {
    const name = shortName(e.tool)
    if (name === 'session_start') resetCalls()
    /** @type {Running} */
    const started = {
      id: ++callIds,
      toolUseId: e.tool_use_id,
      name,
      args: summarizeArgs(e),
      at: await $.clock.now(),
    }
    inFlight = [...inFlight, started]
    $.ui.invalidate('ui.render')
    /** @type {import('claude-code').ToolCallResult} */
    let result
    try {
      result = await next(e)
    } catch (err) {
      await finishCall($, started, { ok: false, error: 'threw: ' + firstLine(err) })
      throw err
    }
    await finishCall($, started, verdictOf(result), result)
    return result
  })

  // A file opened after a lookup says whether the lookup found it: a Read or an edit of
  // it, or a command that names it. Build, typecheck and lint run in Bash and writes clear
  // the gates: only the markers know, so look again after any of these but a Read.
  on(
    'tool.call',
    { tool: ['Read', 'Bash', 'Edit', 'Write', 'NotebookEdit'] },
    async ($, e, next) => {
      const result = await next(e)
      if (e.tool !== 'Read' && markers !== null) scheduleRefresh($)
      if (result.deny !== undefined || result.isError) return result
      if (e.tool === 'Bash') {
        noteUse($, { command: e.command })
      } else {
        const path = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path
        // Only a file read or edited counts against a lookup; a new file is not a miss.
        const stray = e.tool === 'Read' || e.tool === 'Edit' ? inProject(path) : undefined
        noteUse($, stray === undefined ? { path } : { path, stray })
      }
      return result
    },
  )

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await refreshMarkers($)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (!visible || e.props.hasSurvey) return below
    const rows = bandModel({
      stats,
      recent,
      inFlight,
      markers,
      columns: e.props.bodyColumns,
      maxRows: e.props.maxRows,
      lookups: currentLookups(),
    })
    if (rows.length === 0) return below
    const { Box, Text } = $.ui.resolve(e)
    const band = Box({
      key: 'cortex-bar',
      flexDirection: 'column',
      children: drawRows(Box, Text, rows, e.props.bodyColumns),
    })
    return below ? Box({ flexDirection: 'column', children: [below, band] }) : band
  })

  // Every surface draws the tool rows. Where there is no band, the newest cortex row
  // carries it, so /cs shows its bar and checklist in the editor too.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const row = await next(e)
    if (!visible || !CORTEX_TOOL.test(e.props.tool)) return row
    const { Box, Text } = $.ui.resolve(e)
    const tag = rowTag({
      name: shortName(e.props.tool),
      isRunning: e.props.isRunning,
      isErrored: e.props.isErrored,
      isInterrupted: e.props.isInterrupted,
      call: timed.get(e.props.tool_use_id),
      lookup: lookups.get(e.props.tool_use_id),
    })
    const below = [tag, ...bandBelow(e, [e.props.tool_use_id])]
    return Box({
      flexDirection: 'column',
      children: [row, ...drawRows(Box, Text, below, transcriptColumns(e))],
    })
  })

  // A folded run of calls draws one line and none of its ToolUse rows.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const group = await next(e)
    const calls = e.props.calls.filter((call) => CORTEX_TOOL.test(call.tool))
    if (!visible || e.props.isExpanded || calls.length === 0) return group
    const { Box, Text } = $.ui.resolve(e)
    const below = [
      groupTag(calls.map((call) => shortName(call.tool))),
      ...bandBelow(
        e,
        calls.map((call) => call.tool_use_id),
      ),
    ]
    return Box({
      flexDirection: 'column',
      children: [group, ...drawRows(Box, Text, below, transcriptColumns(e))],
    })
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    // The bar and checklist head the pane where no band shows them; the bare "run /cs"
    // hint is left out, the list says as much.
    const columns = Math.max(20, e.props.bodyColumns - 2)
    const current = currentLookups()
    const summary = NO_BAND.includes(e.surface)
      ? bandModel({ stats, recent, inFlight, markers, columns, maxRows: 2 })
      : []
    /** @type {Row[]} */
    const rows = [
      ...(summary.length > 1 ? [...summary, [{ text: ' ' }]] : []),
      ...paneModel({ stats, recent, inFlight, lookups: current, columns }),
    ]
    return Box({
      flexDirection: 'column',
      paddingX: 1,
      children: drawRows(Box, Text, rows, columns),
    })
  })
}
