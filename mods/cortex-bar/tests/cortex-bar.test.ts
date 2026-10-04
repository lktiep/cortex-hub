import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import {
  applyUse,
  barSegments,
  categoryOf,
  closeLookup,
  estimateTokens,
  fitRow,
  formatTokens,
  hitPaths,
  lookupMetrics,
  lookupState,
  newLookup,
  noteOpen,
  qualityOf,
  shortName,
  stepsFrom,
  summarizeArgs,
  withSizes,
} from '../hooks/model.js'

const ROOT = '/work'
const STATE = ROOT + '/.cortex/.session-state'
const CORTEX = (name: string): `mcp__${string}__${string}` => `mcp__cortex-hub__cortex_${name}`

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
  viewport: { columns: 100, rows: 30 },
} as const

const PANE = {
  component: 'Pane',
  requestId: 'cortex-calls',
  props: {
    title: 'Cortex calls',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
  viewport: { columns: 160, rows: 40 },
} as const

/** A cortex tool's row in the transcript, as the engine hands it to ToolUse hooks. */
function toolRow(
  id: string,
  name: string,
  flags: { isRunning?: boolean; isErrored?: boolean } = {},
) {
  return {
    component: 'ToolUse',
    requestId: id,
    props: {
      tool_use_id: id,
      tool: CORTEX(name),
      input: {},
      isRunning: flags.isRunning ?? false,
      isErrored: flags.isErrored ?? false,
      isInterrupted: false,
    },
    viewport: { columns: 72, rows: 40 },
  } as const
}

type World = {
  /** The files in .cortex/.session-state, or null for a project without one. */
  markers?: Record<string, string> | null
  /** How long a cortex tool takes, by short name, on the mocked clock. */
  slow?: Record<string, number>
  /** What a cortex tool answers, by short name, as core hands it on: `text` set. */
  outputs?: Record<string, string>
  /** Sizes in bytes of the files in the project, by absolute path. */
  files?: Record<string, number>
}

/** A code_search answer in the hub's own shape. */
const SEARCH = [
  '🔍 Search: "where are api keys verified"',
  '',
  'Found 1 execution flow(s):',
  '',
  '1. VerifyKey → HashKey (2 steps, 2 symbols)',
  '   undefined verifyKey → apps/api/src/auth.ts:12',
  '   undefined hashKey → apps/api/src/hash.ts:40',
  '',
  'Standalone definitions:',
  '  Symbol auth.ts → apps/api/src/auth.ts',
  '---',
  'Next: Pick a symbol above and run cortex_code_context "<name>" to see its callers.',
].join('\n')

/** A knowledge_search answer in the hub's own shape. */
const KNOWLEDGE = [
  '### Result 1: [docs/session.md] Session summary (ID: kdoc-1, Chunk: 0, Score: 0.611)',
  '',
  'What was done.',
  '',
  '### Result 2: Lessons (ID: kdoc-2, Chunk: 1, Score: 0.402)',
  '',
  'Score: 0.990 inside a body does not count.',
].join('\n')

/**
 * What lies beneath the plugin: a session at /work, the hooks' markers, the hub. `ids`
 * collects the tool_use_id of each cortex call, in the order they reached the hub.
 */
function world(on: On, { markers = null, slow = {}, outputs = {}, files = {} }: World = {}) {
  const clock = mock.clock(on, { now: 1_000 })
  const ids: string[] = []
  mock.store(on)
  on('session.start', () => ({ cwd: ROOT }))
  on('session.root', () => ({ value: ROOT }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['prompt'] }))
  on('fs.exists', (_$, e) => ({ value: markers !== null && e.path === STATE }))
  on('fs.list', () => ({
    value: Object.entries(markers ?? {}).map(([name, text]) => ({
      name,
      kind: 'file' as const,
      size: text.length,
      mtimeMs: 0,
      isLink: false,
    })),
  }))
  on('fs.read', (_$, e) => ({ value: markers?.[e.path.slice(STATE.length + 1)] ?? '' }))
  on('fs.stat', (_$, e) => {
    const size = files[e.path]
    if (size === undefined) throw new Error('ENOENT: ' + e.path)
    return { value: { kind: 'file' as const, size, mtimeMs: 0, isLink: false } }
  })
  on('tool.call', async (_$, e) => {
    ids.push(e.tool_use_id)
    const name = shortName(e.tool)
    const delay = slow[name]
    if (delay) await clock.sleep(delay)
    if (name.endsWith('_fail')) return { result: 'hub said no', isError: true }
    const text = outputs[name]
    if (text !== undefined) return { result: text, text }
    return { result: 'ok' }
  })
  return { clock, ids }
}

