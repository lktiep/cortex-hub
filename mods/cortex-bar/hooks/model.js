// What cortex-bar draws, as plain data. Nothing here touches the mods API, so the tests
// can check the bar and the pane without mounting anything, and register.js stays a thin
// layer that turns rows of spans into Box and Text elements.

/**
 * @typedef {{ text: string, color?: string, bold?: boolean, dim?: boolean, truncate?: boolean }} Span
 * @typedef {Span[]} Row
 * @typedef {{ id: number, toolUseId: string, name: string, args: string, at: number }} Running
 * @typedef {{ ok: boolean, error: string }} Verdict
 * @typedef {{ kind: 'found' | 'risk known' | 'passed', ok: boolean, tag: string }} Quality
 * @typedef {{ toolUseId: string, name: string, category: string, args: string, at: number, ms: number, tokens: number, quality?: Quality } & Verdict} Call
 * @typedef {{ path: string, rank: number, tokens: number | null }} Hit
 * @typedef {{ toolUseId: string, name: string, epoch: number, returned: number, hits: Hit[], used: number | null, opened: string[], strays: string[], closed: boolean }} Lookup
 * @typedef {'used' | 'missed' | 'unused' | 'open'} LookupState
 * @typedef {{ path: string, stray?: string } | { command: string }} Use
 * @typedef {{ count: number, used: number, missed: number, at1: number, at3: number, at10: number, saved: number, measured: number }} LookupMetrics
 * @typedef {{ name: string, isRunning: boolean, isErrored: boolean, isInterrupted: boolean, call?: Call, lookup?: Lookup }} ToolRow
 * @typedef {{ calls: number, errors: number, ms: number, tokens: number, good: number, judged: number, kind: string, last: string }} ToolStats
 * @typedef {{ total: number, errors: number, tokens: number, byCategory: Record<string, number>, byTool: Record<string, ToolStats>, okNames: string[] }} Stats
 * @typedef {'done' | 'partial' | 'todo'} StepState
 * @typedef {{ label: string, state: StepState }} Step
 * @typedef {{ steps: Step[], gates: Step[] | null, gateOff: boolean }} Progress
 * @typedef {{ stats: Stats, recent: Call[], inFlight: Running[], lookups?: Lookup[] }} Calls
 */

/**
 * One color per category, in the order the bar stacks them. Raw rgb() colors, mid tones
 * that read on a dark and a light theme; the states use the theme's own keys.
 */
export const CATEGORIES = [
  { id: 'session', label: 'session', color: 'rgb(175,135,255)' },
  { id: 'knowledge', label: 'knowledge', color: 'rgb(0,175,215)' },
  { id: 'memory', label: 'memory', color: 'rgb(95,135,255)' },
  { id: 'code', label: 'code', color: 'rgb(95,175,95)' },
  { id: 'quality', label: 'quality', color: 'rgb(215,175,0)' },
  { id: 'tasks', label: 'tasks', color: 'rgb(255,135,95)' },
  { id: 'other', label: 'other', color: 'rgb(138,138,138)' },
]

const TITLE_COLOR = 'rgb(175,135,255)'
const OTHER_COLOR = 'rgb(138,138,138)'
const OK = 'success'
const FAILED = 'error'
const WAITING = 'warning'

/**
 * The markers .claude/hooks/track-quality.sh writes into .cortex/.session-state.
 * They are the same evidence the commit gate reads, so the bar never disagrees with it.
 */
export const MARKERS = [
  'session-started',
  'knowledge-recalled',
  'memory-recalled',
  'changes-checked',
  'tasks-checked',
  'gate-build',
  'gate-typecheck',
  'gate-lint',
  'quality-gates-passed',
  'quality-reported',
  'gate-off',
]

const SECRET_KEY = /key|token|secret|password|authorization/i
/** What tool.call puts beside a tool's own arguments. */
const RESERVED = ['tool', 'tool_use_id', 'agentId', 'consent']
const SUMMARY_KEYS = ['query', 'name', 'target', 'title', 'repo', 'taskId', 'plan', 'content']

/**
 * `mcp__cortex-hub__cortex_code_search` → `code_search`
 * @param {string} tool
 */
export function shortName(tool) {
  const at = tool.lastIndexOf('__cortex_')
  return at === -1 ? tool : tool.slice(at + '__cortex_'.length)
}

/** @param {string} name a short cortex tool name */
export function categoryOf(name) {
  if (/^(session_|changes$|health$|list_repos$)/.test(name)) return 'session'
  if (name.startsWith('knowledge_')) return 'knowledge'
  if (name.startsWith('memory_')) return 'memory'
  if (/^(code_|cypher$|detect_changes$)/.test(name)) return 'code'
  if (/^(quality_report|plan_quality|tool_stats)$/.test(name)) return 'quality'
  if (name.startsWith('task_')) return 'tasks'
  return 'other'
}

