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
import { readState } from '../state.js';
import type { WorkerState } from '../state.js';

/** How long `stop` lets a running task wrap up (push its work) before it kills the worker. */
export const DEFAULT_STOP_GRACE_MS = 90_000;
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

/** A file's text, or null when it cannot be read. */
function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** A positive integer pid, else null. */
function parsePid(text: string | null): number | null {
  const t = text?.trim() ?? '';
  if (!/^\d+$/.test(t)) return null;
  const pid = Number(t);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/** The pid in the pid file: a positive integer, else null. */
export function readPid(paths: WorkerPaths): number | null {
  return parsePid(readText(paths.pidFile));
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

/**
 * Writes our pid into the pid file. Returns the pid of a live worker that holds it
 * instead, or null once it is ours. A stale file (dead pid, or garbage) is removed only
 * while it still holds what was judged stale, so a file another start wrote meanwhile
 * survives and is judged again. `read` reads the file; tests use it to race another start.
 */
export function claimPidFile(paths: WorkerPaths, read: (file: string) => string | null = readText): number | null {
  mkdirSync(paths.home, { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    const text = read(paths.pidFile);
    if (text !== null) {
      const pid = parsePid(text);
      if (pid !== null && pid !== process.pid && isAlive(pid)) return pid;
      if (read(paths.pidFile) !== text) continue; // replaced since we looked: look again
      rmSync(paths.pidFile, { force: true });
    }
    try {
      writeFileSync(paths.pidFile, `${process.pid}\n`, { flag: 'wx' });
      return null;
    } catch (err) {
      // another start wrote it between our check and our write: look again
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`could not claim ${paths.pidFile}`);
}

/** Removes the pid file only while it still names `pid`, so a newer worker's file survives. */
function removePidFile(paths: WorkerPaths, pid: number): void {
  if (readPid(paths) === pid) rmSync(paths.pidFile, { force: true });
}

/**
 * The argv the background `start` gets: without `--daemon`/`-d`, also inside a group of
 * short flags (`-fd` → `-f`), and without `--api-key <key>`/`--api-key=<key>`, which
 * would show in `ps`; the key goes in the child's env instead.
 */
function forwardedArgv(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--daemon' || a.startsWith('--api-key=')) continue;
    if (a === '--api-key') {
      i++; // and its value
      continue;
    }
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
 * Re-runs `start` (`argv` minus the daemon flag and the key) detached, with stdout and
 * stderr appended to the log, and waits until the child has written its pid file. An
 * `--api-key` reaches the child as `CORTEX_API_KEY`, which its start scrubs from its env.
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
  // a stale pid file stays: the child's claimPidFile replaces it, and removing it here
  // could remove the claim of a child another `start -d` just spawned
  mkdirSync(paths.home, { recursive: true });

  const env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env), CORTEX_WORKER_DAEMON: '1' };
  if (args.apiKey !== undefined) env['CORTEX_API_KEY'] = args.apiKey;

  let exited: string | null = null;
  let child: ChildProcess;
  const logFd = openSync(paths.logFile, 'a');
  try {
    child = spawn(process.execPath, [scriptPath, 'start', ...forwardedArgv(argv)], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
      env,
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
      // left running: it may just be slow
      return {
        error:
          `the worker (pid ${pid ?? '?'}) wrote no pid file within ${timeoutMs / 1000} s and may still be starting; ` +
          `run \`cw status ${path.basename(paths.home)}\` to check, and see ${paths.logFile}`,
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
 * then kills its process tree, and on POSIX the engine's process group it recorded, which
 * leads a group of its own and so is outside that tree.
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
  // read once the worker is gone: a worker that reaped its engine on SIGTERM has cleared it
  const engineGroup = platform === 'win32' ? null : readState(paths.stateFile).engineGroup;
  if (engineGroup !== null) await killTree(engineGroup, platform, KILL_GRACE_MS);
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
