import { describe, expect, it } from 'vitest';
import { agyModelScope, parseResetsIn } from './quota.js';

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
