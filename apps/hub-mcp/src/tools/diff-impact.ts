/** The detect-changes answer, as the hub sends it. Only the fields the report prints. */
type DiffImpact = {
  summary: {
    changed_count: number
    affected_count: number
    risk_level: string
    files: number
    new_files?: string[]
    files_without_symbols?: string[]
    message?: string
  }
  changed_symbols: Array<{ name: string; type: string; filePath: string; startLine: number; endLine: number }>
  affected_processes: Array<{ name: string; changed_steps?: Array<{ symbol: string }> }>
  partial?: true
  truncated?: true
}

function isDiffImpact(value: unknown): value is DiffImpact {
  const v = value as Partial<DiffImpact> | undefined
  return typeof v?.summary?.risk_level === 'string' && Array.isArray(v.changed_symbols) && Array.isArray(v.affected_processes)
}

/**
 * A pre-commit check as lines to read. Sent as indented JSON it repeated every key and each
 * symbol's id, which is its type, path and name over again: about three times the text for
 * the same facts, on the tool agents call before every commit. Anything not in the expected
 * shape (a compare-scope answer) is returned as JSON, unchanged.
 */
export function formatDiffImpact(data: unknown): string {
  const impact = (data as { data?: unknown })?.data
  if (!isDiffImpact(impact)) return JSON.stringify(data, null, 2)
  const { summary } = impact
  const lines = [
    `Risk: ${summary.risk_level} — ${summary.changed_count} changed symbol(s) in ${summary.files} file(s), ` +
      `${summary.affected_count} affected flow(s)${impact.partial ? ' (a lookup failed: lists are a lower bound)' : ''}`,
  ]
  if (summary.message) lines.push(summary.message)
  if (impact.changed_symbols.length > 0) {
    lines.push('', `Changed${impact.truncated ? ` (first ${impact.changed_symbols.length})` : ''}:`)
    for (const s of impact.changed_symbols) lines.push(`  ${s.type} ${s.name} → ${s.filePath}:${s.startLine}-${s.endLine}`)
  }
  if (impact.affected_processes.length > 0) {
    lines.push('', 'Affected flows:')
    for (const p of impact.affected_processes) {
      const via = (p.changed_steps ?? []).map((step) => step.symbol)
      lines.push(`  ${p.name}${via.length > 0 ? ` (via ${via.join(', ')})` : ''}`)
    }
  }
  if (summary.new_files?.length) lines.push('', `New files, not in the graph yet: ${summary.new_files.join(', ')}`)
  if (summary.files_without_symbols?.length) {
    lines.push('', `No indexed symbol on a changed line: ${summary.files_without_symbols.join(', ')}`)
  }
  return lines.join('\n')
}
