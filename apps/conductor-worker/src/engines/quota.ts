const RESETS_IN = /Resets in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i;

/** 'Resets in 89h3m4s' -> ISO timestamp `now` plus that span; undefined when there is no duration. */
export function parseResetsIn(text: string, now: Date): string | undefined {
  const m = RESETS_IN.exec(text);
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) return undefined;
  const seconds = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return new Date(now.getTime() + seconds * 1000).toISOString();
}

/** 'claude-sonnet-5-5-low' -> 'claude-sonnet-5-5-*' (quota covers every effort level of a model). */
export function agyModelScope(model: string | null): string | undefined {
  if (model === null) return undefined;
  const m = /^(.+-)(?:low|medium|high)$/.exec(model);
  return m ? `${m[1]}*` : undefined;
}
