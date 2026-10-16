import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';

export class UnsafeShellArgError extends Error {
  constructor(what: string, value: string) {
    super(`refusing to pass ${what} through a shell: ${JSON.stringify(value)}`);
    this.name = 'UnsafeShellArgError';
  }
}

export interface Tracked {
  pid: number;
  stdout: Readable;
  stderr: Readable;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Set when the process could not be started (ENOENT, EACCES); `exited` then resolves code 127. */
  spawnError?: string;
}

const SAFE_SHELL_ARG = /^[\w.:/=*@-]+$/;
const UNSAFE_SHELL_PATH = /["%^&|<>]/;
/** Output cap in UTF-16 code units (string length), not bytes. */
const OUTPUT_CAP = 1024 * 1024;
const SPAWN_FAILED_CODE = 127;
const TIMEOUT_CODE = 124;

function envValue(env: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return env[key];
  const found = Object.keys(env).find((k) => k.toLowerCase() === key.toLowerCase());
  return found === undefined ? undefined : env[found];
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function resolveCommand(
  name: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const win = platform === 'win32';
  // an injected win32 on another OS still has to hit the real filesystem
  const p = win && process.platform === 'win32' ? path.win32 : path.posix;
  const dirs = (envValue(env, 'PATH', platform) ?? '').split(win ? ';' : ':').filter((d) => d !== '');
  const exts = win
    ? (envValue(env, 'PATHEXT', platform) ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e !== '')
    : [''];
  const hasExt = win && exts.some((e) => name.toLowerCase().endsWith(e.toLowerCase()));
  const variants = hasExt ? ['', ...exts] : exts;

  const usable = (candidate: string): boolean => {
    if (!isFile(candidate)) return false;
    if (win || platform !== process.platform) return true;
    try {
      accessSync(candidate, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  const candidates = name.includes('/') || (win && name.includes('\\')) ? [''] : dirs;
  for (const dir of candidates) {
    for (const ext of variants) {
      const candidate = dir === '' ? name + ext : p.join(dir, name + ext);
      if (usable(candidate)) return candidate;
    }
  }
  return null;
}

export function needsShell(resolved: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(resolved);
}

/** Validates and joins a cmd.exe command line; the command path is always double-quoted. */
export function buildWin32ShellLine(cmd: string, args: string[]): string {
  if (UNSAFE_SHELL_PATH.test(cmd)) throw new UnsafeShellArgError('command path', cmd);
  for (const a of args) {
    if (!SAFE_SHELL_ARG.test(a)) throw new UnsafeShellArgError('argument', a);
  }
  return [`"${cmd}"`, ...args].join(' ');
}

export function spawnTracked(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; stdin?: string; platform?: NodeJS.Platform },
): Tracked {
  const platform = opts.platform ?? process.platform;
  const win = platform === 'win32';
  const shell = needsShell(cmd, platform);
  // one validated command line and no args array: Node 24+ deprecates args with shell: true
  const child = spawn(shell ? buildWin32ShellLine(cmd, args) : cmd, shell ? [] : args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    detached: !win,
    windowsHide: win,
    shell,
  });
  return track(child, opts.stdin);
}

function track(child: ChildProcess, stdin?: string): Tracked {
  const tracked = {
    pid: child.pid ?? 0,
    stdout: child.stdout as Readable,
    stderr: child.stderr as Readable,
  } as Tracked;
  tracked.exited = new Promise((resolve) => {
    let settled = false;
    const settle = (v: { code: number | null; signal: NodeJS.Signals | null }): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    child.on('error', (err) => {
      tracked.spawnError = err.message;
      settle({ code: SPAWN_FAILED_CODE, signal: null });
    });
    child.on('exit', (code, signal) => settle({ code, signal }));
  });
  if (child.stdin) {
    child.stdin.on('error', () => {
      // EPIPE when the child exits before reading; must not crash the daemon
    });
    if (stdin !== undefined) child.stdin.end(stdin);
  }
  return tracked;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function killTree(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  graceMs = 10_000,
): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (platform === 'win32') {
    await new Promise<void>((resolve) => {
      try {
        const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        k.on('error', () => resolve());
        k.on('exit', () => resolve());
      } catch {
        resolve();
      }
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    return; // ESRCH: already gone; anything else: nothing more we can do
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!groupAlive(pid)) return;
    await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // ESRCH counts as success
  }
}

function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal !== null) return 128 + (os.constants.signals[signal] ?? 0);
  return 1;
}

export async function runShell(
  command: string,
  cwd: string,
  opts: { signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ exitCode: number; output: string; timedOut: boolean }> {
  const platform = process.platform;
  const win = platform === 'win32';
  if (opts.signal?.aborted) {
    return { exitCode: 128 + os.constants.signals.SIGTERM, output: '', timedOut: false };
  }

  let child: ChildProcess;
  try {
    child = win
      ? spawn('cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
          cwd,
          env: opts.env ?? process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          windowsVerbatimArguments: true,
        })
      : spawn('sh', ['-c', command], {
          cwd,
          env: opts.env ?? process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        });
  } catch (err) {
    return { exitCode: SPAWN_FAILED_CODE, output: (err as Error).message, timedOut: false };
  }
  const tracked = track(child);

  let output = '';
  const onData = (chunk: string): void => {
    output += chunk;
    if (output.length > OUTPUT_CAP * 2) output = output.slice(-OUTPUT_CAP);
  };
  for (const s of [tracked.stdout, tracked.stderr]) {
    s.setEncoding('utf8');
    s.on('data', onData);
  }

  let timedOut = false;
  const stop = (): void => {
    void killTree(tracked.pid, platform, 3000);
  };
  const timer =
    opts.timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          stop();
        }, opts.timeoutMs)
      : undefined;
  opts.signal?.addEventListener('abort', stop, { once: true });

  const { code, signal } = await tracked.exited;
  // the child is gone: a late timer or abort must not report 124 or kill a recycled pid
  if (timer) clearTimeout(timer);
  opts.signal?.removeEventListener('abort', stop);

  if (!win && tracked.pid > 0) {
    try {
      // background grandchildren of the command must not outlive it
      process.kill(-tracked.pid, 'SIGKILL');
    } catch {
      // best effort: ESRCH or anything else
    }
  }
  // let the last buffered chunks arrive, but never wait on a grandchild holding the pipe
  let drainTimer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.all(
      [tracked.stdout, tracked.stderr].map(
        (s) => new Promise<void>((r) => (s.readableEnded ? r() : void s.once('close', () => r()))),
      ),
    ),
    new Promise<void>((r) => {
      drainTimer = setTimeout(r, 250);
    }),
  ]);
  clearTimeout(drainTimer);
  // output arriving after the drain window is dropped
  tracked.stdout.destroy();
  tracked.stderr.destroy();

  const exitCode = timedOut ? TIMEOUT_CODE : exitCodeOf(code, signal);
  if (exitCode === SPAWN_FAILED_CODE && tracked.spawnError !== undefined) {
    output += (output === '' ? '' : '\n') + tracked.spawnError;
  }
  return {
    exitCode,
    output: output.length > OUTPUT_CAP ? output.slice(-OUTPUT_CAP) : output,
    timedOut,
  };
}

export function lastLines(text: string, n: number): string {
  if (n <= 0) return '';
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return body.split('\n').slice(-n).join('\n');
}
