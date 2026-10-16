import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildWin32ShellLine } from '../process.js';
import { createClaudeAdapter } from './claude.js';

const fx = (name: string): string =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'claude', name), 'utf8');

const claude = createClaudeAdapter({ bin: 'claude', platform: 'linux', env: {} });
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-claude-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('claude buildArgs', () => {
  it('puts the prompt on stdin, never in args', () => {
    const b = claude.buildArgs({ prompt: 'multi\nline prompt', model: null, effort: null }, 'linux');
    expect(b.stdin).toBe('multi\nline prompt');
    expect(b.args).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto']);
    expect(b.args.join(' ')).not.toContain('prompt');
  });
  it('passes --model only when set', () => {
    expect(claude.buildArgs({ prompt: 'x', model: null, effort: 'high' }, 'linux').args).not.toContain('--model');
    const a = claude.buildArgs({ prompt: 'x', model: 'm-1', effort: null }, 'linux').args;
    expect(a.slice(-2)).toEqual(['--model', 'm-1']);
  });
  it('builds a win32 shell line without throwing', () => {
    const { args } = claude.buildArgs({ prompt: 'x', model: 'm-1', effort: 'high' }, 'win32');
    expect(() => buildWin32ShellLine('C:\\tools\\x.cmd', args)).not.toThrow();
  });
});

describe('claude classify', () => {
  it('classifies the synthetic quota result event as quota with resetAt', () => {
    const c = claude.classify(1, fx('synthetic-quota.stream.jsonl'), '');
    expect(c.kind).toBe('quota');
    if (c.kind === 'quota') expect(c.resetAt).toBe(new Date(1792000000 * 1000).toISOString());
  });
  it('classifies the synthetic stderr as quota without resetAt', () => {
    const c = claude.classify(1, '', fx('synthetic-quota.stderr.txt'));
    expect(c.kind).toBe('quota');
    if (c.kind === 'quota') expect(c.resetAt).toBeUndefined();
  });
  it('ignores quota words in a non-error result event', () => {
    const out = '{"type":"result","is_error":false,"result":"usage limit docs"}\n';
    expect(claude.classify(1, out, 'boom').kind).toBe('error');
  });
  it('classifies unknown failure as error, never quota', () => {
    expect(claude.classify(2, 'garbage', 'segfault in tool')).toEqual({ kind: 'error', message: 'segfault in tool' });
  });
  it('classifies exit 0 as ok', () => {
    expect(claude.classify(0, fx('synthetic-success.stream.jsonl'), '')).toEqual({ kind: 'ok' });
  });
});

describe('claude progressText and summary', () => {
  const lines = fx('synthetic-success.stream.jsonl').trimEnd().split('\n');
  it('progressText reads assistant text and tool_use names from stream-json', () => {
    expect(claude.progressText(lines[1]!)).toBe('Reading the file. [Read]');
    expect(claude.progressText(lines[0]!)).toBeNull();
    expect(claude.progressText(lines[2]!)).toBeNull();
    expect(claude.progressText('not json')).toBeNull();
    expect(claude.progressText('{"type":"assistant","message":{"content":"str"}}')).toBeNull();
  });
  it('summary reads the last result event, capped at 4000', () => {
    expect(claude.summary(fx('synthetic-success.stream.jsonl'))).toBe('All done.');
    const big = JSON.stringify({ type: 'result', result: 'x'.repeat(5000) });
    expect(claude.summary(big).length).toBe(4000);
  });
  it('summary falls back to the stdout tail', () => {
    expect(claude.summary('  plain output \n')).toBe('plain output');
  });
});

describe('claude binary and models', () => {
  it('models: opts, env, then *; defaultModel null', async () => {
    expect(await createClaudeAdapter({ models: ['a'], env: {} }).models()).toEqual(['a']);
    expect(await createClaudeAdapter({ env: { CORTEX_CLAUDE_MODELS: ' a, ,b ' } }).models()).toEqual(['a', 'b']);
    expect(await createClaudeAdapter({ env: { CORTEX_CLAUDE_MODELS: ' , ' } }).models()).toEqual(['*']);
    expect(await claude.models()).toEqual(['*']);
    expect(claude.defaultModel()).toBeNull();
  });
  it('detect() reports not found for an unresolved bin', async () => {
    const a = createClaudeAdapter({ platform: 'linux', env: { PATH: dir } });
    expect(await a.detect()).toEqual({ found: false });
  });
  it.skipIf(process.platform === 'win32')('detect() and run() use the fake bin; the prompt arrives on stdin', async () => {
    const file = path.join(dir, 'fake-claude');
    writeFileSync(
      file,
      `#!${process.execPath}\nif (process.argv[2]==='--version'){console.log('claude 9.9');process.exit(0);}\nlet d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log('got:'+d+' args:'+process.argv.slice(2).join(' ')));`,
    );
    chmodSync(file, 0o755);
    const a = createClaudeAdapter({ bin: file, env: process.env });
    expect(await a.detect()).toEqual({ found: true, path: file, version: 'claude 9.9' });
    const lines: string[] = [];
    const r = await a.run({
      prompt: 'hello', cwd: dir, model: 'm-1', effort: null,
      signal: new AbortController().signal, timeoutMs: 20_000, onLine: (l) => lines.push(l),
    });
    expect(r.exitCode).toBe(0);
    expect(lines[0]).toContain('got:hello');
    expect(lines[0]).toContain('--model m-1');
  });
});
