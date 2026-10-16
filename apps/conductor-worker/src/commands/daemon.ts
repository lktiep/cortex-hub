// Per-agent daemon state on disk: `start -d` spawns a detached `start`, `stop` asks it
// to stop through the stop file (no SIGTERM reaches a detached process on Windows),
// `status` reads the pid and state files, `logs` tails the log.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { CliArgs } from '../cli.js';
import type { WorkerPaths } from '../paths.js';
import { killTree } from '../process.js';
import type { WorkerState } from '../state.js';

const DEFAULT_STOP_GRACE_MS = 90_000;
/** How long the process tree gets between SIGTERM and SIGKILL once the grace period is over. */
const KILL_GRACE_MS = 5_000;
const DEFAULT_TAIL_LINES = 200;
const DEFAULT_FOLLOW_POLL_MS = 500;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** The pid in the pid file: a positive integer, else null. */
export function readPid(paths: WorkerPaths): number | null {
  let text: string;
  try {
    text = readFileSync(paths.pidFile, 'utf8').trim();
  } catch {
    return null;
  }
  if (!/^\d+$/.test(text)) return null;
  const pid = Number(text);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Removes the pid file only while it still names `pid`, so a newer worker's file survives. */
function removePidFile(paths: WorkerPaths, pid: number): void {
  if (readPid(paths) === pid) rmSync(paths.pidFile, { force: true });
}

/** `argv` without `--daemon`/`-d`, also inside a group of short flags (`-fd` → `-f`). */
function withoutDaemonFlag(argv: string[]): string[] {
  const out: string[] = [];
  for (const a of argv) {
    if (a === '--daemon') continue;
    if (/^-[^-]/.test(a)) {
      const rest = a.slice(1).replaceAll('d', '');
      if (rest !== '') out.push(`-${rest}`);
      continue;
    }
    out.push(a);
  }
  return out;
}

export interface DaemonOptions {
  env?: NodeJS.ProcessEnv;
  /** How long to wait for the child's pid file. */
  timeoutMs?: number;
  pollMs?: number;
}

/**
 * Re-runs `start` (`argv` minus the daemon flag) detached, with stdout and stderr
 * appended to the log, and waits until the child has written its pid file.
 */
export async function startDaemon(
  args: CliArgs,
  paths: WorkerPaths,
  scriptPath: string,
  argv: string[],
  opts: DaemonOptions = {},
): Promise<{ pid: number } | { error: string }> {
  if (args.command !== 'start') return { error: `cannot run ${args.command} as a daemon` };
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const pollMs = opts.pollMs ?? 100;

  const existing = readPid(paths);
  if (existing !== null && isAlive(existing)) return { error: `already running (pid ${existing})` };
  rmSync(paths.pidFile, { force: true });
  mkdirSync(paths.home, { recursive: true });

  let exited: string | null = null;
  let child: ChildProcess;
  const logFd = openSync(paths.logFile, 'a');
  try {
    child = spawn(process.execPath, [scriptPath, 'start', ...withoutDaemonFlag(argv)], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...(opts.env ?? process.env), CORTEX_WORKER_DAEMON: '1' },
    });
  } catch (err) {
    return { error: `could not start the worker: ${(err as Error).message}` };
  } finally {
    closeSync(logFd);
  }
  child.on('error', (err) => {
    exited = `could not be started (${err.message})`;
  });
  child.on('exit', (code, signal) => {
    exited = signal !== null ? `was killed by ${signal}` : `exited with code ${code ?? 'unknown'}`;
  });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pid = child.pid;
    if (pid !== undefined && readPid(paths) === pid) return { pid };
    if (exited !== null) {
      return { error: `the worker ${exited} before it wrote its pid file; see ${paths.logFile}` };
    }
    if (Date.now() >= deadline) {
      return {
        error: `the worker (pid ${pid ?? '?'}) wrote no pid file within ${timeoutMs / 1000} s; see ${paths.logFile}`,
      };
    }
    await sleep(pollMs);
  }
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  return true;
}

/**
 * Asks the worker to stop through the stop file, waits `graceMs` (enough for a WIP push),
 * then kills its process tree.
 */
