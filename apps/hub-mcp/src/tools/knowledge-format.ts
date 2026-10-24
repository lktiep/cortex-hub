/**
 * What cortex_knowledge_search shows the agent. A search answers "is there something on
 * this?", so each document gets a heading and a short excerpt; the full text is one more
 * call away (`id`). Whole chunks for five documents cost ~8k characters on every call,
 * whether or not the agent needed any of them.
 */

export interface KnowledgeHit {
  score?: number
  chunkId?: string
  content?: string
  documentId?: string
  title?: string
  chunkIndex?: number
  deprecated?: boolean
  document?: {
    tags?: string
    hall_type?: string
  }
}

export interface KnowledgeDoc {
  id: string
  title?: string
  tags?: string
  hall_type?: string
  chunks?: Array<{ chunk_index?: number; content?: string }>
}

/** Characters of the whole answer before later hits are listed by heading only. */
export const DEFAULT_MAX_CHARS = 2400
/** Characters of excerpt under each heading. */
export const EXCERPT_CHARS = 280

function tagsOf(raw: string | undefined): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS).trimEnd()}…` : flat
}

/**
 * One heading per document (a document indexed in several chunks comes back once per
 * chunk; the best-ranked chunk stands for it), an excerpt while the answer is under
 * `maxChars`, headings alone after that.
 */
export function formatKnowledgeResults(query: string, hits: KnowledgeHit[], maxChars = DEFAULT_MAX_CHARS): string {
  const seen = new Set<string>()
  const docs = hits.filter((h) => {
    const key = h.documentId ?? h.chunkId ?? h.title ?? ''
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const lines = [`Knowledge for "${query}":`]
  let used = lines[0]!.length
  let headingsOnly = 0
  docs.forEach((h, i) => {
    const tags = tagsOf(h.document?.tags)
    const meta = [
      h.document?.hall_type ? `type: ${h.document.hall_type}` : '',
      tags.length > 0 ? `tags: ${tags.join(', ')}` : '',
      h.deprecated ? 'possibly obsolete' : '',
    ].filter(Boolean).join('; ')
    const heading = `### Result ${i + 1}: ${h.title || 'Untitled'} (ID: ${h.documentId ?? 'unknown'}, Score: ${h.score?.toFixed(3) ?? 'N/A'})${meta ? ` [${meta}]` : ''}`
    const body = excerpt(h.content ?? '')
    if (used + heading.length + body.length + 2 <= maxChars) {
      lines.push(heading, body)
      used += heading.length + body.length + 2
    } else {
      lines.push(heading)
      used += heading.length + 1
      headingsOnly++
    }
  })
  lines.push(
    headingsOnly > 0
      ? `(${headingsOnly} more listed by heading only.) Full text of one: cortex_knowledge_search(id: "<ID>").`
      : 'Full text of one: cortex_knowledge_search(id: "<ID>").',
  )
  return lines.join('\n')
}

/** A whole document, chunks in order, for `cortex_knowledge_search(id)`. */
export function formatKnowledgeDocument(doc: KnowledgeDoc): string {
  const tags = tagsOf(doc.tags)
  const meta = [doc.hall_type ? `type: ${doc.hall_type}` : '', tags.length > 0 ? `tags: ${tags.join(', ')}` : '']
    .filter(Boolean).join('; ')
  const text = [...(doc.chunks ?? [])]
    .sort((a, b) => (a.chunk_index ?? 0) - (b.chunk_index ?? 0))
    .map((c) => c.content ?? '')
    .join('\n\n')
  return `# ${doc.title || 'Untitled'} (ID: ${doc.id})${meta ? ` [${meta}]` : ''}\n\n${text}`
}
