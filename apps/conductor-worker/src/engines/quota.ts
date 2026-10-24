const RESETS_IN = /Resets in\s+(?:(\d+)h(?![a-z]))?\s*(?:(\d+)m(?![a-z]))?\s*(?:(\d+)s(?![a-z]))?/i;

/** 'Resets in 89h3m4s' -> ISO timestamp `now` plus that span; undefined when there is no duration. */
export function parseResetsIn(text: string, now: Date): string | undefined {
  const m = RESETS_IN.exec(text);
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) return undefined;
  const seconds = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return new Date(now.getTime() + seconds * 1000).toISOString();
}

const RESETS_AT =
  /resets\s+(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([\w+\-/]+)\)/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_MS = 86_400_000;

/** Minutes `zone` is ahead of UTC at `utcMs`. Throws RangeError for an unknown zone. */
function zoneOffset(utcMs: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(new Date(utcMs));
  const n = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'));
  return (wall - Math.floor(utcMs / 60_000) * 60_000) / 60_000;
}

/** A wall-clock time in `zone` as epoch ms. Date.UTC rolls an out-of-range day into the next month. */
function wallToUtc(y: number, mo: number, d: number, h: number, mi: number, zone: string): number {
  const wall = Date.UTC(y, mo, d, h, mi);
  const guess = wall - zoneOffset(wall, zone) * 60_000;
  return wall - zoneOffset(guess, zone) * 60_000;
}

/**
 * 'resets Oct 26, 12am (Asia/Bangkok)' or 'resets 5pm (Asia/Bangkok)' -> ISO timestamp of that
 * wall-clock time in that zone: the next one after `now` when there is no date. Undefined when
 * there is no such phrase or the zone is unknown.
 */
export function parseResetsAt(text: string, now: Date): string | undefined {
  const m = RESETS_AT.exec(text);
  if (!m) return undefined;
  const [, mon, day, hh, mm, ampm, zone] = m;
  if (Number(hh) > 12 || Number(mm ?? 0) > 59 || zone === undefined) return undefined;
  const hour = (Number(hh) % 12) + (ampm?.toLowerCase() === 'pm' ? 12 : 0);
  const min = Number(mm ?? 0);
  try {
    // The zone's wall clock now, read through the UTC fields.
    const local = new Date(now.getTime() + zoneOffset(now.getTime(), zone) * 60_000);
    const y = local.getUTCFullYear();
    let at: number;
    if (mon !== undefined) {
      const mo = MONTHS.indexOf(mon.toLowerCase());
      at = wallToUtc(y, mo, Number(day), hour, min, zone);
      // 'resets Jan 2' read on Dec 31 is next year's.
      if (at < now.getTime() - DAY_MS) at = wallToUtc(y + 1, mo, Number(day), hour, min, zone);
    } else {
      at = wallToUtc(y, local.getUTCMonth(), local.getUTCDate(), hour, min, zone);
      if (at <= now.getTime()) at = wallToUtc(y, local.getUTCMonth(), local.getUTCDate() + 1, hour, min, zone);
    }
    return new Date(at).toISOString();
  } catch {
    return undefined;
  }
}

/** 'claude-sonnet-5-5-low' -> 'claude-sonnet-5-5-*' (quota covers every effort level of a model). */
export function agyModelScope(model: string | null): string | undefined {
  if (model === null) return undefined;
  const m = /^(.+-)(?:low|medium|high)$/.exec(model);
  return m ? `${m[1]}*` : undefined;
}
