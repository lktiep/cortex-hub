import type { Env } from '../types.js'
import { apiCall } from '../api-call.js'
import { formatCodeMatches, formatOutline, outlineFiles, outlineQuery, parseOutline, type CodeMatch } from './code-matches.js'

// What cortex_session_start answers when it is told the task. Measured in the agent benchmark,
// every session opened with the same four calls — start, knowledge, memory, code search — on
// the same words, and read ~11k characters back, ~3k of them a generic "last session" brief that
// was a workflow template. Asked once with the task, the hub runs the three searches itself and
// answers each in a few lines. The `recalled:` and `located:` lines are what the client hooks
// take as evidence that the recall and the lookup ran.

export const RECALL_LIMIT = 3
const LINE_CHARS = 180

const oneLine = (text: string, max = LINE_CHARS) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export interface KnowledgeLine { documentId?: string; title?: string; content?: string; deprecated?: boolean }
export interface MemoryLine { id?: string; memory?: string }

export function formatTaskRecall(task: string, knowledge: KnowledgeLine[] | undefined, memories: MemoryLine[] | undefined): string {
  if (!knowledge || !memories) return ''
  const out = [`recalled: knowledge+memory for "${oneLine(task, 120)}"`]
  out.push(knowledge.length
    ? ['Knowledge (full text: cortex_knowledge_search id):', ...knowledge.map((k) => `- ${oneLine(k.title ?? '', 90)} — ${oneLine(k.content ?? '')} (${k.documentId})`)].join('\n')
    : 'Knowledge: nothing stored for this yet.')
  out.push(memories.length
    ? ['Memory:', ...memories.map((m) => `- ${oneLine(m.memory ?? '')}`)].join('\n')
    : 'Memory: nothing stored for this yet.')
  return out.join('\n')
}

export function formatTaskLocation(task: string, matches: CodeMatch[], outline: string): string {
  const files = formatCodeMatches(matches, 0)
  if (!files) return ''
  return [`located: code for "${oneLine(task, 120)}"`, files, outline].filter(Boolean).join('\n')
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
    if (!r.documentId || r.deprecated || alreadyInContext(r.title) || seen.has(r.documentId)) return false
    seen.add(r.documentId)
    return true
  }).slice(0, RECALL_LIMIT)
}

/** The project's memories first, then the agent's own; undefined when neither search answered. */
async function searchMemory(env: Env, task: string, projectId: string | undefined, agentId: string): Promise<MemoryLine[] | undefined> {
  const scopes = [projectId ? `project-${projectId}` : undefined, agentId].filter((s): s is string => Boolean(s))
  const found: MemoryLine[] = []
  let answered = false
  for (const userId of scopes) {
    if (found.length >= RECALL_LIMIT) break
    const res = await apiCall(env, '/api/mem9/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: task, userId, limit: RECALL_LIMIT - found.length }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) continue
    answered = true
    const data = (await res.json()) as { memories?: MemoryLine[] }
    found.push(...(data.memories ?? []).filter((m) => (m.memory ?? '').trim()))
  }
  return answered ? found.slice(0, RECALL_LIMIT) : undefined
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
  const files = outlineFiles(matches)
  let outline = ''
  if (files.length) {
    const graph = await apiCall(env, '/api/intel/cypher', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: outlineQuery(files), projectId: project }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined)
    if (graph?.ok) outline = formatOutline(parseOutline(((await graph.json()) as { data?: { raw?: string } })?.data?.raw ?? ''), files)
  }
  return formatTaskLocation(task, matches, outline)
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
