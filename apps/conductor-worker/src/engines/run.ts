import os from 'node:os';
import { exitCodeOf, killTree, reapGroup, spawnTracked } from '../process.js';
import type { Tracked } from '../process.js';
import type { RunInput, RunOutput } from './types.js';

/** Caps in UTF-16 code units (string length), not bytes. */
const STDOUT_CAP = 8 * 1024 * 1024;
const STDERR_CAP = 1024 * 1024;
const SPAWN_FAILED_CODE = 127;
const KILL_GRACE_MS = 3000;
const DRAIN_MS = 250;

function tailCap(text: string, cap: number): string {
  return text.length > cap ? text.slice(-cap) : text;
}

/**
 * Runs an engine CLI to completion, streaming stdout lines to `input.onLine`.
 * Never rejects: a failure to start resolves exit code 127 with the reason in `stderr`.
 */
export async function runCli(
  bin: string,
  built: { args: string[]; stdin?: string },
  input: RunInput,
  opts: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv },
): Promise<RunOutput> {
  if (input.signal.aborted) {
    return {
      exitCode: 128 + os.constants.signals.SIGTERM,
      stdout: '',
      stderr: '',
      timedOut: false,
      aborted: true,
    };
  }

  let tracked: Tracked;
  try {
    tracked = spawnTracked(bin, built.args, {
      cwd: input.cwd,
      env: opts.env,
      stdin: built.stdin,
      platform: opts.platform,
    });
  } catch (err) {
    return {
      exitCode: SPAWN_FAILED_CODE,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      timedOut: false,
      aborted: false,
    };
  }

  let stdout = '';
  let stderr = '';
  let pending = '';
  const emit = (line: string): void => {
    try {
      input.onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
    } catch {
      // a broken progress callback must not break the run
    }
  };
  tracked.stdout.setEncoding('utf8');
  tracked.stderr.setEncoding('utf8');
  tracked.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    if (stdout.length > STDOUT_CAP * 2) stdout = stdout.slice(-STDOUT_CAP);
    pending += chunk;
    let nl = pending.indexOf('\n');
    while (nl !== -1) {
      emit(pending.slice(0, nl));
      pending = pending.slice(nl + 1);
      nl = pending.indexOf('\n');
    }
  });
  tracked.stderr.on('data', (chunk: string) => {
    stderr += chunk;
    if (stderr.length > STDERR_CAP * 2) stderr = stderr.slice(-STDERR_CAP);
  });

  let timedOut = false;
  let aborted = false;
  const stop = (): void => {
    void killTree(tracked.pid, opts.platform, KILL_GRACE_MS);
  };
  const onAbort = (): void => {
    aborted = true;
    stop();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, input.timeoutMs);
  input.signal.addEventListener('abort', onAbort, { once: true });

  const { code, signal } = await tracked.exited;
  // the child is gone: a late timer or abort must not flag the run or kill a recycled pid
  clearTimeout(timer);
  input.signal.removeEventListener('abort', onAbort);
  reapGroup(tracked.pid, opts.platform);

  // let the last buffered chunks arrive, but never wait on a grandchild holding the pipe
  let drainTimer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.all(
      [tracked.stdout, tracked.stderr].map(
        (s) => new Promise<void>((r) => (s.readableEnded ? r() : void s.once('close', () => r()))),
      ),
    ),
    new Promise<void>((r) => {
      drainTimer = setTimeout(r, DRAIN_MS);
    }),
  ]);
  clearTimeout(drainTimer);
  tracked.stdout.destroy();
  tracked.stderr.destroy();
  if (pending !== '') emit(pending);

  const exitCode = exitCodeOf(code, signal);
  if (exitCode === SPAWN_FAILED_CODE && tracked.spawnError !== undefined) {
    stderr += (stderr === '' ? '' : '\n') + tracked.spawnError;
  }
  return {
    exitCode,
    stdout: tailCap(stdout, STDOUT_CAP),
    stderr: tailCap(stderr, STDERR_CAP),
    timedOut,
    aborted,
  };
}
