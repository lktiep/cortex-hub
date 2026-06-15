export function parseDateSafe(dateStr: string | null | undefined): Date {
  if (!dateStr) return new Date(NaN)
  
  let formatted = dateStr.trim()
  
  if (/^\d+$/.test(formatted)) {
    return new Date(parseInt(formatted, 10))
  }
  
  if (!formatted.includes('T') && formatted.includes(' ')) {
    formatted = formatted.replace(' ', 'T')
  }
  
  if (!formatted.includes('Z') && !formatted.match(/[+-]\d{2}:?\d{2}$/)) {
    formatted = formatted + 'Z'
  }
  
  const parsed = new Date(formatted)
  if (isNaN(parsed.getTime())) {
    return new Date(dateStr)
  }
  return parsed
}

export function formatTimeAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return '—'
  const past = parseDateSafe(dateStr)
  if (isNaN(past.getTime())) return '—'
  const now = new Date()
  const diff = Math.floor((now.getTime() - past.getTime()) / 1000)
  
  if (diff < 5) return 'just now'
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}
