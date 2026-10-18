import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { win32QuotedLength } from '../prompt.js';
import { createAgyAdapter } from './agy.js';

const fx = (name: string): string =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'agy', name), 'utf8');

const now = new Date('2026-10-16T00:00:00.000Z');
const resetAt = new Date(now.getTime() + (89 * 3600 + 3 * 60 + 4) * 1000).toISOString();
const agy = createAgyAdapter({ bin: 'agy', platform: 'linux', env: {} });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-agy-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeBin(body: string): string {
  const file = path.join(dir, 'fake-agy');
  writeFileSync(file, `#!${process.execPath}\n${body}`);
  chmodSync(file, 0o755);
  return file;
}

describe('agy classify', () => {
  it('classifies the recorded success as ok', () => {
    expect(agy.classify(0, fx('success.jsonl'), '')).toEqual({ kind: 'ok' });
  });

  it('classifies the recorded quota (json and stream-json) as quota with resetAt and modelScope', () => {
    const ctx = { model: 'claude-sonnet-5-5-low', now };
    for (const out of [fx('quota.stdout.json'), fx('quota.stream.jsonl')]) {
      const c = agy.classify(3, out, fx('quota.stderr.txt'), ctx);
      expect(c.kind).toBe('quota');
      if (c.kind !== 'quota') return;
      expect(c.resetAt).toBe(resetAt);
      expect(c.modelScope).toBe('claude-sonnet-5-5-*');
      expect(c.raw).toContain('Individual quota reached');
      expect(c.raw.length).toBeLessThanOrEqual(2000);
    }
  });

  it('classifies an AGY_ERROR 429 on stderr with an unknown exit code as quota', () => {
    const c = agy.classify(null, '', fx('quota.stderr.txt'), { model: null, now });
    expect(c.kind).toBe('quota');
    if (c.kind === 'quota') expect(c.modelScope).toBeUndefined();
  });

  it('classifies RESOURCE_EXHAUSTED without a code as quota', () => {
    const c = agy.classify(1, '', 'AGY_ERROR: {"status":"RESOURCE_EXHAUSTED"}', { model: null });
    expect(c.kind).toBe('quota');
  });

  it('classifies the recorded invalid model (exit 1) as error, never quota', () => {
    const c = agy.classify(1, '', fx('invalid-model.stderr.txt'));
    expect(c.kind).toBe('error');
    if (c.kind === 'error') expect(c.message).toMatch(/invalid model selection/);
  });

  it('classifies unknown output with exit 2 as error', () => {
    expect(agy.classify(2, 'garbage\n{not json', 'what')).toEqual({ kind: 'error', message: 'what' });
  });

  it('classifies exit 3 with no output as quota without resetAt', () => {
    const c = agy.classify(3, '', '', { model: null, now });
    expect(c.kind).toBe('quota');
    if (c.kind === 'quota') expect(c.resetAt).toBeUndefined();
  });

  it('reads the reset time from the full stderr even when raw is truncated', () => {
    const stderr = `${'x'.repeat(3000)}\n${fx('quota.stderr.txt')}`;
    const c = agy.classify(null, '', stderr, { model: null, now });
    expect(c.kind).toBe('quota');
    if (c.kind === 'quota') {
      expect(c.resetAt).toBe(resetAt);
      expect(c.raw.length).toBe(2000);
    }
  });

  it('classifies a non-quota ERROR result with exit 1 as error', () => {
    const out = '{"event":"result","result":{"status":"ERROR","error":"tool crashed"}}\n';
    expect(agy.classify(1, out, '')).toEqual({ kind: 'error', message: 'tool crashed' });
  });

  it('classifies a SUCCESS response that mentions quota as ok', () => {
    const out = '{"event":"result","result":{"status":"SUCCESS","response":"quota exceeded 429"}}\n';
    expect(agy.classify(0, out, '')).toEqual({ kind: 'ok' });
  });

  it('classifies exit 0 without a SUCCESS result as error', () => {
    expect(agy.classify(0, '{"event":"init"}\n', '').kind).toBe('error');
    expect(agy.classify(0, '', '').kind).toBe('error');
  });

  it('skips unparseable lines and uses the last result event', () => {
    const out = `nope\n${fx('quota.stream.jsonl')}${fx('success.jsonl')}`;
    expect(agy.classify(0, out, '')).toEqual({ kind: 'ok' });
  });

  it('uses the result error text for a plain error result', () => {
    const out = '{"status":"ERROR","error":"something broke"}\n';
    expect(agy.classify(1, out, '')).toEqual({ kind: 'error', message: 'something broke' });
  });
});