async function texts(ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }) {
  return (await ui.findAll({ type: 'Text' })).map((t) => t.text)
}

/** The dot drawn before a checklist label: ● done, ◐ partial, ○ not yet. */
async function dotBefore(
  ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> },
  label: string,
) {
  const all = await texts(ui)
  const at = all.findIndex((text) => text.trim() === label)
  return at > 0 ? all[at - 1] : undefined
}

describe('model', () => {
  test('tool names map to their category', async () => {
    expect(shortName('mcp__cortex-hub__cortex_code_search')).toBe('code_search')
    expect(shortName('mcp__my_hub__cortex_session_start')).toBe('session_start')
    expect(categoryOf('session_start')).toBe('session')
    expect(categoryOf('changes')).toBe('session')
    expect(categoryOf('knowledge_search')).toBe('knowledge')
    expect(categoryOf('memory_store')).toBe('memory')
    expect(categoryOf('cypher')).toBe('code')
    expect(categoryOf('detect_changes')).toBe('code')
    expect(categoryOf('plan_quality')).toBe('quality')
    expect(categoryOf('task_pickup')).toBe('tasks')
    expect(categoryOf('something_new')).toBe('other')
  })

  test('the argument hint prefers the query and never shows a credential', async () => {
    expect(summarizeArgs({ tool: 'x', apiKey: 'sk-live-1', query: 'hello \n  world' })).toBe(
      'query=hello world',
    )
    expect(summarizeArgs({ tool: 'x', token: 'abc', authorization: 'Bearer abc' })).toBe('')
    expect(summarizeArgs({ tool_use_id: 'toolu_1', agentId: 'claude-code', repo: 'hub' })).toBe(
      'repo=hub',
    )
    expect(summarizeArgs({ query: 'q'.repeat(80) }).length).toBe('query='.length + 48)
  })

  test('the bar fills its width and keeps a cell for every category used', async () => {
    const segments = barSegments({ session: 1, code: 30, knowledge: 1 }, 20)
    expect(segments.map((s) => s.id)).toEqual(['session', 'knowledge', 'code'])
    expect(segments.reduce((sum, s) => sum + s.width, 0)).toBe(20)
    expect(Math.min(...segments.map((s) => s.width))).toBe(1)
    expect(barSegments({}, 20)).toEqual([])
  })

  test('recall is partial until both searches ran, gates need the markers', async () => {
    const one = stepsFrom(['session_start', 'knowledge_search'], null)
    expect(one.steps.map((s) => s.state)).toEqual(['done', 'partial', 'todo', 'todo'])
    expect(one.gates).toBe(null)
    const all = stepsFrom([], ['memory-recalled', 'knowledge-recalled', 'quality-gates-passed'])
    expect(all.steps[1]?.state).toBe('done')
    expect(all.gates?.map((s) => s.state)).toEqual(['done', 'done', 'done', 'todo'])
  })
})

