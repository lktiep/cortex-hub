import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildWin32ShellLine } from '../process.js';
import { createCodexAdapter } from './codex.js';

const fx = (name: string): string =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'codex', name), 'utf8');

const codex = createCodexAdapter({ bin: 'codex', platform: 'linux', env: {} });

describe('codex buildArgs', () => {
  it('puts the prompt on stdin, never in args', () => {
    const b = codex.buildArgs({ prompt: 'multi\nline', model: null, effort: null }, 'linux');
    expect(b.stdin).toBe('multi\nline');
    expect(b.args).toEqual(['exec', '--full-auto', '-']);
  });
  it('passes -m only when set', () => {
    expect(codex.buildArgs({ prompt: 'x', model: null, effort: null }, 'linux').args).not.toContain('-m');
    expect(codex.buildArgs({ prompt: 'x', model: 'm-1', effort: null }, 'linux').args).toEqual([
      'exec', '--full-auto', '-m', 'm-1', '-',
    ]);
  });
  it('adds -c model_reasoning_effort only when effort is set, before the trailing -', () => {
    expect(codex.buildArgs({ prompt: 'x', model: null, effort: null }, 'linux').args).not.toContain('-c');
    expect(codex.buildArgs({ prompt: 'x', model: 'm', effort: 'high' }, 'linux').args).toEqual([
      'exec', '--full-auto', '-m', 'm', '-c', 'model_reasoning_effort=high', '-',
    ]);
  });
  it('builds a win32 shell line without throwing', () => {
    const { args } = codex.buildArgs({ prompt: 'x', model: 'm-1', effort: 'high' }, 'win32');
    expect(() => buildWin32ShellLine('C:\\tools\\x.cmd', args)).not.toThrow();
  });
});

describe('codex classify', () => {
  it('classifies the synthetic quota texts as quota', () => {
    for (const f of ['synthetic-quota.stderr.txt', 'synthetic-quota-429.stderr.txt']) {
      const c = codex.classify(1, '', fx(f));
      expect(c.kind).toBe('quota');
      if (c.kind === 'quota') expect(c.resetAt).toBeUndefined();
    }
  });
  it('classifies unknown failure as error, never quota', () => {
    expect(codex.classify(1, 'compile failed', 'tests broke')).toEqual({ kind: 'error', message: 'tests broke' });
    expect(codex.classify(null, '', '').kind).toBe('error');
  });
  it('classifies exit 0 as ok', () => {
    expect(codex.classify(0, 'rate limit mentioned in docs', '')).toEqual({ kind: 'ok' });
  });
});

describe('codex progressText, summary, models', () => {
  it('progressText is the trimmed line capped at 500, else null', () => {
    expect(codex.progressText('  hi  ')).toBe('hi');
    expect(codex.progressText('   ')).toBeNull();
    expect(codex.progressText('x'.repeat(600))?.length).toBe(500);
  });
  it('summary is the last 4000 chars of trimmed stdout', () => {
    expect(codex.summary(`\n${'a'.repeat(10)}${'b'.repeat(4000)}\n`)).toBe('b'.repeat(4000));
    expect(codex.summary(' done \n')).toBe('done');
  });
  it('models fall back through opts, env, *', async () => {
    expect(await createCodexAdapter({ models: ['o'], env: {} }).models()).toEqual(['o']);
    expect(await createCodexAdapter({ env: { CORTEX_CODEX_MODELS: 'a,b' } }).models()).toEqual(['a', 'b']);
    expect(await codex.models()).toEqual(['*']);
    expect(codex.defaultModel()).toBeNull();
  });
});