describe('agy buildArgs', () => {
  const i = { prompt: 'do it', model: 'gemini-4-argon-low', effort: 'high' };
  it('uses --mode accept-edits on every platform', () => {
    const a = createAgyAdapter({ bin: 'agy', env: {} });
    for (const p of ['darwin', 'linux', 'win32'] as const) {
      expect(a.buildArgs(i, p).args).toEqual([
        '-p', 'do it', '--output-format', 'stream-json', '--mode', 'accept-edits',
        '--model', 'gemini-4-argon-low', '--effort', 'high',
      ]);
    }
  });

  it('skips permissions only when asked: CORTEX_AGY_SKIP_PERMISSIONS=1, or the option', () => {
    const flag = '--dangerously-skip-permissions';
    expect(createAgyAdapter({ bin: 'agy', env: {} }).buildArgs(i, 'linux').args).not.toContain(flag);
    for (const v of ['0', 'true', '']) {
      const a = createAgyAdapter({ bin: 'agy', env: { CORTEX_AGY_SKIP_PERMISSIONS: v } });
      expect(a.buildArgs(i, 'linux').args).not.toContain(flag);
    }
    const e = createAgyAdapter({ bin: 'agy', env: { CORTEX_AGY_SKIP_PERMISSIONS: '1' } });
    expect(e.buildArgs(i, 'win32').args).toContain(flag);
    const o = createAgyAdapter({ bin: 'agy', skipPermissions: false, env: { CORTEX_AGY_SKIP_PERMISSIONS: '1' } });
    expect(o.buildArgs(i, 'linux').args).not.toContain(flag);
  });

  it('omits --model/--effort when null', () => {
    const args = agy.buildArgs({ prompt: 'x', model: null, effort: null }, 'linux').args;
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--effort');
    expect(args).not.toContain('--print-timeout');
  });

  it('CORTEX_AGY_MODE overrides the mode and opts.mode beats it', () => {
    const e = createAgyAdapter({ bin: 'agy', env: { CORTEX_AGY_MODE: 'plan' } });
    expect(e.buildArgs(i, 'linux').args).toContain('plan');
    const o = createAgyAdapter({ bin: 'agy', mode: 'yolo', env: { CORTEX_AGY_MODE: 'plan' } });
    expect(o.buildArgs(i, 'linux').args).toContain('yolo');
  });

  it('adds --print-timeout when configured', () => {
    const a = createAgyAdapter({ bin: 'agy', printTimeout: '30m', env: {} });
    const args = a.buildArgs(i, 'linux').args;
    expect(args.slice(-2)).toEqual(['--print-timeout', '30m']);
  });
});