describe('band', () => {
  test('counts cortex calls by category on terminal and desktop', async ($, on) => {
    world(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })
    await $.tool.call({ tool: CORTEX('session_start'), repo: 'cortex-hub' })
    await $.tool.call({ tool: CORTEX('knowledge_search'), query: 'session summary' })
    await $.tool.call({ tool: CORTEX('memory_search'), query: 'decisions' })
    await $.tool.call({ tool: CORTEX('code_search'), query: 'hybrid search' })

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'cortex-bar', surface, ...BAND })
      const shown = await texts(ui)
      expect(shown).toContain('◆ cortex ')
      expect(shown).toContain(' 4 calls')
      expect(shown).toContain('knowledge 1  ')
      expect(shown).toContain('code 1  ')
      expect(shown.some((t) => t.startsWith(' · last code_search'))).toBe(true)
      expect(await dotBefore(ui, 'session')).toBe('●')
      expect(await dotBefore(ui, 'recall')).toBe('●')
      expect(await dotBefore(ui, 'changes')).toBe('○')
      expect(shown).toContain('prompt')
      await ui.unmount()
    }
  })

  test('a new cortex_session_start starts the counts over', async ($, on) => {
    world(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })
    await $.tool.call({ tool: CORTEX('session_start'), repo: 'a' })
    await $.tool.call({ tool: CORTEX('code_search'), query: 'x' })
    await $.tool.call({ tool: CORTEX('session_start'), repo: 'b' })

    const ui = await $.ui.mount({ plugin: 'cortex-bar', surface: 'terminal', ...BAND })
    expect(await texts(ui)).toContain(' 1 call')
    await ui.unmount()
  })

  test('a failed call counts as an error and marks the last call', async ($, on) => {
    world(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })
    await $.tool.call({ tool: CORTEX('session_start'), repo: 'cortex-hub' })
    await $.tool.call({ tool: CORTEX('code_fail'), query: 'x' })

    const ui = await $.ui.mount({ plugin: 'cortex-bar', surface: 'terminal', ...BAND })
    const shown = await texts(ui)
    expect(shown).toContain(' · 1 err')
    expect(shown).toContain('✗')
    await ui.unmount()
  })

  test('shows the call in flight, then its time', async ($, on) => {
    const { clock } = world(on, { slow: { code_search: 250 } })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })
    await $.tool.call({ tool: CORTEX('session_start'), repo: 'cortex-hub' })

    const pending = $.tool.call({ tool: CORTEX('code_search'), query: 'slow one' })
    await clock.settle()
    const during = await $.ui.mount({ plugin: 'cortex-bar', surface: 'terminal', ...BAND })
    expect(await texts(during)).toContain('⟳ code_search')
    await during.unmount()

    await clock.advance(250)
    await pending
    const after = await $.ui.mount({ plugin: 'cortex-bar', surface: 'terminal', ...BAND })
    expect(await texts(after)).toContain(' · last code_search 250ms ')
    await after.unmount()
  })

  test('/cortex-bar off hides the band and on brings it back', async ($, on) => {
    world(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })
    await $.tool.call({ tool: CORTEX('session_start'), repo: 'cortex-hub' })
    const run = (args: string) =>
      $.command.run({
        command: 'cortex-bar',
        args,
        origin: { kind: 'composer' },
        presentation: { isFullscreen: false, columns: 100 },
      })

    expect((await run('off')).text).toMatch(/hidden/)
    const hidden = await $.ui.mount({ plugin: 'cortex-bar', surface: 'terminal', ...BAND })
    expect(await texts(hidden)).toEqual(['prompt'])
    await hidden.unmount()

    expect((await run('on')).text).toMatch(/shown/)
    const shown = await $.ui.mount({ plugin: 'cortex-bar', surface: 'terminal', ...BAND })
    expect(await texts(shown)).toContain('◆ cortex ')
    await shown.unmount()
  })

  test('the hooks markers turn the /cs steps and the gates green', async ($, on) => {
    world(on, {
      markers: {
        'session-started': 'tool=cortex_session_start at=2026-10-03T10:00:00Z',
        'knowledge-recalled': 'tool=cortex_knowledge_search at=2026-10-03T10:00:01Z',
        'memory-recalled': 'tool=cortex_memory_search at=2026-10-03T10:00:01Z',
        'gate-build': 'tool=Bash at=2026-10-03T10:05:00Z',
        'gate-lint': '',
        'gate-typecheck': 'touched by hand',
      },
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })

    const ui = await $.ui.mount({ plugin: 'cortex-bar', surface: 'terminal', ...BAND })
    expect(await dotBefore(ui, 'session')).toBe('●')
    expect(await dotBefore(ui, 'recall')).toBe('●')
    expect(await dotBefore(ui, 'tasks')).toBe('○')
    expect(await dotBefore(ui, 'build')).toBe('●')
    expect(await dotBefore(ui, 'typecheck')).toBe('○')
    expect(await dotBefore(ui, 'lint')).toBe('○')
    expect(await texts(ui)).toContain(' 0 calls')
    await ui.unmount()
  })

  test('outside a cortex project nothing is drawn until a cortex call', async ($, on) => {
    world(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })
    const before = await $.ui.mount({ plugin: 'cortex-bar', surface: 'terminal', ...BAND })
    expect(await texts(before)).toEqual(['prompt'])
    await before.unmount()

    await $.tool.call({ tool: CORTEX('health') })
    const after = await $.ui.mount({ plugin: 'cortex-bar', surface: 'terminal', ...BAND })
    expect(await texts(after)).toContain(' 1 call')
    await after.unmount()
  })

  test('a cortex project before /cs gets a hint', async ($, on) => {
    world(on, { markers: {} })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })
    const ui = await $.ui.mount({ plugin: 'cortex-bar', surface: 'terminal', ...BAND })
    expect(await texts(ui)).toContain('no cortex session yet — run /cs')
    await ui.unmount()
  })

  test('a short band keeps the bar and drops the legend first', async ($, on) => {
    world(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })
    await $.tool.call({ tool: CORTEX('session_start'), repo: 'cortex-hub' })
    const props = { ...BAND.props, maxRows: 2 }
    const ui = await $.ui.mount({ plugin: 'cortex-bar', surface: 'terminal', ...BAND, props })
    const shown = await texts(ui)
    expect(shown).toContain(' 1 call')
    expect(shown).toContain('/cs ')
    expect(shown).not.toContain('session 1  ')
    await ui.unmount()
  })
})

