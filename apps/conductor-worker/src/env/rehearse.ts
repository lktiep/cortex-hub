import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git as realGit, retryOnLock, scrubCredentials } from '../git.js';
import type { GitRun, RunResult } from '../git.js';
import { lastLines, runShell } from '../process.js';
import { NEEDS_INPUTS, projectCommands } from './requirements.js';

export interface TrialStep {
  name: 'setup' | 'test';
  command: string;
  exitCode: number;
  timedOut: boolean;
  /** The output's last lines, credentials scrubbed. */
  tail: string;
}

export interface Rehearsal {
  /** The commit the trial ran on, as `git rev-parse --abbrev-ref` names it. */
  ref: string | null;
  steps: TrialStep[];
  notes: string[];
  /** Why no trial ran at all, as when no worktree could be made. */
  error?: string;
  ok: boolean;
}

export interface RehearseDeps {
  git: GitRun;
  runShell: typeof runShell;
  env: NodeJS.ProcessEnv;
  /** Each step's limit. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Where the trial worktree goes; os.tmpdir() by default. */
  tmpRoot?: string;
  /** Called as each step starts, so a long install does not look stuck. */
  onStep?: (name: TrialStep['name'], command: string) => void;
}

/** Long enough for a first install on a slow disk. */
export const TRIAL_TIMEOUT_MS = 20 * 60 * 1000;
const TAIL_LINES = 40;

export function defaultRehearseDeps(
  env: NodeJS.ProcessEnv,
  extra: Pick<RehearseDeps, 'signal' | 'onStep'> = {},
): RehearseDeps {
  return { git: realGit, runShell, env, timeoutMs: TRIAL_TIMEOUT_MS, ...extra };
}

const gitTail = (r: RunResult): string => scrubCredentials(lastLines(`${r.stdout}\n${r.stderr}`.trim(), 10));

/** The branch tasks start from, as far as this clone knows without fetching; else HEAD. */
export async function baseRef(repo: string, git: GitRun): Promise<string> {
  const r = await git(['rev-parse', '--abbrev-ref', 'origin/HEAD'], { cwd: repo });
  const name = r.stdout.trim();
  return r.code === 0 && name !== '' && name !== 'origin/HEAD' ? name : 'HEAD';
}

/**
 * Runs the project's setup and test commands once, as a task would, in a throwaway worktree of
 * the branch tasks start from. The worktree is removed afterwards, whatever happened.
 */
export async function rehearse(repo: string, deps: RehearseDeps): Promise<Rehearsal> {
  const notes: string[] = [];
  const ref = await baseRef(repo, deps.git);
  if (ref === 'HEAD') notes.push('origin/HEAD is not set, so the trial used the checked-out commit');

  const tmp = mkdtempSync(path.join(deps.tmpRoot ?? os.tmpdir(), 'cw-check-'));
  const wt = path.join(tmp, 'wt');
  try {
    const add = await retryOnLock(() => deps.git(['worktree', 'add', '--detach', wt, ref], { cwd: repo }));
    if (add.code !== 0) {
      return { ref, steps: [], notes, error: `could not make a trial worktree: ${gitTail(add)}`, ok: false };
    }

    const { setup, test } = projectCommands(wt, deps.env);
    if (setup === null && test === null) {
      notes.push('no setup or test command to try');
      return { ref, steps: [], notes, ok: true };
    }

    const steps: TrialStep[] = [];
    const opts = { timeoutMs: deps.timeoutMs, env: deps.env, ...(deps.signal === undefined ? {} : { signal: deps.signal }) };
    for (const [name, command] of [['setup', setup], ['test', test]] as const) {
      if (command === null) continue;
      deps.onStep?.(name, command);
      const r = await deps.runShell(command, wt, opts);
      const tail = scrubCredentials(lastLines(r.output.trimEnd(), TAIL_LINES));
      steps.push({ name, command, exitCode: r.exitCode, timedOut: r.timedOut, tail });
      if (r.exitCode !== 0 || deps.signal?.aborted === true) break;
    }
    return { ref, steps, notes, ok: deps.signal?.aborted !== true && steps.every((s) => s.exitCode === 0) };
  } finally {
    // no `git worktree prune`: it would also drop the user's own registrations of missing paths
    if (existsSync(wt)) {
      const r = await retryOnLock(() => deps.git(['worktree', 'remove', '--force', wt], { cwd: repo }));
      if (r.code !== 0) notes.push(`could not unregister the trial worktree ${wt}: ${gitTail(r)}`);
    }
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * What a trial's result rests on: the branch, the files that say what the project needs, and
 * this machine's own setup and test commands. null when git cannot list them.
 */
export async function trialFingerprint(repo: string, git: GitRun, env: NodeJS.ProcessEnv): Promise<string | null> {
  const ref = await baseRef(repo, git);
  const r = await git(['ls-tree', '-r', ref, '--', ...NEEDS_INPUTS], { cwd: repo });
  if (r.code !== 0) return null;
  const parts = [ref, r.stdout, env['CORTEX_SETUP_CMD'] ?? '', env['CORTEX_TEST_CMD'] ?? ''];
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}