describe('agy permission refusals', () => {
  it('refuses commands unless it runs in auto mode or skips permissions', () => {
    expect(createAgyAdapter({ bin: 'agy', env: {} }).refusesCommands?.()).toBe(true);
    expect(createAgyAdapter({ bin: 'agy', env: { CORTEX_AGY_MODE: 'auto' } }).refusesCommands?.()).toBe(false);
    expect(createAgyAdapter({ bin: 'agy', env: { CORTEX_AGY_SKIP_PERMISSIONS: '1' } }).refusesCommands?.()).toBe(
      false,
    );
  });

  it('a refused run still exits SUCCESS, so classify stays ok and stoppedEarly says why', () => {
    const out = fx('denied.stream.jsonl');
    expect(agy.classify(0, out, fx('denied.stderr.txt'))).toEqual({ kind: 'ok' });
    const why = agy.stoppedEarly?.(out, fx('denied.stderr.txt')) ?? '';
    expect(why).toContain('agy stopped early');
    // display names, each once, and the action when there is no display name
    expect(why).toContain('refused RunCommand, write_file,');
    expect(why).toContain('no auto mode');
    expect(why).toContain('CORTEX_AGY_MODE=accept-edits');
    expect(why).toContain('permissions.allow');
    expect(why).toContain('CORTEX_AGY_SKIP_PERMISSIONS=1');
  });

  it('leaves out the auto-mode hint when the account has auto mode', () => {
    const why = agy.stoppedEarly?.(fx('denied.stream.jsonl'), '') ?? '';
    expect(why).toContain('agy stopped early');
    expect(why).not.toContain('no auto mode');
  });

  it('a run with nothing refused did not stop early', () => {
    expect(agy.stoppedEarly?.(fx('success.jsonl'), '')).toBeNull();
    expect(agy.stoppedEarly?.('{"event":"result","result":{"status":"SUCCESS","denied_actions":[]}}', '')).toBeNull();
    expect(agy.stoppedEarly?.('{"event":"result","result":{"status":"SUCCESS","denied_actions":"x"}}', '')).toBeNull();
    expect(agy.stoppedEarly?.('', '')).toBeNull();
  });
});

describe('agy promptLength', () => {
  it('measures the prompt as CreateProcess receives it on win32, and by its length elsewhere', () => {
    const prompt = 'say "hi" to C:\\dir\\';
    const win = createAgyAdapter({ bin: 'agy', platform: 'win32', env: {} });
    expect(win.promptLength?.(prompt)).toBe(win32QuotedLength(prompt));
    expect(win32QuotedLength(prompt)).toBeGreaterThan(prompt.length);
    const linux = createAgyAdapter({ bin: 'agy', platform: 'linux', env: {} });
    expect(linux.promptLength?.(prompt)).toBe(prompt.length);
  });
});

describe('agy progress and summary', () => {
  const lines = fx('success.jsonl').trimEnd().split('\n');
  const step = (index: number, state: string, extra: Record<string, unknown>): string =>
    JSON.stringify({ event: 'step_update', step_update: { step_index: index, state, step_type: 'agent_response', ...extra } });

  it('reads the start and joins a response into lines', () => {
    const reader = agy.progress();
    expect(reader.line(lines[0]!)).toEqual([{ kind: 'info', text: 'agy started (gemini-4-argon-low)' }]);
    expect(reader.line(lines[1]!)).toEqual([]);
    expect(reader.line(lines[2]!)).toEqual([]); // "OK" waits for the rest of its line
    expect(reader.line(lines[3]!)).toEqual([{ kind: 'text', text: 'OK' }]);
    expect(reader.line(lines[4]!)).toEqual([]);
    expect(reader.line('not json')).toEqual([]);
    expect(reader.end()).toEqual([]);
  });
  it('hands on whole lines as fragments come in, and the rest at the end', () => {
    const reader = agy.progress();
    expect(reader.line(step(3, 'ACTIVE', { text_delta: 'Looking at ' }))).toEqual([]);
    expect(reader.line(step(3, 'ACTIVE', { text_delta: 'the parser.\nThe bug' }))).toEqual([
      { kind: 'text', text: 'Looking at the parser.' },
    ]);
    expect(reader.line(step(3, 'ACTIVE', { text_delta: ' is in' }))).toEqual([]);
    expect(reader.end()).toEqual([{ kind: 'text', text: 'The bug is in' }]);
  });
  it('names a tool once, and again when it fails', () => {
    const [viewed, failed] = fx('denied.stream.jsonl').trimEnd().split('\n').slice(1, 3);
    const reader = agy.progress();
    expect(reader.line(viewed!)).toEqual([{ kind: 'tool', text: 'view_file: /work/src/format.js' }]);
    expect(reader.line(viewed!)).toEqual([]);
    expect(reader.line(failed!)).toEqual([
      { kind: 'error', text: 'run_command: ls -la failed: permission check failed for command "ls -la"' },
    ]);
  });
  it('reads a failed result as an error, and stderr as log', () => {
    const reader = agy.progress();
    expect(reader.line(fx('quota.stream.jsonl').trim())).toEqual([
      { kind: 'error', text: expect.stringContaining('Individual quota reached') as string },
    ]);
    expect(reader.errLine('AGY_ERROR: {}')).toEqual([{ kind: 'log', text: 'AGY_ERROR: {}' }]);
  });
  it('summary returns result.response, capped at 4000 chars', () => {
    expect(agy.summary(fx('success.jsonl'))).toBe('OK\n');
    const big = JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'x'.repeat(5000) } });
    expect(agy.summary(big).length).toBe(4000);
    expect(agy.summary('')).toBe('');
  });
});

