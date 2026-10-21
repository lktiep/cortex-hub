/** True when the body's last content item is a text item the hint blocks can be appended to. */
export function canAppendHints(body: unknown): body is {
  result: { content: Array<{ type: 'text'; text: string }> }
} {
  if (typeof body !== 'object' || body === null) return false
  const result = (body as { result?: unknown }).result
  if (typeof result !== 'object' || result === null) return false
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content) || content.length === 0) return false
  const last = content[content.length - 1] as { type?: unknown; text?: unknown } | null
  return last?.type === 'text' && typeof last.text === 'string'
}

function block(title: string, lines: string[]): string {
  return lines.length === 0 ? '' : `\n\n---\n${title}\n` + lines.map((l) => `  ${l}`).join('\n')
}

export function appendHintBlocks(text: string, hints: string[], conductor: string[], notes: string[] = []): string {
  return text + block('📌 Known notes on these files:', notes) + block('💡 Cortex hints:', hints) + block('📋 Conductor:', conductor)
}

/** A note as POST /api/knowledge/file-notes returns it. */
export interface FileNote { id: string; title: string; kind: string; note: string }

/** Lines a code lookup's answer can carry: the notes before anything else, so the cap drops paths, not one path's notes. */
export const NOTE_LINES = 8
const NOTE_LINE_CHARS = 200

/** One line per note, `path [kind] title — note`, each note once however many paths it is on. */
export function noteLines(notes: Record<string, FileNote[]>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const [path, list] of Object.entries(notes)) {
    for (const n of list) {
      if (seen.has(n.id) || out.length === NOTE_LINES) continue
      seen.add(n.id)
      const line = `${path} [${n.kind}] ${n.title}${n.note && n.note !== n.title ? ` — ${n.note}` : ''}`
      out.push(line.length > NOTE_LINE_CHARS ? `${line.slice(0, NOTE_LINE_CHARS - 1)}…` : line)
    }
  }
  return out
}