describe('pane', () => {
  test('/cortex-calls lists the calls newest first', async ($, on) => {
    world(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })
    await $.tool.call({ tool: CORTEX('session_start'), repo: 'cortex-hub' })
    await $.tool.call({ tool: CORTEX('memory_search'), query: 'lessons', apiKey: 'sk-live-1' })
    const opened = await $.command.run({
      command: 'cortex-calls',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 160 },
    })
    expect(opened.text).toBeUndefined()

    const ui = await $.ui.mount({ plugin: 'cortex-bar', surface: 'terminal', ...PANE })
    const shown = await texts(ui)
    expect(shown).toContain('2 cortex calls')
    const calls = shown.slice(shown.indexOf('Calls'))
    const memory = calls.findIndex((t) => t.startsWith('memory_search'))
    const session = calls.findIndex((t) => t.startsWith('session_start'))
    expect(memory).toBeGreaterThan(0)
    expect(session).toBeGreaterThan(memory)
    expect(shown).toContain('  query=lessons')
    expect(shown.some((t) => t.includes('sk-live-1'))).toBe(false)
    await ui.unmount()
  })
})

describe('editor', () => {
  test('in VS Code the newest cortex row carries the bar and every row a tag', async ($, on) => {
    const { clock, ids } = world(on, { slow: { code_search: 233 } })
    await $.session.start({ surface: 'vscode', isInteractive: true, cwd: ROOT })
    await $.tool.call({ tool: CORTEX('session_start'), repo: 'cortex-hub' })
    await $.tool.call({ tool: CORTEX('knowledge_search'), query: 'session summary' })
    const pending = $.tool.call({ tool: CORTEX('code_search'), query: 'hybrid search' })
    await clock.settle()
    await clock.advance(233)
    await pending
    const [first, , newest] = ids as [string, string, string]

    const latest = await $.ui.mount({
      plugin: 'cortex-bar',
      surface: 'vscode',
      ...toolRow(newest, 'code_search'),
    })
    const shown = await texts(latest)
    expect(shown[0]).toBe('prompt')
    expect(shown).toContain('■ code')
    expect(shown).toContain(' · 233ms ')
    expect(shown).toContain('✓')
    expect(shown).toContain('◆ cortex ')
    expect(shown).toContain(' 3 calls')
    expect(await dotBefore(latest, 'recall')).toBe('◐')
    await latest.unmount()

    const older = await $.ui.mount({
      plugin: 'cortex-bar',
      surface: 'vscode',
      ...toolRow(first, 'session_start'),
    })
    const olderShown = await texts(older)
    expect(olderShown).toContain('■ session')
    expect(olderShown).not.toContain('◆ cortex ')
    await older.unmount()
  })

  test('the terminal tags the row and leaves the bar above the prompt', async ($, on) => {
    const { ids } = world(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })
    await $.tool.call({ tool: CORTEX('memory_search'), query: 'lessons' })
    const row = toolRow(ids[0] ?? '', 'memory_search')
    const ui = await $.ui.mount({ plugin: 'cortex-bar', surface: 'terminal', ...row })
    const shown = await texts(ui)
    expect(shown).toContain('■ memory')
    expect(shown).not.toContain('◆ cortex ')
    await ui.unmount()
  })

  test('a running row spins, a failed one is crossed, other tools are left alone', async ($, on) => {
    world(on)
    await $.session.start({ surface: 'vscode', isInteractive: true, cwd: ROOT })
    const running = await $.ui.mount({
      plugin: 'cortex-bar',
      surface: 'vscode',
      ...toolRow('toolu_run', 'code_impact', { isRunning: true }),
    })
    expect(await texts(running)).toContain('⟳')
    await running.unmount()

    const failed = await $.ui.mount({
      plugin: 'cortex-bar',
      surface: 'vscode',
      ...toolRow('toolu_bad', 'task_pickup', { isErrored: true }),
    })
    expect(await texts(failed)).toEqual(['prompt', '■ tasks', ' ', '✗'])
    await failed.unmount()

    const bash = toolRow('toolu_sh', 'x')
    const other = await $.ui.mount({
      plugin: 'cortex-bar',
      surface: 'vscode',
      ...bash,
      props: { ...bash.props, tool: 'Bash', input: { command: 'ls' } },
    })
    expect(await texts(other)).toEqual(['prompt'])
    await other.unmount()
  })

  test('/cortex-bar off takes the tags off the rows', async ($, on) => {
    const { ids } = world(on)
    await $.session.start({ surface: 'vscode', isInteractive: true, cwd: ROOT })
    await $.tool.call({ tool: CORTEX('session_start'), repo: 'cortex-hub' })
    await $.command.run({
      command: 'cortex-bar',
      args: 'off',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 72 },
    })
    const row = toolRow(ids[0] ?? '', 'session_start')
    const ui = await $.ui.mount({ plugin: 'cortex-bar', surface: 'vscode', ...row })
    expect(await texts(ui)).toEqual(['prompt'])
    await ui.unmount()
  })

  test('a folded group counts its cortex calls and carries the bar', async ($, on) => {
    const { ids } = world(on)
    await $.session.start({ surface: 'vscode', isInteractive: true, cwd: ROOT })
    await $.tool.call({ tool: CORTEX('session_start'), repo: 'cortex-hub' })
    await $.tool.call({ tool: CORTEX('code_search'), query: 'a' })
    await $.tool.call({ tool: CORTEX('code_context'), name: 'b' })
    const call = (id: string | undefined, name: string) => ({
      tool_use_id: id,
      tool: CORTEX(name),
      input: {},
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
    })
    const ui = await $.ui.mount({
      plugin: 'cortex-bar',
      surface: 'vscode',
      component: 'ToolGroup',
      requestId: 'group-1',
      props: {
        calls: [
          call(ids[1], 'code_search'),
          { ...call('toolu_read', 'x'), tool: 'Read' },
          call(ids[2], 'code_context'),
        ],
        isActive: false,
        isExpanded: false,
      },
      viewport: { columns: 72, rows: 40 },
    })
    const shown = await texts(ui)
    expect(shown).toContain('code 2  ')
    expect(shown).toContain('◆ cortex ')
    await ui.unmount()
  })

  test('the pane opens with the bar where the band cannot show', async ($, on) => {
    world(on)
    await $.session.start({ surface: 'vscode', isInteractive: true, cwd: ROOT })
    await $.tool.call({ tool: CORTEX('session_start'), repo: 'cortex-hub' })
    await $.tool.call({ tool: CORTEX('task_pickup') })

    const editor = await $.ui.mount({ plugin: 'cortex-bar', surface: 'vscode', ...PANE })
    const shown = await texts(editor)
    expect(shown).toContain('◆ cortex ')
    expect(await dotBefore(editor, 'tasks')).toBe('●')
    expect(shown.indexOf('2 cortex calls')).toBeGreaterThan(shown.indexOf('◆ cortex '))
    await editor.unmount()

    const terminal = await $.ui.mount({ plugin: 'cortex-bar', surface: 'terminal', ...PANE })
    expect(await texts(terminal)).not.toContain('◆ cortex ')
    await terminal.unmount()
  })
})

