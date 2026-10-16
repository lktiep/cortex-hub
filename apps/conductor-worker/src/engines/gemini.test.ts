import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildWin32ShellLine } from '../process.js';
import { createGeminiAdapter } from './gemini.js';

const fx = (name: string): string =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'gemini', name), 'utf8');

const gemini = createGeminiAdapter({ bin: 'gemini', platform: 'linux', env: {} });
const now = new Date('2026-10-16T00:00:00.000Z');

describe('gemini buildArgs', () => {
  it('puts the prompt on stdin, never in args', () => {
    const b = gemini.buildArgs({ prompt: 'multi\nline', model: null, effort: null }, 'linux');
    expect(b.stdin).toBe('multi\nline');
    expect(b.args).toEqual(['-y', '-p', 'Proceed.']);
  });
  it('passes -m only when set', () => {
    expect(gemini.buildArgs({ prompt: 'x', model: null, effort: 'high' }, 'linux').args).not.toContain('-m');
    expect(gemini.buildArgs({ prompt: 'x', model: 'm-1', effort: null }, 'linux').args).toEqual([
      '-y', '-m', 'm-1', '-p', 'Proceed.',
    ]);
  });
  it('builds a win32 shell line without throwing', () => {
    const { args } = gemini.buildArgs({ prompt: 'x', model: 'm-1', effort: 'high' }, 'win32');
    expect(() => buildWin32ShellLine('C:\\tools\\x.cmd', args)).not.toThrow();
  });
});

describe('gemini classify', () => {
  it('classifies the synthetic quota text as quota with resetAt', () => {
    const c = gemini.classify(1, '', fx('synthetic-quota.stderr.txt'), { model: null, now });
    expect(c.kind).toBe('quota');
    if (c.kind === 'quota') {
      expect(c.resetAt).toBe(new Date(now.getTime() + (2 * 3600 + 3 * 60 + 4) * 1000).toISOString());
    }
  });
  it('classifies a bare RESOURCE_EXHAUSTED or 429 as quota without resetAt', () => {
    for (const s of ['RESOURCE_EXHAUSTED', 'HTTP 429']) {
      const c = gemini.classify(1, '', s, { model: null, now });
      expect(c.kind).toBe('quota');
      if (c.kind === 'quota') expect(c.resetAt).toBeUndefined();
    }
  });
  it('classifies unknown failure as error, never quota', () => {
    expect(gemini.classify(1, '', 'usage limit rate limit 4290')).toEqual({
      kind: 'error',
      message: 'usage limit rate limit 4290',
    });
  });
  it('classifies exit 0 as ok', () => {
    expect(gemini.classify(0, '429', '')).toEqual({ kind: 'ok' });
  });
});

describe('gemini progressText, summary, models', () => {
  it('progressText and summary follow the plain-text rules', () => {
    expect(gemini.progressText(' step ')).toBe('step');
    expect(gemini.progressText('')).toBeNull();
    expect(gemini.progressText('y'.repeat(900))?.length).toBe(500);
    expect(gemini.summary(`${'a'.repeat(5000)}\n`)).toBe('a'.repeat(4000));
  });
  it('models fall back through opts, env, *', async () => {
    expect(await createGeminiAdapter({ models: ['g'], env: {} }).models()).toEqual(['g']);
    expect(await createGeminiAdapter({ env: { CORTEX_GEMINI_MODELS: 'a, b' } }).models()).toEqual(['a', 'b']);
    expect(await gemini.models()).toEqual(['*']);
    expect(gemini.defaultModel()).toBeNull();
  });
});
