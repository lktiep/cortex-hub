import type { Env } from '../types.js'
import { apiCall } from '../api-call.js'
import { fetchOutline, formatCodeMatches, outlineFiles, type CodeMatch, type OutlineSymbol } from './code-matches.js'

// What cortex_session_start answers when it is told the task. Measured in the agent benchmark,
// every session opened with the same four calls — start, knowledge, memory, code search — on
// the same words, and read ~11k characters back, ~3k of them a generic "last session" brief that
// was a workflow template. Asked once with the task, the hub runs the three searches itself and
// answers each in a few lines. The `recalled:` and `located:` lines are what the client hooks
// take as evidence that the recall and the lookup ran.

export const RECALL_LIMIT = 3
const LINE_CHARS = 180
// A session summary ends with what was left to do, past the first 180 characters.
const SUMMARY_CHARS = 600

const oneLine = (text: string, max = LINE_CHARS) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export interface KnowledgeLine { documentId?: string; title?: string; content?: string; deprecated?: boolean; score?: number }
export interface MemoryLine { id?: string; memory?: string; createdAt?: string; metadata?: { type?: string } }

// Whatever ranked first came back, related or not: in the benchmark every start carried three
// notes and three memories, ~1k characters, none about the task. Measured on the hub's own
// store, notes about the task score 0.5–0.64 and unrelated ones 0.32–0.44. A memory's score is
// relative to the best one, so it says nothing on its own; a memory is kept when it shares a
// distinctive word with the task.
export const KNOWLEDGE_MIN_SCORE = 0.5
const COMMON = new Set([
  'add', 'all', 'and', 'any', 'are', 'but', 'can', 'fix', 'for', 'get', 'has', 'how', 'its', 'new', 'not', 'now',
  'one', 'out', 'per', 'set', 'the', 'use', 'via', 'was', 'way', 'why', 'you',
  'about', 'after', 'also', 'before', 'change', 'code', 'does', 'each', 'file', 'files', 'from', 'have', 'into',
  'make', 'more', 'need', 'only', 'should', 'some', 'than', 'that', 'them', 'then', 'there', 'this', 'update',
  'used', 'using', 'what', 'when', 'where', 'which', 'will', 'with', 'work', 'would',
])

/** The distinctive words of a text: camelCase and snake_case split, lower case, a plural's s dropped. */
export function terms(text: string): Set<string> {
  const words = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/)
  const kept = words.filter((w) => w.length >= 3 && !COMMON.has(w))
  return new Set(kept.map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)))
}

// A word's first six letters, so "deprecation" meets "deprecated" and "configure" meets "config".
const stem = (word: string) => word.slice(0, 6)

const sharesTerm = (task: Set<string>, text: string) => {
  const stems = new Set([...task].map(stem))
  return [...terms(text)].some((t) => stems.has(stem(t)))
}

const isSummary = (m: MemoryLine) => m.metadata?.type === 'session-summary'

export function formatTaskRecall(task: string, knowledge: KnowledgeLine[] | undefined, memories: MemoryLine[] | undefined): string {
  if (!knowledge || !memories) return ''
  const head = `recalled: knowledge+memory for "${oneLine(task, 120)}"`
  if (!knowledge.length && !memories.length) return `${head} — nothing stored is close to it.`
  const out = [head]
  if (knowledge.length) {
    out.push('Knowledge (full text: cortex_knowledge_search id):',
      ...knowledge.map((k) => `- ${oneLine(k.title ?? '', 90)} — ${oneLine(k.content ?? '')} (${k.documentId})`))
  }
  if (memories.length) out.push('Memory:', ...memories.map((m) => `- ${oneLine(m.memory ?? '', isSummary(m) ? SUMMARY_CHARS : LINE_CHARS)}`))
  return out.join('\n')
}

export function formatTaskLocation(task: string, matches: CodeMatch[], symbols: OutlineSymbol[]): string {
  const files = formatCodeMatches(matches, 0, symbols)
  if (!files) return ''
  return [`located: code for "${oneLine(task, 120)}"`, files].join('\n')
}

const ORG_REPOS_LISTED = 20

