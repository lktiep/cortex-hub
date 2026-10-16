import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  UnsafeShellArgError,
  killTree,
  lastLines,
  needsShell,
  resolveCommand,
  runShell,
  spawnTracked,
} from './process.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-proc-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
}

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  let out = '';
  for await (const chunk of stream) out += String(chunk);
  return out;
}

describe('resolveCommand', () => {
  it('finds node on PATH', () => {
    const found = resolveCommand('node');
    expect(found).not.toBeNull();
  });

  it('tries PATHEXT on win32', () => {
    writeFileSync(path.join(dir, 'tool.CMD'), '@echo off');
    const found = resolveCommand('tool', 'win32', { PATH: dir, PATHEXT: '.EXE;.CMD' });
    expect(found).not.toBeNull();
    expect(found?.toLowerCase().endsWith('tool.cmd')).toBe(true);
  });

  it('splits PATH with the platform delimiter and returns null when missing', () => {
    mkdirSync(path.join(dir, 'a'));
    const sep = ';';
    expect(resolveCommand('nope', 'win32', { PATH: `${dir}${sep}${path.join(dir, 'a')}`, PATHEXT: '.EXE' })).toBeNull();
    expect(resolveCommand('nope', 'linux', { PATH: dir })).toBeNull();
  });
});

describe('needsShell', () => {
  it('is true for .cmd/.bat on win32 only', () => {
    expect(needsShell('C:\\x\\a.cmd', 'win32')).toBe(true);
    expect(needsShell('C:\\x\\a.BAT', 'win32')).toBe(true);
    expect(needsShell('C:\\x\\a.exe', 'win32')).toBe(false);
    expect(needsShell('/x/a.cmd', 'linux')).toBe(false);
    expect(needsShell('/x/a.cmd', 'darwin')).toBe(false);
  });
});

describe('spawnTracked', () => {
  it('rejects shell metacharacters when a shell is required', () => {
    expect(() =>
      spawnTracked('C:\\npm\\codex.cmd', ['a b; calc'], { cwd: dir, platform: 'win32' }),
    ).toThrow(UnsafeShellArgError);
    expect(() =>
      spawnTracked('C:\\npm\\codex.cmd', ['$(x)'], { cwd: dir, platform: 'win32' }),
    ).toThrow(UnsafeShellArgError);
  });

  it('rejects an unsafe command path when a shell is required', () => {
    expect(() =>
      spawnTracked('C:\\npm&calc\\codex.cmd', ['ok'], { cwd: dir, platform: 'win32' }),
    ).toThrow(UnsafeShellArgError);
    expect(() =>
      spawnTracked('C:\\%APPDATA%\\codex.cmd', [], { cwd: dir, platform: 'win32' }),
    ).toThrow(UnsafeShellArgError);
  });

  it('passes stdin and captures stdout', async () => {
    const t = spawnTracked(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], {
      cwd: dir,
      stdin: 'hello\nworld',
    });
    try {
      const [out, res] = await Promise.all([collect(t.stdout), t.exited]);
      expect(out).toBe('hello\nworld');
      expect(res.code).toBe(0);
    } finally {
      await killTree(t.pid, undefined, 50);
    }
  });

  it('resolves code 127 for a nonexistent command without throwing', async () => {
    const t = spawnTracked(path.join(dir, 'does-not-exist'), [], { cwd: dir });
    const res = await t.exited;
    expect(res).toEqual({ code: 127, signal: null });
    expect(t.spawnError).toBeTruthy();
  });

  it('does not crash when the child exits before reading stdin', async () => {
    const t = spawnTracked(process.execPath, ['-e', 'process.exit(0)'], {
      cwd: dir,
      stdin: 'x'.repeat(1024 * 1024),
    });
    const res = await t.exited;
    expect(res.code).toBe(0);
  });
});

describe('killTree', () => {
  it.skipIf(process.platform === 'win32')('kills the child and its grandchild', async () => {
    const parent = `
      const { spawn } = require('node:child_process');
      const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
      console.log(g.pid);
      setInterval(()=>{},1000);
    `;
    const t = spawnTracked(process.execPath, ['-e', parent], { cwd: dir });
    let grandPid = 0;
    try {
      grandPid = await new Promise<number>((resolve, reject) => {
        let buf = '';
        t.stdout.on('data', (d: Buffer) => {
          buf += String(d);
          const m = /^(\d+)\n/.exec(buf);
          if (m) resolve(Number(m[1]));
        });
        t.exited.then(() => reject(new Error('parent exited early')), reject);
      });
      expect(alive(grandPid)).toBe(true);
      await killTree(t.pid, undefined, 200);
      expect(await waitDead(grandPid, 5000)).toBe(true);
      await t.exited;
    } finally {
      if (grandPid && alive(grandPid)) process.kill(grandPid, 'SIGKILL');
      try {
        process.kill(-t.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  });

  it('resolves for a pid that no longer exists', async () => {
    await expect(killTree(2 ** 22 - 3, undefined, 50)).resolves.toBeUndefined();
  });
});

describe('runShell', () => {
  it.skipIf(process.platform === 'win32')('returns exit code and combined output', async () => {
    const r = await runShell('echo out; echo err 1>&2; exit 3', dir);
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
    expect(r.output).toContain('out');
    expect(r.output).toContain('err');
  });

  it.skipIf(process.platform === 'win32')('times out, reports timedOut and kills the tree', async () => {
    const started = Date.now();
    const r = await runShell('sleep 30', dir, { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(124);
    expect(Date.now() - started).toBeLessThan(20000);
  });

  it.skipIf(process.platform === 'win32')('resolves promptly for an already-aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    const started = Date.now();
    const r = await runShell('sleep 30', dir, { signal: ac.signal });
    expect(Date.now() - started).toBeLessThan(20000);
    expect(r.exitCode).not.toBe(0);
  });

  it.skipIf(process.platform === 'win32')('caps output to the last 1 MiB', async () => {
    const r = await runShell(
      `${JSON.stringify(process.execPath)} -e "process.stdout.write('a'.repeat(2*1024*1024)+'END')"`,
      dir,
    );
    expect(r.exitCode).toBe(0);
    expect(r.output.length).toBeLessThanOrEqual(1024 * 1024);
    expect(r.output.endsWith('END')).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('maps a signal death to 128 + signo', async () => {
    const r = await runShell('kill -TERM $$', dir);
    expect(r.exitCode).toBe(128 + os.constants.signals.SIGTERM);
  });
});

describe('lastLines', () => {
  it('keeps the last n lines', () => {
    expect(lastLines('a\nb\nc\nd', 2)).toBe('c\nd');
    expect(lastLines('a\nb', 5)).toBe('a\nb');
  });
  it('ignores one trailing newline and handles n <= 0', () => {
    expect(lastLines('a\nb\nc\n', 2)).toBe('b\nc');
    expect(lastLines('a\nb', 0)).toBe('');
    expect(lastLines('a\nb', -1)).toBe('');
  });
});