/** @param {string} category */
function colorOf(category) {
  return CATEGORIES.find((c) => c.id === category)?.color ?? OTHER_COLOR
}

/**
 * One `key=value` hint for a call, never from a field that looks like a credential.
 * @param {Record<string, unknown>} input the tool.call event: the tool's arguments
 * @param {number} [max]
 */
export function summarizeArgs(input, max = 48) {
  /** @param {string} key */
  const rank = (key) => {
    const i = SUMMARY_KEYS.indexOf(key)
    return i === -1 ? SUMMARY_KEYS.length : i
  }
  /** @type {[string, string][]} */
  const fields = []
  for (const [key, value] of Object.entries(input)) {
    if (RESERVED.includes(key) || SECRET_KEY.test(key)) continue
    if (typeof value === 'string' && value.trim() !== '') fields.push([key, value])
  }
  const [best] = fields.sort(([a], [b]) => rank(a) - rank(b))
  if (!best) return ''
  const text = best[1].replace(/\s+/g, ' ').trim()
  return best[0] + '=' + (text.length > max ? text.slice(0, max - 1) + '…' : text)
}

/**
 * The first line of a message, cut to fit one row.
 * @param {unknown} text
 * @param {number} [max]
 */
export function firstLine(text, max = 60) {
  const line = String(text).trim().split('\n')[0] ?? ''
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}

/** @param {number} ms */
export function formatMs(ms) {
  if (ms < 1000) return Math.max(0, Math.round(ms)) + 'ms'
  return (ms / 1000).toFixed(ms < 10_000 ? 1 : 0) + 's'
}

/**
 * Tokens in a text, by the same rule the hub's own usage stats use: four characters each.
 * There is no tokenizer to ask, so every token figure the mod shows is this estimate.
 * @param {string} text
 */
export function estimateTokens(text) {
  return Math.ceil(text.length / 4)
}

/** @param {number} tokens `840`, `6.2k`, `120k`, `1.2M` */
export function formatTokens(tokens) {
  const n = Math.max(0, Math.round(tokens))
  if (n < 1000) return String(n)
  if (n < 9_950) return (n / 1000).toFixed(1) + 'k'
  if (n < 999_500) return Math.round(n / 1000) + 'k'
  return (n / 1_000_000).toFixed(1) + 'M'
}

/** @returns {Stats} */
export function emptyStats() {
  return { total: 0, errors: 0, tokens: 0, byCategory: {}, byTool: {}, okNames: [] }
}

/**
 * Totals outlive the recent-calls list, which keeps only the newest calls.
 * @param {Stats} stats
 * @param {Call} call
 * @returns {Stats}
 */
export function addCall(stats, call) {
  const okNames =
    call.ok && !stats.okNames.includes(call.name) ? [...stats.okNames, call.name] : stats.okNames
  const tool = stats.byTool[call.name] ?? {
    calls: 0,
    errors: 0,
    ms: 0,
    tokens: 0,
    good: 0,
    judged: 0,
    kind: '',
    last: '',
  }
  const quality = call.quality
  return {
    total: stats.total + 1,
    errors: stats.errors + (call.ok ? 0 : 1),
    tokens: stats.tokens + call.tokens,
    byCategory: {
      ...stats.byCategory,
      [call.category]: (stats.byCategory[call.category] ?? 0) + 1,
    },
    byTool: {
      ...stats.byTool,
      [call.name]: {
        calls: tool.calls + 1,
        errors: tool.errors + (call.ok ? 0 : 1),
        ms: tool.ms + call.ms,
        tokens: tool.tokens + call.tokens,
        good: tool.good + (quality?.ok ? 1 : 0),
        judged: tool.judged + (quality ? 1 : 0),
        kind: quality?.kind ?? tool.kind,
        last: quality?.tag ?? tool.last,
      },
    },
    okNames,
  }
}

/**
 * How a result reads, for the tools whose output says so itself: how many documents a
 * search found, the risk a diff got, the score a plan got. Undefined for the rest, and for
 * an output in a shape this does not know.
 * @param {string} name a short cortex tool name
 * @param {string} text the result as the model read it
 * @returns {Quality | undefined}
 */
export function qualityOf(name, text) {
  if (name === 'knowledge_search' || name === 'memory_search') {
    const heading = name === 'knowledge_search' ? /^### Result \d+:.*$/gm : /^### Memory \d+\b/gm
    const found = text.match(heading) ?? []
    const scores = found
      .map((line) => /Score: (\d+(?:\.\d+)?)/.exec(line)?.[1])
      .filter((score) => score !== undefined)
      .map(Number)
    if (found.length === 0) return { kind: 'found', ok: false, tag: 'nothing found' }
    const top = scores.length > 0 ? ' · top ' + Math.max(...scores).toFixed(2) : ''
    return { kind: 'found', ok: true, tag: found.length + ' found' + top }
  }
  if (name === 'detect_changes') {
    const risk = /"risk_level":\s*"(\w+)"/.exec(text)?.[1]
    return risk ? { kind: 'risk known', ok: risk !== 'unknown', tag: 'risk ' + risk } : undefined
  }
  if (name === 'plan_quality') {
    const score = /Total Score:\s*(\d+(?:\.\d+)?)\/10\s+(APPROVED|NEEDS IMPROVEMENT)/.exec(text)
    return score
      ? { kind: 'passed', ok: score[2] === 'APPROVED', tag: score[1] + '/10' }
      : undefined
  }
  return undefined
}

