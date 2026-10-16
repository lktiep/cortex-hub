import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunInput } from './types.js';
import { runCli } from './run.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-run-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const opts = { platform: process.platform, env: process.env };
const posixOnly = it.skipIf(process.platform === 'win32');

function script(body: string): string[] {
  const file = path.join(dir, 'fake.mjs');
  writeFileSync(file, body);
  return [file];
}

function input(over: Partial<RunInput> = {}): { input: RunInput; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    input: {
      prompt: 'p',
      cwd: dir,
      model: null,
      effort: null,
      signal: new AbortController().signal,
      timeoutMs: 20_000,
      onLine: (l) => lines.push(l),
      ...over,
    },
  };
}

describe('runCli', () => {
  it('splits stdout into lines across chunks, strips CR and flushes an unterminated tail', async () => {
    const args = script(`
      process.stdout.write('one\\ntw');
      setTimeout(() => process.stdout.write('o\\r\\nthree\\nfour'), 80);
    `);
    const i = input();
    const r = await runCli(process.execPath, { args }, i.input, opts);
    expect(r.exitCode).toBe(0);
    expect(i.lines).toEqual(['one', 'two', 'three', 'four']);
    expect(r.stdout).toBe('one\ntwo\r\nthree\nfour');
    expect(r.timedOut).toBe(false);
    expect(r.aborted).toBe(false);
  });

  it('captures stderr and a non-zero exit code', async () => {
    const args = script(`console.error('boom'); process.exit(3);`);
    const r = await runCli(process.execPath, { args }, input().input, opts);
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain('boom');
  });

  it('delivers stdin', async () => {
    const args = script(`process.stdin.pipe(process.stdout);`);
    const i = input();
    const r = await runCli(process.execPath, { args, stdin: 'hello stdin\n' }, i.input, opts);
    expect(r.exitCode).toBe(0);
    expect(i.lines).toEqual(['hello stdin']);
  });

  it.skipIf(process.platform === 'win32')('kills the tree on timeout and reports timedOut', async () => {
    const args = script(`setInterval(() => {}, 1000);`);
    const t0 = Date.now();
    const r = await runCli(process.execPath, { args }, input({ timeoutMs: 300 }).input, opts);
    expect(r.timedOut).toBe(true);
    expect(r.aborted).toBe(false);
    expect(Date.now() - t0).toBeLessThan(15_000);
  });

  it.skipIf(process.platform === 'win32')('kills the tree on abort and reports aborted', async () => {
    const args = script(`setInterval(() => {}, 1000);`);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const r = await runCli(process.execPath, { args }, input({ signal: ac.signal }).input, opts);
    expect(r.aborted).toBe(true);
    expect(r.timedOut).toBe(false);
  });

  it('resolves promptly without spawning when the signal is already aborted', async () => {
    const marker = path.join(dir, 'ran');
    const args = script(`import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'x');`);
    const ac = new AbortController();
    ac.abort();
    const r = await runCli(process.execPath, { args }, input({ signal: ac.signal }).input, opts);
    expect(r.aborted).toBe(true);
    expect(r.stdout).toBe('');
    await new Promise((res) => setTimeout(res, 200));
    expect(existsSync(marker)).toBe(false);
  });

  it('resolves 127 with the message when spawnTracked throws', async () => {
    const r = await runCli('C:\\x\\agy.cmd', { args: ['a b'] }, input().input, {
      platform: 'win32',
      env: process.env,
    });
    expect(r.exitCode).toBe(127);
    expect(r.stderr).toMatch(/refusing to pass/);
    expect(r.timedOut).toBe(false);
    expect(r.aborted).toBe(false);
  });

  posixOnly('reports the engine process group once it starts', async () => {
    const args = script(`console.log(process.pid);`);
    const groups: number[] = [];
    const onGroup = (g: number): void => {
      groups.push(g);
    };
    const r = await runCli(process.execPath, { args }, input({ onGroup }).input, opts);
    expect(r.exitCode).toBe(0);
    // the engine is spawned detached, so it leads its own group
    expect(groups).toEqual([Number(r.stdout.trim())]);
  });

  it('reports no process group on win32, where the engine leads none, or when the spawn fails', async () => {
    const args = script(`console.log('x');`);
    const groups: number[] = [];
    const onGroup = (g: number): void => {
      groups.push(g);
    };
    const win = await runCli(process.execPath, { args }, input({ onGroup }).input, { platform: 'win32', env: process.env });
    expect(win.exitCode).toBe(0);
    const missing = await runCli(path.join(dir, 'nope'), { args: [] }, input({ onGroup }).input, opts);
    expect(missing.exitCode).toBe(127);
    expect(groups).toEqual([]);
  });

  posixOnly('survives a throwing onGroup callback', async () => {
    const args = script(`console.log('x');`);
    const onGroup = (): void => {
      throw new Error('cb');
    };
    const r = await runCli(process.execPath, { args }, input({ onGroup }).input, opts);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('x\n');
  });

  it('resolves 127 with the spawn error for a missing binary', async () => {
    const r = await runCli(path.join(dir, 'nope'), { args: [] }, input().input, opts);
    expect(r.exitCode).toBe(127);
    expect(r.stderr).toMatch(/ENOENT/);
  });

  it('keeps only the last 8 MiB of stdout', async () => {
    const args = script(`process.stdout.write('a'.repeat(9*1024*1024) + 'END');`);
    const r = await runCli(process.execPath, { args }, input().input, opts);
    expect(r.stdout.length).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(r.stdout.endsWith('END')).toBe(true);
  });

  it('never hands onLine an over-cap partial line', async () => {
    const args = script(
      `process.stdout.write('before\\n'); process.stdout.write('a'.repeat(9*1024*1024)); process.stdout.write('\\n{"ok":1}\\n');`,
    );
    const i = input();
    const r = await runCli(process.execPath, { args }, i.input, opts);
    expect(r.exitCode).toBe(0);
    expect(i.lines).toEqual(['before', '{"ok":1}']);
    expect(r.stdout.endsWith('{"ok":1}\n')).toBe(true);
  });

  it('survives a throwing onLine callback', async () => {
    const args = script(`console.log('x');`);
    const r = await runCli(
      process.execPath,
      { args },
      input({
        onLine: () => {
          throw new Error('cb');
        },
      }).input,
      opts,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('x\n');
  });
});