export async function stopWorker(
  paths: WorkerPaths,
  opts: { graceMs?: number; platform?: NodeJS.Platform } = {},
): Promise<'stopped' | 'killed' | 'not-running'> {
  const platform = opts.platform ?? process.platform;
  const pid = readPid(paths);
  if (pid === null || !isAlive(pid)) {
    if (pid !== null) removePidFile(paths, pid);
    rmSync(paths.stopFile, { force: true });
    return 'not-running';
  }

  writeFileSync(paths.stopFile, '');
  const cleanUp = (): void => {
    rmSync(paths.stopFile, { force: true });
    removePidFile(paths, pid);
  };
  if (await waitGone(pid, opts.graceMs ?? DEFAULT_STOP_GRACE_MS)) {
    cleanUp();
    return 'stopped';
  }

  await killTree(pid, platform, KILL_GRACE_MS);
  // a foreground worker leads no process group, so the group kill above can miss it
  if (isAlive(pid) && platform !== 'win32') {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone already
    }
  }
  if (!(await waitGone(pid, KILL_GRACE_MS))) {
    throw new Error(`pid ${pid} is still running after SIGKILL`);
  }
  cleanUp();
  return 'killed';
}

export function statusText(paths: WorkerPaths, state: WorkerState): string {
  const pid = readPid(paths);
  const running =
    pid === null ? 'stopped' : isAlive(pid) ? `running (pid ${pid})` : `stopped (stale pid file: ${pid})`;
  const lr = state.lastRegistered;
  const lines = [
    `agent id:        ${path.basename(paths.home)}`,
    `state:           ${running}`,
    `active task:     ${state.activeTaskId ?? 'none'}`,
  ];
  if (state.unconfirmed !== null) {
    lines.push(`unconfirmed:     ${state.unconfirmed.msg.type} for ${state.unconfirmed.taskId}, not yet seen by the hub`);
  }
  lines.push(
    `last registered: ${lr === null ? 'never' : `${lr.at} (hub v${lr.hubVersion}, project ${lr.projectId ?? 'none'})`}`,
    `log:             ${paths.logFile}`,
  );
  return lines.join('\n');
}

/** The last `n` lines of `text`, keeping its final newline. */
function tailLines(text: string, n: number): string {
  if (n <= 0) return '';
  let i = text.endsWith('\n') ? text.length - 1 : text.length;
  for (let count = 0; i > 0; ) {
    const nl = text.lastIndexOf('\n', i - 1);
    if (nl < 0) return text;
    if (++count === n) return text.slice(nl + 1);
    i = nl;
  }
  return text.slice(i);
}

/** Bytes `[from, to)` of `file`; empty when it cannot be read. */
function readRange(file: string, from: number, to: number): Buffer {
  if (to <= from) return Buffer.alloc(0);
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(to - from);
    const n = readSync(fd, buf, 0, buf.length, from);
    return buf.subarray(0, n);
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function statOrNull(file: string): { ino: number; size: number } | null {
  try {
    const st = statSync(file);
    return { ino: st.ino, size: st.size };
  } catch {
    return null;
  }
}

export interface LogsOptions {
  follow: boolean;
  lines?: number;
  out?: NodeJS.WritableStream;
  signal?: AbortSignal;
  pollMs?: number;
}

/**
 * Prints the last lines of the log; with `follow`, keeps printing what is appended,
 * polling the size, until `signal` fires. A rotated (renamed, then recreated) or
 * truncated log is read again from its start.
 */
export async function printLogs(paths: WorkerPaths, opts: LogsOptions): Promise<void> {
  const out = opts.out ?? process.stdout;
  const { signal } = opts;
  const pollMs = opts.pollMs ?? DEFAULT_FOLLOW_POLL_MS;
  const file = paths.logFile;
  if (signal?.aborted) return;

  let cur = statOrNull(file);
  let offset = 0;
  if (cur === null) {
    out.write(`no log file yet at ${file}\n`);
    if (!opts.follow) return;
  } else {
    const all = readRange(file, 0, cur.size);
    out.write(tailLines(all.toString('utf8'), opts.lines ?? DEFAULT_TAIL_LINES));
    offset = all.length;
    if (!opts.follow) return;
  }

  while (!signal?.aborted) {
    await sleep(pollMs, signal);
    if (signal?.aborted) break;
    const st = statOrNull(file);
    if (st === null) continue; // between the rename and the new file
    if (cur !== null && st.ino !== cur.ino) {
      // rotated: finish the old file (now `<log>.1`) first
      const old = statOrNull(`${file}.1`);
      if (old !== null && old.ino === cur.ino && old.size > offset) out.write(readRange(`${file}.1`, offset, old.size));
      offset = 0;
    } else if (st.size < offset) {
      offset = 0; // truncated
    }
    cur = st;
    if (st.size > offset) {
      const chunk = readRange(file, offset, st.size);
      out.write(chunk);
      offset += chunk.length;
    }
  }
}
