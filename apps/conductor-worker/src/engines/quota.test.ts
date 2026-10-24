import { describe, expect, it } from 'vitest';
import { agyModelScope, parseResetsAt, parseResetsIn } from './quota.js';

const t0 = new Date('2026-10-16T00:00:00.000Z');

describe('parseResetsIn', () => {
  it('parses hours, minutes and seconds', () => {
    expect(parseResetsIn('Quota reached. Resets in 89h3m4s.', t0)).toBe(
      new Date(t0.getTime() + (89 * 3600 + 3 * 60 + 4) * 1000).toISOString(),
    );
  });
  it('handles minutes only, seconds only and hours only', () => {
    expect(parseResetsIn('Resets in 45m', t0)).toBe(new Date(t0.getTime() + 45 * 60_000).toISOString());
    expect(parseResetsIn('Resets in 3s.', t0)).toBe(new Date(t0.getTime() + 3000).toISOString());
    expect(parseResetsIn('Resets in 1h', t0)).toBe(new Date(t0.getTime() + 3_600_000).toISOString());
  });
  it('returns undefined without a match', () => {
    expect(parseResetsIn('Individual quota reached.', t0)).toBeUndefined();
    expect(parseResetsIn('Resets in soon', t0)).toBeUndefined();
    expect(parseResetsIn('Resets in 3ms', t0)).toBeUndefined();
  });
});

describe('parseResetsAt', () => {
  const at = new Date('2026-10-23T06:03:51Z'); // 13:03 in Bangkok
  it('reads a dated reset in its time zone', () => {
    expect(parseResetsAt("You've hit your weekly limit · resets Oct 26, 12am (Asia/Bangkok)", at)).toBe('2026-10-25T17:00:00.000Z');
    expect(parseResetsAt('resets Oct 26, 9:30pm (UTC)', at)).toBe('2026-10-26T21:30:00.000Z');
  });
  it('takes the next occurrence of an undated reset', () => {
    expect(parseResetsAt("You've hit your limit · resets 5pm (Asia/Bangkok)", at)).toBe('2026-10-23T10:00:00.000Z');
    expect(parseResetsAt('resets 1pm (Asia/Bangkok)', at)).toBe('2026-10-24T06:00:00.000Z');
  });
  it('follows daylight saving time', () => {
    // EDT until Nov 1, EST after
    expect(parseResetsAt('resets 2:30am (America/New_York)', at)).toBe('2026-10-23T06:30:00.000Z'); // 02:03 EDT now
    expect(parseResetsAt('resets Nov 2, 2:30am (America/New_York)', at)).toBe('2026-11-02T07:30:00.000Z');
  });
  it('rolls a date already past into next year', () => {
    expect(parseResetsAt('resets Jan 2, 9am (UTC)', new Date('2026-12-31T12:00:00Z'))).toBe('2027-01-02T09:00:00.000Z');
  });
  it('returns undefined without a reset time or with an unknown zone', () => {
    expect(parseResetsAt("You've hit your weekly limit", at)).toBeUndefined();
    expect(parseResetsAt('resets 5pm (Mars/Olympus)', at)).toBeUndefined();
    expect(parseResetsAt('resets 13pm (UTC)', at)).toBeUndefined();
  });
});

describe('agyModelScope', () => {
  it('replaces the effort suffix with a wildcard', () => {
    expect(agyModelScope('claude-sonnet-5-5-low')).toBe('claude-sonnet-5-5-*');
    expect(agyModelScope('gemini-4-argon-high')).toBe('gemini-4-argon-*');
  });
  it('is undefined for null and for a model without an effort suffix', () => {
    expect(agyModelScope(null)).toBeUndefined();
    expect(agyModelScope('my-model')).toBeUndefined();
  });
});