const FILES = { '/work/apps/api/src/auth.ts': 4000, '/work/apps/api/src/hash.ts': 8000 }

describe('measures', () => {
  test('a lookup result yields its files in rank order, not URLs or scores', async () => {
    expect(hitPaths(SEARCH)).toEqual(['apps/api/src/auth.ts', 'apps/api/src/hash.ts'])
    const context = [
      'Function formatSearchResults → apps/dashboard-api/src/routes/intel.ts:387-461',
      '  ← [calls] undefined intel.ts → apps/dashboard-api/src/routes/intel.ts',
      '  → [uses] undefined Pane → ./mods/cortex-bar/hooks/register.js',
    ].join('\n')
    expect(hitPaths(context)).toEqual([
      'apps/dashboard-api/src/routes/intel.ts',
      'mods/cortex-bar/hooks/register.js',
    ])
    const impact =
      '{"raw": "d=1: WILL BREAK\\n  undefined rewrite → apps/api/src/intel.ts [CALLS] (conf: 0.85)"}'
    expect(hitPaths(impact)).toEqual(['apps/api/src/intel.ts'])
    const noise = [
      'repo=https://github.com/lktiep/cortex-hub.git and git@github.com:lktiep/cortex-hub.git',
      'Total Score: 7.5/10, see [templates/workflows/continue.md]',
    ].join('\n')
    expect(hitPaths(noise)).toEqual(['templates/workflows/continue.md'])
    const many = Array.from({ length: 14 }, (_, i) => `→ src/f${i}.ts`).join('\n')
    expect(hitPaths(many)).toHaveLength(10)
  })

  test('searches and checks say how their result read', async () => {
    expect(qualityOf('knowledge_search', KNOWLEDGE)).toEqual({
      kind: 'found',
      ok: true,
      tag: '2 found · top 0.61',
    })
    expect(qualityOf('knowledge_search', 'No results.')).toEqual({
      kind: 'found',
      ok: false,
      tag: 'nothing found',
    })
    expect(qualityOf('memory_search', '### Memory 1 (ID: m1) [Scope: claude-code]\n\nx')?.tag).toBe(
      '1 found',
    )
    expect(qualityOf('detect_changes', '{ "risk_level": "low", "symbols": [] }')).toEqual({
      kind: 'risk known',
      ok: true,
      tag: 'risk low',
    })
    expect(qualityOf('detect_changes', '{"risk_level":"unknown"}')?.ok).toBe(false)
    expect(qualityOf('plan_quality', '  Total Score: 7.5/10  NEEDS IMPROVEMENT')).toEqual({
      kind: 'passed',
      ok: false,
      tag: '7.5/10',
    })
    expect(qualityOf('plan_quality', '  Total Score: 8.6/10  APPROVED')?.ok).toBe(true)
    expect(qualityOf('code_search', SEARCH)).toBeUndefined()
  })

  test('opening a hit sets its rank, another file is a stray, closing judges', async () => {
    const paths = ['apps/a.ts', 'apps/b.ts', 'apps/c.ts']
    const base = withSizes(
      newLookup({ toolUseId: 't1', name: 'code_search', epoch: 0, returned: 100, paths }),
      [4000, 8000, 400],
    )
    expect(base.hits.map((hit) => hit.tokens)).toEqual([1000, 2000, 100])

    const read = noteOpen(base, { path: '/work/apps/b.ts', stray: 'apps/b.ts' })
    expect(read.used).toBe(2)
    expect(lookupState(read)).toBe('used')
    expect(noteOpen(read, { command: "sed -n '1,40p' apps/a.ts" }).used).toBe(1)
    expect(noteOpen(base, { command: 'cat apps/a.tsx' }).used).toBe(null)

    const stray = noteOpen(base, { path: '/work/apps/z.ts', stray: 'apps/z.ts' })
    expect(lookupState(stray)).toBe('open')
    expect(lookupState(closeLookup(stray))).toBe('missed')
    expect(lookupState(closeLookup(base))).toBe('unused')

    // 3100 behind, 100 returned, 2000 of it opened anyway.
    const metrics = lookupMetrics([read, closeLookup(stray), closeLookup(base)])
    expect(metrics).toMatchObject({ used: 1, missed: 1, at1: 0, at3: 1, at10: 1 })
    expect(metrics.saved).toBe(1000 + 3000)
    expect(metrics.measured).toBe(3)
  })

  test('a file counts for every open lookup that returned it', async () => {
    const older = newLookup({
      toolUseId: 't1',
      name: 'code_search',
      epoch: 0,
      returned: 1,
      paths: ['apps/a.ts', 'apps/b.ts'],
    })
    const newer = newLookup({
      toolUseId: 't2',
      name: 'code_context',
      epoch: 0,
      returned: 1,
      paths: ['apps/c.ts'],
    })
    const [a, b] = applyUse([older, newer], { path: '/work/apps/b.ts', stray: 'apps/b.ts' })
    expect(a?.used).toBe(2)
    expect(b?.strays).toEqual([])
    const [c, d] = applyUse([older, newer], { path: '/work/x.ts', stray: 'x.ts' })
    expect(c?.strays).toEqual([])
    expect(d?.strays).toEqual(['x.ts'])
  })

  test('token counts read as k and M', async () => {
    expect(estimateTokens('abcde')).toBe(2)
    expect(formatTokens(840)).toBe('840')
    expect(formatTokens(6_240)).toBe('6.2k')
    expect(formatTokens(120_400)).toBe('120k')
    expect(formatTokens(1_240_000)).toBe('1.2M')
  })

  test('a lookup row shows its tokens, the files behind it and the one opened', async ($, on) => {
    const { clock, ids } = world(on, { outputs: { code_search: SEARCH }, files: FILES })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })
    await $.tool.call({ tool: CORTEX('code_search'), query: 'api keys' })
    await clock.settle()
    await $.tool.call({ tool: 'Read', file_path: '/work/apps/api/src/hash.ts' })

    const ui = await $.ui.mount({
      plugin: 'cortex-bar',
      surface: 'terminal',
      ...toolRow(ids[0] ?? '', 'code_search'),
    })
    const shown = await texts(ui)
    expect(shown).toContain('~' + formatTokens(estimateTokens(SEARCH)) + ' tok')
    expect(shown).toContain('2 files ~3.0k')
    expect(shown).toContain('used #2')
    await ui.unmount()
  })

  test('a command naming a hit counts, a Read elsewhere then newer lookups miss', async ($, on) => {
    const { clock, ids } = world(on, { outputs: { code_search: SEARCH }, files: FILES })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })
    await $.tool.call({ tool: CORTEX('code_search'), query: 'api keys' })
    await $.tool.call({ tool: 'Bash', command: "sed -n '1,40p' apps/api/src/auth.ts" })
    await $.tool.call({ tool: CORTEX('code_search'), query: 'rate limits' })
    await $.tool.call({ tool: 'Read', file_path: '/work/apps/api/src/limits.ts' })
    for (const query of ['a', 'b', 'c']) {
      await $.tool.call({ tool: CORTEX('code_search'), query })
    }
    await clock.settle()

    const [first, , second] = ids
    const used = await $.ui.mount({
      plugin: 'cortex-bar',
      surface: 'terminal',
      ...toolRow(first ?? '', 'code_search'),
    })
    expect(await texts(used)).toContain('used #1')
    await used.unmount()
    const missed = await $.ui.mount({
      plugin: 'cortex-bar',
      surface: 'terminal',
      ...toolRow(second ?? '', 'code_search'),
    })
    expect(await texts(missed)).toContain('missed')
    await missed.unmount()
  })

  test('the band adds tokens in, tokens saved and hit@k', async ($, on) => {
    const { clock } = world(on, { outputs: { code_search: SEARCH }, files: FILES })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })
    await $.tool.call({ tool: CORTEX('session_start'), repo: 'cortex-hub' })
    await $.tool.call({ tool: CORTEX('code_search'), query: 'api keys' })
    await clock.settle()
    await $.tool.call({ tool: 'Read', file_path: '/work/apps/api/src/hash.ts' })

    const ui = await $.ui.mount({ plugin: 'cortex-bar', surface: 'terminal', ...BAND })
    const shown = await texts(ui)
    const returned = estimateTokens(SEARCH)
    expect(shown).toContain('tokens ')
    expect(shown).toContain('~' + formatTokens(returned + 1) + ' in')
    expect(shown).toContain('~' + formatTokens(3000 - returned - 2000) + ' saved')
    expect(shown).toContain('hit@1 0/1 · hit@3 1/1 · hit@10 1/1')
    await ui.unmount()
  })

  test('the pane has a row per tool with its quality', async ($, on) => {
    const { clock } = world(on, {
      outputs: {
        code_search: SEARCH,
        knowledge_search: KNOWLEDGE,
        plan_quality: '  Total Score: 7.5/10  NEEDS IMPROVEMENT',
      },
      files: FILES,
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })
    await $.tool.call({ tool: CORTEX('knowledge_search'), query: 'session summary' })
    await $.tool.call({ tool: CORTEX('code_search'), query: 'api keys' })
    await clock.settle()
    await $.tool.call({ tool: 'Read', file_path: '/work/apps/api/src/auth.ts' })
    await $.tool.call({ tool: CORTEX('plan_quality'), plan: 'x' })

    const ui = await $.ui.mount({ plugin: 'cortex-bar', surface: 'terminal', ...PANE })
    const shown = await texts(ui)
    const table = shown.slice(shown.indexOf('Per tool'), shown.indexOf('Calls'))
    expect(table.some((t) => t.startsWith('knowledge_search'))).toBe(true)
    expect(table).toContain('  1/1 found · last 2 found · top 0.61')
    expect(table).toContain('  hit@1 1/1 · hit@3 1/1 · hit@10 1/1')
    expect(table).toContain('  0/1 passed · last 7.5/10')
    const calls = shown.slice(shown.indexOf('Calls'))
    expect(calls).toContain('7.5/10')
    expect(calls).toContain('used #1')
    await ui.unmount()
  })
})

