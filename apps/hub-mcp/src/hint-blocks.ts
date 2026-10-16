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

export function appendHintBlocks(text: string, hints: string[], conductor: string[]): string {
  return text + block('💡 Cortex hints:', hints) + block('📋 Conductor:', conductor)
}