/** The tools that answer "where is it": what they return is judged by what gets opened. */
export const LOOKUP_TOOLS = ['code_search', 'code_context', 'code_impact', 'cypher']
/** How many results of a lookup count, as the retrieval benchmark counts them. */
const HIT_LIMIT = 10
/** One Read returns at most about this many tokens of a file, so a bigger file counts this. */
const READ_CAP = 25_000
/**
 * A repo path with at least one folder and an extension: `apps/api/src/x.ts:12`,
 * `[docs/x.md]`. What precedes it rules out the middle of a URL or of an absolute path.
 */
const PATH = /(?<![\w./:@-])(\/?(?:[\w.@-]+\/)+[\w.@-]*\.[A-Za-z][A-Za-z0-9]*)(?![\w/-])/g

/**
 * The files a lookup's result points to, in the order they first appear: that order is
 * their rank.
 * @param {string} text
 * @param {number} [limit]
 */
export function hitPaths(text, limit = HIT_LIMIT) {
  /** @type {string[]} */
  const paths = []
  for (const match of text.matchAll(PATH)) {
    const path = (match[1] ?? '').replace(/^\.\//, '')
    if (path !== '' && !paths.includes(path)) paths.push(path)
    if (paths.length === limit) break
  }
  return paths
}

/**
 * @param {{ toolUseId: string, name: string, epoch: number, returned: number, paths: string[] }} input
 * @returns {Lookup}
 */
export function newLookup({ toolUseId, name, epoch, returned, paths }) {
  return {
    toolUseId,
    name,
    epoch,
    returned,
    hits: paths.map((path, i) => ({ path, rank: i + 1, tokens: null })),
    used: null,
    opened: [],
    strays: [],
    closed: false,
  }
}

/**
 * The hits with the size of each file, 0 for one that is not there (another repo's).
 * @param {Lookup} lookup
 * @param {number[]} bytes in the order of the hits
 * @returns {Lookup}
 */
export function withSizes(lookup, bytes) {
  return {
    ...lookup,
    hits: lookup.hits.map((hit, i) => ({
      ...hit,
      tokens: Math.min(READ_CAP, Math.ceil((bytes[i] ?? 0) / 4)),
    })),
  }
}

/**
 * Whether `text` names `path` whole: on its own or at the end of a longer path.
 * @param {string} text
 * @param {string} path
 */
function mentions(text, path) {
  for (let at = text.indexOf(path); at !== -1; at = text.indexOf(path, at + 1)) {
    const before = text[at - 1] ?? ' '
    const after = text[at + path.length] ?? ' '
    if (!/[\w.@-]/.test(before) && !/[\w.@/-]/.test(after)) return true
  }
  return false
}

/**
 * @param {Use} use
 */
function useText(use) {
  return 'command' in use ? use.command : use.path
}

/**
 * A file the agent opened after the lookup: a Read, an edit, or a command that names it.
 * A hit sets `used` to the best rank opened so far. A file it did not return is a stray
 * when the caller gives one (Reads and Edits inside the project); a command never is.
 * @param {Lookup} lookup
 * @param {Use} use
 * @returns {Lookup}
 */
export function noteOpen(lookup, use) {
  const text = useText(use)
  const matched = lookup.hits.filter((hit) => mentions(text, hit.path))
  if (matched.length === 0) {
    const stray = 'stray' in use ? use.stray : undefined
    if (stray === undefined || lookup.strays.includes(stray)) return lookup
    return { ...lookup, strays: [...lookup.strays, stray] }
  }
  const best = Math.min(...matched.map((hit) => hit.rank))
  return {
    ...lookup,
    used: lookup.used === null ? best : Math.min(lookup.used, best),
    opened: [...new Set([...lookup.opened, ...matched.map((hit) => hit.path)])],
  }
}

/**
 * A file opened while several lookups are open: each one that returned it counts it, and
 * only when none did is it a stray, of the newest.
 * @param {Lookup[]} open oldest first
 * @param {Use} use
 * @returns {Lookup[]}
 */
export function applyUse(open, use) {
  const text = useText(use)
  const known = open.some((lookup) => lookup.hits.some((hit) => mentions(text, hit.path)))
  if (known) {
    const plain = 'path' in use ? { path: use.path } : use
    return open.map((lookup) => noteOpen(lookup, plain))
  }
  return open.map((lookup, i) => (i === open.length - 1 ? noteOpen(lookup, use) : lookup))
}

/**
 * @param {Lookup} lookup
 * @returns {Lookup}
 */
export function closeLookup(lookup) {
  return lookup.closed ? lookup : { ...lookup, closed: true }
}

/**
 * used: a file it returned was opened. missed: it closed with only other files opened.
 * unused: it closed with nothing opened. open: the agent may still act on it.
 * @param {Lookup} lookup
 * @returns {LookupState}
 */
export function lookupState(lookup) {
  if (lookup.used !== null) return 'used'
  if (!lookup.closed) return 'open'
  return lookup.strays.length > 0 ? 'missed' : 'unused'
}

/**
 * Tokens behind a lookup's hits, or null while their sizes are not known yet.
 * @param {Lookup} lookup
 */
function tokensBehind(lookup) {
  if (lookup.hits.some((hit) => hit.tokens === null)) return null
  return lookup.hits.reduce((sum, hit) => sum + (hit.tokens ?? 0), 0)
}

/**
 * What reading the hits' files instead would have cost, less what the lookup returned and
 * the files that were opened anyway. An upper bound: it assumes every hit would have been
 * opened to find the answer. A lookup the agent went past to other files saved nothing.
 * @param {Lookup} lookup
 */
function savedBy(lookup) {
  const behind = tokensBehind(lookup)
  if (behind === null || lookup.hits.length === 0) return null
  if (lookup.used === null && lookup.strays.length > 0) return 0
  const opened = lookup.hits
    .filter((hit) => lookup.opened.includes(hit.path))
    .reduce((sum, hit) => sum + (hit.tokens ?? 0), 0)
  return Math.max(0, behind - lookup.returned - opened)
}

/**
 * hit@k over the lookups that were judged (used or missed), and the tokens they saved.
 * @param {Lookup[]} lookups
 * @returns {LookupMetrics}
 */
export function lookupMetrics(lookups) {
  const metrics = { count: lookups.length, used: 0, missed: 0, at1: 0, at3: 0, at10: 0 }
  let saved = 0
  let measured = 0
  for (const lookup of lookups) {
    const state = lookupState(lookup)
    if (state === 'missed') metrics.missed += 1
    if (state === 'used' && lookup.used !== null) {
      metrics.used += 1
      if (lookup.used <= 1) metrics.at1 += 1
      if (lookup.used <= 3) metrics.at3 += 1
      if (lookup.used <= 10) metrics.at10 += 1
    }
    const by = savedBy(lookup)
    if (by !== null) {
      saved += by
      measured += 1
    }
  }
  return { ...metrics, saved, measured }
}

/**
 * Where /cs stands. The cortex steps count a call seen in this session or a marker the
 * hooks wrote (which covers calls made before the mod loaded). Build, typecheck and lint
 * run in Bash, so only the markers know about them: `gates` is null without a state dir.
 * @param {string[]} okNames
 * @param {string[] | null} markers
 * @returns {Progress}
 */
export function stepsFrom(okNames, markers) {
  /** @param {string} name */
  const seen = (name) => okNames.includes(name)
  /** @param {string} marker */
  const has = (marker) => markers != null && markers.includes(marker)
  /** @param {boolean} done @returns {StepState} */
  const state = (done) => (done ? 'done' : 'todo')
  const knowledge = seen('knowledge_search') || has('knowledge-recalled')
  const memory = seen('memory_search') || has('memory-recalled')
  /** @type {StepState} */
  const recall = knowledge && memory ? 'done' : knowledge || memory ? 'partial' : 'todo'
  const steps = [
    { label: 'session', state: state(seen('session_start') || has('session-started')) },
    { label: 'recall', state: recall },
    {
      label: 'changes',
      state: state(seen('changes') || seen('detect_changes') || has('changes-checked')),
    },
    { label: 'tasks', state: state(seen('task_pickup') || has('tasks-checked')) },
  ]
  if (markers == null) return { steps, gates: null, gateOff: false }
  const allGates = has('quality-gates-passed')
  const gates = [
    { label: 'build', state: state(allGates || has('gate-build')) },
    { label: 'typecheck', state: state(allGates || has('gate-typecheck')) },
    { label: 'lint', state: state(allGates || has('gate-lint')) },
    { label: 'report', state: state(seen('quality_report') || has('quality-reported')) },
  ]
  return { steps, gates, gateOff: has('gate-off') }
}

/**
 * Split `width` cells between the categories in proportion to their calls. Every category
 * that was used keeps at least one cell, and the cells left over go to the largest remainders.
 * @param {Record<string, number>} byCategory
 * @param {number} width
 */
export function barSegments(byCategory, width) {
  const used = CATEGORIES.map((c) => ({ ...c, count: byCategory[c.id] ?? 0 })).filter(
    (c) => c.count > 0,
  )
  const total = used.reduce((sum, c) => sum + c.count, 0)
  if (total === 0 || width < used.length) return []
  const cells = used.map((c) => {
    const exact = (c.count / total) * width
    return { id: c.id, color: c.color, exact, width: Math.max(1, Math.floor(exact)) }
  })
  let filled = cells.reduce((sum, c) => sum + c.width, 0)
  while (filled > width) {
    const widest = cells.reduce((a, b) => (b.width > a.width ? b : a))
    widest.width -= 1
    filled -= 1
  }
  while (filled < width) {
    const behind = cells.reduce((a, b) => (b.exact - b.width > a.exact - a.width ? b : a))
    behind.width += 1
    filled += 1
  }
  return cells.map(({ id, color, width: w }) => ({ id, color, width: w }))
}

/** @type {Record<StepState, Span>} */
const DOT = {
  done: { text: '●', color: OK },
  partial: { text: '◐', color: WAITING },
  todo: { text: '○', dim: true },
}

/**
 * @param {Step[]} items
 * @param {string} [gap]
 * @returns {Row}
 */
function stepSpans(items, gap = '  ') {
  return items.flatMap((item) => [DOT[item.state], { text: ' ' + item.label + gap }])
}

/**
 * `●●○○ tasks`: the dots alone, then the first step not done yet.
 * @param {Step[]} items
 * @returns {Row}
 */
function compactSteps(items) {
  const next = items.find((item) => item.state !== 'done')
  return [...items.map((item) => DOT[item.state]), { text: ' ' + (next?.label ?? 'done') + '  ' }]
}

/**
 * @param {Call[]} recent
 * @param {Running[]} inFlight
 * @returns {Row}
 */
function lastCallSpans(recent, inFlight) {
  const running = inFlight[inFlight.length - 1]
  if (running) return [{ text: ' · ' }, { text: '⟳ ' + running.name, color: WAITING }]
  const last = recent[recent.length - 1]
  if (!last) return []
  return [
    { text: ' · last ' + last.name + ' ' + formatMs(last.ms) + ' ', dim: true },
    last.ok ? { text: '✓', color: OK } : { text: '✗', color: FAILED },
  ]
}

/**
 * `■ code 3  ■ memory 1`, in the order the bar stacks them, for the categories used.
 * @param {Record<string, number>} byCategory
 * @param {string} [gap]
 * @returns {Row}
 */
function legendSpans(byCategory, gap = '  ') {
  return CATEGORIES.filter((c) => (byCategory[c.id] ?? 0) > 0).flatMap((c) => [
    { text: '■ ', color: c.color },
    { text: c.label + ' ' + byCategory[c.id] + gap },
  ])
}

/** @param {Row} spans */
const textLength = (spans) => spans.reduce((sum, s) => sum + [...s.text].length, 0)

/**
 * A row that cannot wrap. While its fixed spans fit, the truncating ones give way as the
 * layout needs; past that they are left out and the row is cut short with an ellipsis.
 * @param {Row} row
 * @param {number | undefined} columns
 * @returns {Row}
 */
export function fitRow(row, columns) {
  if (columns === undefined || textLength(row.filter((s) => !s.truncate)) <= columns) return row
  /** @type {Row} */
  const out = []
  let room = columns - 1
  for (const span of row) {
    if (span.truncate) continue
    const chars = [...span.text]
    if (chars.length > room) {
      if (room > 0) out.push({ ...span, text: chars.slice(0, room).join('') })
      break
    }
    out.push(span)
    room -= chars.length
  }
  return [...out, { text: '…', dim: true }]
}

/**
 * Text in a column `width` cells wide, cut with an ellipsis so a space always follows it.
 * @param {string} text
 * @param {number} width
 */
function cell(text, width) {
  const chars = [...text]
  return chars.length < width ? text.padEnd(width) : chars.slice(0, width - 2).join('') + '… '
}

/**
 * @param {LookupMetrics} metrics
 * @param {string} [gap]
 */
function hitText({ used, missed, at1, at3, at10 }, gap = ' · ') {
  const judged = used + missed
  return ['hit@1 ' + at1, 'hit@3 ' + at3, 'hit@10 ' + at10]
    .map((part) => part + '/' + judged)
    .join(gap)
}

/**
 * `tokens ~6.2k in · ~88k saved est.  │ hit@1 2/4 · …`: what the cortex results cost, what
 * the lookups saved, and how often the agent opened what they ranked first.
 * @param {Stats} stats
 * @param {Lookup[]} lookups
 * @returns {Row}
 */
function metricsSpans(stats, lookups) {
  if (stats.tokens === 0 && lookups.length === 0) return []
  const metrics = lookupMetrics(lookups)
  /** @type {Row} */
  const row = [{ text: 'tokens ', dim: true }, { text: '~' + formatTokens(stats.tokens) + ' in' }]
  if (metrics.measured > 0) {
    row.push(
      { text: ' · ' },
      { text: '~' + formatTokens(metrics.saved) + ' saved', color: OK },
      { text: ' est.', dim: true },
    )
  }
  if (metrics.used + metrics.missed > 0) {
    row.push({ text: '  │ ', dim: true }, { text: hitText(metrics), truncate: true })
  }
  return row
}

/**
 * The band above the prompt, as rows of spans: the stacked bar with its totals, a legend
 * of the categories in use, the token and hit measures, and the /cs checklist. With fewer
 * rows than that it keeps the bar, then the checklist, then the measures. Draws nothing in
 * a project without cortex state until a cortex tool is called, and only a hint in one
 * that has it but has not run /cs yet.
 * @param {Calls & { markers: string[] | null, columns?: number, maxRows?: number }} input
 * @returns {Row[]}
 */
export function bandModel({ stats, recent, inFlight, markers, lookups = [], columns, maxRows }) {
  /** @type {Span} */
  const title = { text: '◆ cortex ', color: TITLE_COLOR, bold: true }
  const progress = stepsFrom(stats.okNames, markers)
  const started = progress.steps[0]?.state === 'done'

  if (!started && stats.total === 0 && inFlight.length === 0) {
    if (markers == null) return []
    return [[title, { text: 'no cortex session yet — run /cs', dim: true }]]
  }

  /** @type {Row} */
  const tail = [{ text: ' ' + stats.total + (stats.total === 1 ? ' call' : ' calls') }]
  if (stats.errors > 0) tail.push({ text: ' · ' + stats.errors + ' err', color: FAILED })
  tail.push(...lastCallSpans(recent, inFlight))

  const room = (columns ?? 80) - textLength([title]) - textLength(tail)
  const width = Math.max(8, Math.min(40, room))
  const segments = barSegments(stats.byCategory, width)
  /** @type {Row} */
  const bar =
    segments.length > 0
      ? segments.map((s) => ({ text: '█'.repeat(s.width), color: s.color }))
      : [{ text: '░'.repeat(width), dim: true }]

  const rows = [[title, ...bar, ...tail]]

  const fits = (/** @type {Row} */ row) => columns === undefined || textLength(row) <= columns
  const wideLegend = legendSpans(stats.byCategory)
  const legend = fits(wideLegend) ? wideLegend : legendSpans(stats.byCategory, ' ')

  /** @param {(items: Step[]) => Row} spans */
  const checklistOf = (spans) => {
    /** @type {Row} */
    const row = [{ text: '/cs ', dim: true }, ...spans(progress.steps)]
    if (progress.gates) row.push({ text: '│ ', dim: true }, ...spans(progress.gates))
    if (progress.gateOff) row.push({ text: '⚠ gates off', color: WAITING })
    return row
  }
  const checklist =
    [checklistOf(stepSpans), checklistOf((items) => stepSpans(items, ' '))].find(fits) ??
    checklistOf(compactSteps)

  const metrics = metricsSpans(stats, lookups)
  const limit = maxRows ?? 3
  const showMetrics = metrics.length > 0 && limit >= 3
  if (legend.length > 0 && limit >= (showMetrics ? 4 : 3)) rows.push(legend)
  if (showMetrics) rows.push(metrics)
  if (limit >= 2) rows.push(checklist)
  return rows
}

/**
 * What a recorded call says about its result, as separate parts: for a lookup, the files
 * behind it and whether one was opened; for a search or a check, how its result read.
 * @param {Call} call
 * @param {Lookup | undefined} lookup
 * @returns {Span[]}
 */
function detailParts(call, lookup) {
  /** @type {Span[]} */
  const parts = []
  if (lookup) {
    const count = lookup.hits.length
    const behind = tokensBehind(lookup)
    const size = behind !== null && count > 0 ? ' ~' + formatTokens(behind) : ''
    parts.push({ text: count + (count === 1 ? ' file' : ' files') + size, dim: true })
    const state = lookupState(lookup)
    if (state === 'used') parts.push({ text: 'used #' + lookup.used, color: OK })
    if (state === 'missed') parts.push({ text: 'missed', color: WAITING })
  }
  if (call.quality) {
    /** @type {Span} */
    const tag = { text: call.quality.tag }
    if (!call.quality.ok) tag.color = WAITING
    parts.push(tag)
  }
  return parts
}

/**
 * Parts with a dim separator before each one.
 * @param {Span[]} parts
 * @param {string} separator
 * @returns {Row}
 */
function joined(parts, separator) {
  return parts.flatMap((part) => [{ text: separator, dim: true }, part])
}

/**
 * The line under a cortex tool's row in the transcript: its category in its color, then
 * how the call went, with its time, its tokens and how its result did when the mod
 * recorded it. The row's own flags decide the state, so a call made before the mod
 * loaded still gets its tag.
 * @param {ToolRow} row
 * @returns {Row}
 */
export function rowTag({ name, isRunning, isErrored, isInterrupted, call, lookup }) {
  const category = categoryOf(name)
  /** @type {Row} */
  const tag = [{ text: '■ ' + category, color: colorOf(category) }]
  if (isRunning) return [...tag, { text: ' · ', dim: true }, { text: '⟳', color: WAITING }]
  if (isInterrupted) return [...tag, { text: ' · interrupted', dim: true }]
  const failed = isErrored || (call !== undefined && !call.ok)
  tag.push(
    { text: call ? ' · ' + formatMs(call.ms) + ' ' : ' ', dim: true },
    failed ? { text: '✗', color: FAILED } : { text: '✓', color: OK },
  )
  if (!call) return tag
  /** @type {Span[]} */
  const parts =
    call.tokens > 0 ? [{ text: '~' + formatTokens(call.tokens) + ' tok', dim: true }] : []
  return [...tag, ...joined([...parts, ...detailParts(call, lookup)], ' · ')]
}

/**
 * The line under a folded group of tool calls that holds cortex calls: how many of each.
 * @param {string[]} names the short names of the group's cortex calls
 * @returns {Row}
 */
export function groupTag(names) {
  /** @type {Record<string, number>} */
  const counts = {}
  for (const name of names) {
    const category = categoryOf(name)
    counts[category] = (counts[category] ?? 0) + 1
  }
  return legendSpans(counts)
}

/** @param {number} at */
function clock(at) {
  return new Date(at).toTimeString().slice(0, 8)
}

/**
 * The quality column of the per-tool table: hit@k for a lookup tool, the share of good
 * results and the last one for a tool whose output says how it went.
 * @param {string} name
 * @param {ToolStats} tool
 * @param {LookupMetrics} metrics the tool's own lookups
 */
function qualityText(name, tool, metrics) {
  if (LOOKUP_TOOLS.includes(name)) {
    if (metrics.used + metrics.missed > 0) return hitText(metrics)
    return metrics.count > 0 ? 'no result opened yet' : ''
  }
  if (tool.judged === 0) return ''
  return tool.good + '/' + tool.judged + ' ' + tool.kind + ' · last ' + tool.last
}

/** Cells taken by the name column, wide enough for `knowledge_search`. */
const NAME_WIDTH = 18
/** Columns of the per-tool table after the name, right-aligned. */
const TABLE = [
  { title: 'calls', width: 6 },
  { title: 'ok', width: 5 },
  { title: 'avg', width: 8 },
  { title: '~tok', width: 8 },
  { title: 'saved', width: 8 },
]
/** What a narrow pane leaves out of the table first, so the quality column keeps room. */
const TABLE_DROPS = ['avg', '~tok', 'ok']
/** Cells the quality column keeps before the table drops a column: `hit@1 2/4 · hit@3 3/4`. */
const QUALITY_WIDTH = 24
/** Cells taken by the result column of a call row: `10 files ~31k · used #2`. */
const DETAIL_WIDTH = 26
/** Below this a call row leaves out its tokens and the result takes the rest of it. */
const WIDE_CALLS = 86

/**
 * A section title with a dim rule to the edge.
 * @param {string} title
 * @param {number} columns
 * @param {string} [note]
 * @returns {Row}
 */
function section(title, columns, note = '') {
  const used = title.length + (note ? note.length + 1 : 0) + 1
  /** @type {Row} */
  const row = [{ text: title, bold: true, color: TITLE_COLOR }]
  if (note) row.push({ text: ' ' + note, dim: true })
  row.push({ text: ' ' + '─'.repeat(Math.max(0, columns - used)), dim: true })
  return row
}

/**
 * One row per tool used, in the bar's category order, busiest first within one.
 * @param {Stats} stats
 * @param {Lookup[]} lookups
 * @param {number} columns
 * @returns {Row[]}
 */
function toolTable(stats, lookups, columns) {
  const order = (/** @type {string} */ name) =>
    CATEGORIES.findIndex((c) => c.id === categoryOf(name))
  const names = Object.keys(stats.byTool).sort(
    (a, b) => order(a) - order(b) || (stats.byTool[b]?.calls ?? 0) - (stats.byTool[a]?.calls ?? 0),
  )
  if (names.length === 0) return []
  const tableWidth = (/** @type {typeof TABLE} */ shown) =>
    2 + NAME_WIDTH + shown.reduce((sum, column) => sum + column.width, 0) + 2 + QUALITY_WIDTH
  let shown = TABLE
  for (const title of TABLE_DROPS) {
    if (tableWidth(shown) > columns) shown = shown.filter((column) => column.title !== title)
  }
  const heading =
    '  ' +
    'tool'.padEnd(NAME_WIDTH) +
    shown.map((column) => column.title.padStart(column.width)).join('') +
    '  quality'
  /** @type {Row[]} */
  const rows = [section('Per tool', columns), [{ text: heading, dim: true, truncate: true }]]
  for (const name of names) {
    const tool = stats.byTool[name]
    if (!tool) continue
    const metrics = lookupMetrics(lookups.filter((lookup) => lookup.name === name))
    const saved = metrics.measured > 0 ? '~' + formatTokens(metrics.saved) : '·'
    /** @type {Record<string, Span>} */
    const cells = {
      calls: { text: String(tool.calls) },
      ok:
        tool.errors > 0
          ? { text: String(tool.calls - tool.errors), color: FAILED }
          : { text: String(tool.calls) },
      avg: { text: formatMs(tool.ms / tool.calls), dim: true },
      '~tok': { text: '~' + formatTokens(tool.tokens) },
      saved: metrics.saved > 0 ? { text: saved, color: OK } : { text: saved, dim: true },
    }
    rows.push([
      { text: '■ ', color: colorOf(categoryOf(name)) },
      { text: cell(name, NAME_WIDTH) },
      ...shown.map((column) => {
        const span = cells[column.title] ?? { text: '' }
        return { ...span, text: span.text.padStart(column.width) }
      }),
      { text: '  ' + qualityText(name, tool, metrics), truncate: true },
    ])
  }
  return rows
}

/**
 * Spans padded with spaces to `width` cells, so the column after them lines up.
 * @param {Span[]} spans
 * @param {number} width
 * @returns {Row}
 */
function padded(spans, width) {
  const room = width - textLength(spans)
  return room > 0 ? [...spans, { text: ' '.repeat(room) }] : spans
}

/**
 * The /cortex-calls pane: the totals and measures, a row per tool, then the calls:
 * running ones first, then the recent ones, newest first. Every column has a fixed width
 * and only the last one in a row is cut to fit.
 * @param {Calls & { limit?: number, columns?: number }} input
 * @returns {Row[]}
 */
export function paneModel({ stats, recent, inFlight, lookups = [], limit = 40, columns = 80 }) {
  /** @type {Row} */
  const header = [
    { text: '◆ ', color: TITLE_COLOR, bold: true },
    { text: stats.total + ' cortex calls', bold: true },
  ]
  if (stats.errors > 0) header.push({ text: ' · ' + stats.errors + ' failed', color: FAILED })
  const rows = [header]

  if (stats.total === 0 && inFlight.length === 0) {
    rows.push([{ text: 'Nothing yet. Run /cs to start a cortex session.', dim: true }])
    return rows
  }

  const metrics = metricsSpans(stats, lookups)
  if (metrics.length > 0) rows.push(metrics)
  const table = toolTable(stats, lookups, columns)
  if (table.length > 0) rows.push([{ text: ' ' }], ...table)
  rows.push([{ text: ' ' }], section('Calls', columns, 'newest first'))

  const byId = new Map(lookups.map((lookup) => [lookup.toolUseId, lookup]))
  for (const call of [...inFlight].reverse()) {
    rows.push([
      { text: 'running ', dim: true },
      { text: ' ⟳ ', color: WAITING },
      { text: '■ ', color: colorOf(categoryOf(call.name)) },
      { text: cell(call.name, NAME_WIDTH) },
      { text: '  ' + call.args, dim: true, truncate: true },
    ])
  }
  const wide = columns >= WIDE_CALLS
  for (const call of [...recent].reverse().slice(0, limit)) {
    const lookup = byId.get(call.toolUseId)
    const parts = detailParts(call, lookup)
    const detail = joined(parts, ' · ').slice(1)
    /** @type {Row} */
    const row = [
      { text: clock(call.at), dim: true },
      call.ok ? { text: ' ✓ ', color: OK } : { text: ' ✗ ', color: FAILED },
      { text: '■ ', color: colorOf(call.category) },
      { text: cell(call.name, NAME_WIDTH) },
      { text: formatMs(call.ms).padStart(7), dim: true },
    ]
    /** @type {Span} */
    const last = call.error
      ? { text: '  ' + call.error, color: FAILED, truncate: true }
      : { text: '  ' + call.args, dim: true, truncate: true }
    if (wide) {
      row.push(
        { text: ('~' + formatTokens(call.tokens)).padStart(8), dim: true },
        { text: '  ' },
        ...padded(detail, DETAIL_WIDTH),
        last,
      )
    } else if (parts.length > 0 && call.ok) {
      // The result says more than the arguments. Where it does not fit, the file count
      // goes before the verdict does; what still does not fit is cut by fitRow.
      const room = columns - textLength(row) - 2
      const short = textLength(detail) > room && lookup ? parts.slice(1) : parts
      row.push({ text: '  ' }, ...joined(short, ' · ').slice(1))
    } else {
      row.push(last)
    }
    rows.push(fitRow(row, columns))
  }
  return rows
}

/**
 * A span as Text props, leaving out every prop it does not set.
 * @param {Span} span
 * @returns {import('claude-code').TextProps & { children: string }}
 */
export function textProps(span) {
  /** @type {import('claude-code').TextProps & { children: string }} */
  const props = { children: span.text }
  if (span.color) props.color = span.color
  if (span.bold) props.bold = true
  if (span.dim) props.dimColor = true
  if (span.truncate) props.wrap = 'truncate-end'
  return props
}