describe('narrow', () => {
  test('a row wider than its room is cut with an ellipsis, never wrapped', async () => {
    const row = [{ text: 'abcdef' }, { text: 'ghij', truncate: true }, { text: 'klmnop' }]
    expect(fitRow(row, 20)).toBe(row)
    expect(fitRow(row, 12)).toBe(row)
    expect(fitRow(row, undefined)).toBe(row)
    expect(fitRow(row, 8).map((span) => span.text)).toEqual(['abcdef', 'k', '…'])
  })

  test('a narrow pane drops table columns and call tokens before the results', async ($, on) => {
    const { clock } = world(on, { outputs: { code_search: SEARCH }, files: FILES })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })
    await $.tool.call({ tool: CORTEX('session_start'), repo: 'cortex-hub' })
    await $.tool.call({ tool: CORTEX('task_submit_strategy'), taskId: 't1' })
    await $.tool.call({ tool: CORTEX('code_search'), query: 'api keys' })
    await clock.settle()
    await $.tool.call({ tool: 'Read', file_path: '/work/apps/api/src/hash.ts' })

    const props = { ...PANE.props, bodyColumns: 62 }
    const ui = await $.ui.mount({ plugin: 'cortex-bar', surface: 'terminal', ...PANE, props })
    const shown = await texts(ui)
    expect(shown).toContain('  tool               calls   saved  quality')
    expect(shown).toContain('task_submit_stra… ')
    const calls = shown.slice(shown.indexOf('Calls'))
    expect(calls).toContain('used #2')
    expect(calls.some((text) => /^ +~\d/.test(text))).toBe(false)
    await ui.unmount()
  })

  test('a narrow band shortens the /cs checklist, then folds it to dots', async ($, on) => {
    world(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })
    await $.tool.call({ tool: CORTEX('session_start'), repo: 'cortex-hub' })
    const wide = await $.ui.mount({ plugin: 'cortex-bar', surface: 'terminal', ...BAND })
    expect(await texts(wide)).toContain(' session  ')
    await wide.unmount()
    const tight = { ...BAND.props, bodyColumns: 42 }
    const shorter = await $.ui.mount({
      plugin: 'cortex-bar',
      surface: 'terminal',
      ...BAND,
      props: tight,
    })
    expect(await texts(shorter)).toContain(' session ')
    await shorter.unmount()
    const props = { ...BAND.props, bodyColumns: 36 }
    const ui = await $.ui.mount({ plugin: 'cortex-bar', surface: 'terminal', ...BAND, props })
    const shown = await texts(ui)
    expect(shown.some((text) => text.startsWith(' session'))).toBe(false)
    expect(shown).toContain(' recall  ')
    await ui.unmount()
  })
})