describe('agy binary, defaults, detect and models', () => {
  it('defaultModel is null and executor is agy', () => {
    expect(agy.defaultModel()).toBeNull();
    expect(agy.executor).toBe('agy');
  });

  it.skipIf(process.platform === 'win32')('models() parses the recorded listing', async () => {
    const bin = fakeBin(`process.stderr.write('Fetching available models...\\n');process.stdout.write(${JSON.stringify(fx('models.txt'))});`);
    const a = createAgyAdapter({ bin, env: {} });
    const m = await a.models();
    expect(m).toHaveLength(13);
    expect(m[0]).toBe('gemini-4-argon-medium');
    expect(m).toContain('gpt-oss-120b-medium');
  });

  it.skipIf(process.platform === 'win32')('models() handles bullets, skips headers, and falls back to *', async () => {
    const bin = fakeBin(`process.stdout.write('Available models:\\n- model-a-low\\n  * model-b-high  Display\\n\\u2022 plain\\n');`);
    expect(await createAgyAdapter({ bin, env: {} }).models()).toEqual(['model-a-low', 'model-b-high', 'plain']);
    const empty = fakeBin(`process.stdout.write('Available models:\\n');`);
    expect(await createAgyAdapter({ bin: empty, env: {} }).models()).toEqual(['*']);
  });

  it.skipIf(process.platform === 'win32')('models() throws on a non-zero exit', async () => {
    const bin = fakeBin(`process.stderr.write('nope');process.exit(4);`);
    await expect(createAgyAdapter({ bin, env: {} }).models()).rejects.toThrow(/exit 4/);
  });

  it.skipIf(process.platform === 'win32')('detect() reports the version from --version', async () => {
    const bin = fakeBin(`console.log('agy 1.2.3');console.log('extra');`);
    const d = await createAgyAdapter({ bin, env: {} }).detect();
    expect(d).toEqual({ found: true, path: bin, version: 'agy 1.2.3' });
  });

  it('detect() reports not found when the binary does not resolve', async () => {
    const a = createAgyAdapter({ platform: 'linux', env: { PATH: dir } });
    expect(await a.detect()).toEqual({ found: false });
  });

  it('CORTEX_AGY_BIN is used when no bin option is given', async () => {
    const a = createAgyAdapter({ platform: 'linux', env: { CORTEX_AGY_BIN: path.join(dir, 'missing-agy') } });
    const d = await a.detect();
    expect(d.found).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('run() works when detached from the adapter', async () => {
    const bin = fakeBin(`console.log('a');`);
    const { run } = createAgyAdapter({ bin, env: process.env });
    const r = await run({
      prompt: 'p', cwd: dir, model: null, effort: null,
      signal: new AbortController().signal, timeoutMs: 20_000, onLine: () => undefined,
    });
    expect(r.exitCode).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('run() streams lines through onLine', async () => {
    const bin = fakeBin(`console.log('a');console.log('b');`);
    const lines: string[] = [];
    const r = await createAgyAdapter({ bin, env: process.env }).run({
      prompt: 'p', cwd: dir, model: null, effort: null,
      signal: new AbortController().signal, timeoutMs: 20_000, onLine: (l) => lines.push(l),
    });
    expect(r.exitCode).toBe(0);
    expect(lines).toEqual(['a', 'b']);
  });
});