/**
 * The repos grouped with this one, which an agent cannot see from its checkout. Without this line
 * it searched only what was on disk: a question answered in a sibling repo went to the hub once
 * or not at all.
 */
export function formatOrgRepos(names: string[] | undefined): string {
  if (!names?.length) return ''
  const listed = names.slice(0, ORG_REPOS_LISTED).join(', ') + (names.length > ORG_REPOS_LISTED ? ', …' : '')
  return `searchable: ${names.length} other repo(s) of this organization, not on disk here — ${listed}.\n` +
    'cortex_code_search without repo ranks files across them; cortex_code_grep finds an exact string (a constant, an opcode, an error text) in them, ' +
    'and with files: true names every file that mentions a word (encrypt|cipher) — sweep that way before reading.'
}

/** Knowledge for the task: undefined when the search did not answer. */
async function searchKnowledge(env: Env, task: string, alreadyInContext: (title?: string) => boolean): Promise<KnowledgeLine[] | undefined> {
  const res = await apiCall(env, '/api/knowledge/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // No project: the hub reads the session project's own and the hub-wide notes.
    body: JSON.stringify({ query: task, limit: RECALL_LIMIT * 2 }),
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) return undefined
  const data = (await res.json()) as { results?: KnowledgeLine[] }
  const seen = new Set<string>()
  return (data.results ?? []).filter((r) => {
    if (!r.documentId || r.deprecated || (r.score ?? 0) < KNOWLEDGE_MIN_SCORE || alreadyInContext(r.title) || seen.has(r.documentId)) return false
    seen.add(r.documentId)
    return true
  }).slice(0, RECALL_LIMIT)
}

/**
 * The project's memories that share a word with the task, after its last session summary;
 * undefined when the search did not answer. Only the project's: the agent's own scope held what
 * it had stored for every other project too, and a common word like "commit" let those through.
 * The summary comes whatever the words: "pick up where we left off" names nothing it holds.
 */
async function searchMemory(env: Env, task: string, projectId: string | undefined, agentId: string): Promise<MemoryLine[] | undefined> {
  const res = await apiCall(env, '/api/mem9/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: task, userId: projectId ? `project-${projectId}` : agentId, limit: RECALL_LIMIT * 2 }),
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) return undefined
  const memories = ((await res.json()) as { memories?: MemoryLine[] }).memories?.filter((m) => (m.memory ?? '').trim()) ?? []
  const words = terms(task)
  const last = memories.filter(isSummary).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0]
  const related = memories.filter((m) => m !== last && sharesTerm(words, m.memory!)).slice(0, RECALL_LIMIT)
  return last ? [last, ...related] : related
}

async function locateCode(env: Env, task: string, project: string, branch: string | undefined): Promise<string> {
  const res = await apiCall(env, '/api/intel/code-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: task, projectId: project, branch, limit: 8 }),
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) return ''
  const matches = ((await res.json()) as { data?: { results?: CodeMatch[] } })?.data?.results ?? []
  const symbols = await fetchOutline(outlineFiles(matches), async (query) => {
    const graph = await apiCall(env, '/api/intel/cypher', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, projectId: project }),
      signal: AbortSignal.timeout(5000),
    })
    return graph.ok ? ((await graph.json()) as { data?: { raw?: string } })?.data?.raw ?? '' : ''
  })
  return formatTaskLocation(task, matches, symbols)
}

/** The three searches at once; a part that fails is left out and its `…:` line with it. */
export async function taskBrief(
  env: Env,
  opts: { task: string; project: string; projectId?: string; agentId: string; branch?: string; alreadyInContext: (title?: string) => boolean },
): Promise<string> {
  const quiet = <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback)
  const [knowledge, memories, code] = await Promise.all([
    quiet(searchKnowledge(env, opts.task, opts.alreadyInContext), undefined),
    quiet(searchMemory(env, opts.task, opts.projectId, opts.agentId), undefined),
    quiet(locateCode(env, opts.task, opts.project, opts.branch), ''),
  ])
  return [formatTaskRecall(opts.task, knowledge, memories), code].filter(Boolean).join('\n\n')
}
