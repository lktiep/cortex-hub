import type {
  AssignedTask,
  TaskAcceptMsg,
  TaskCompleteMsg,
  TaskDeclineMsg,
  TaskProgressMsg,
  TaskQuotaExhaustedMsg,
  TaskResult,
} from '@cortex/shared-types';
import type { Classification, EngineAdapter, RunOutput } from './engines/types.js';
import {
  BranchInUseError,
  commitAll,
  git,
  openPullRequest,
  prepareWorktree,
  pushBranch,
  removeWorktree,
} from './git.js';
import type { GhRun } from './git.js';
import type { Logger } from './logger.js';
import { worktreePath } from './paths.js';
import type { WorkerPaths } from './paths.js';
import { lastLines, runShell } from './process.js';
import { createProgressThrottle } from './progress.js';
import { buildPrompt } from './prompt.js';

export interface RunnerDeps {
  repo: string;
  remote: string;
  paths: WorkerPaths;
  adapter: EngineAdapter;
  send: (m: TaskProgressMsg) => void;
  sendReliable: (m: TaskAcceptMsg | TaskCompleteMsg | TaskQuotaExhaustedMsg | TaskDeclineMsg) => void;
  gh: GhRun;
  logger: Logger;
  env: NodeJS.ProcessEnv;
  engineTimeoutMs: number;
  identity: { name: string; email: string };
  now?: () => Date;
}

type AbortReason = 'revoked' | 'stopping';

export type RunOutcome =
  | { kind: 'completed' | 'failed'; msg: TaskCompleteMsg }
  | { kind: 'quota'; msg: TaskQuotaExhaustedMsg }
  | { kind: 'declined'; reason: string }
  | { kind: 'aborted'; reason: AbortReason };

const TEST_TAIL_LINES = 200;
const SETUP_TAIL_LINES = 40;
/** GitHub rejects a PR body over 65 536 chars; the summary is at most 4 000. */
const PR_TEST_TAIL_MAX = 50_000;

function taskHead(task: AssignedTask): string {
  return task.key ?? task.id.slice(0, 8);
}

export function commitTitle(task: AssignedTask): string {
  const firstLine = task.title.split(/\r?\n/, 1)[0] ?? '';
  return `${taskHead(task)}: ${firstLine.trim()}`;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function nonEmpty(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/** Minutes with at most two decimals: 3 600 000 → "60", 90 000 → "1.5". */
function minutes(ms: number): string {
  return String(Math.round(ms / 600) / 100);
}

/** A code fence longer than any backtick run inside `text`. */
function fenceFor(text: string): string {
  const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

function prBody(task: AssignedTask, summary: string, testOutput: string | undefined): string {
  const parts = [summary, `Cortex task: ${task.id}`].filter((p) => p.trim() !== '');
  if (testOutput !== undefined) {
    const tail = testOutput.length > PR_TEST_TAIL_MAX ? testOutput.slice(-PR_TEST_TAIL_MAX) : testOutput;
    const fence = fenceFor(tail);
    parts.push(`Test output (tail):\n${fence}\n${tail}\n${fence}`);
  }
  return parts.join('\n\n');
}

/** Commits ahead of origin/<baseBranch> mean the branch already carries work: returns HEAD then. */
async function priorWork(dir: string, baseBranch: string): Promise<string | null> {
  const count = await git(['rev-list', '--count', `origin/${baseBranch}..HEAD`], { cwd: dir });
  if (count.code !== 0) throw new Error(`git rev-list failed: ${lastLines(count.stderr.trim(), 20)}`);
  if (Number(count.stdout.trim()) <= 0) return null;
  const head = await git(['rev-parse', 'HEAD'], { cwd: dir });
  if (head.code !== 0) throw new Error(`git rev-parse failed: ${lastLines(head.stderr.trim(), 20)}`);
  return head.stdout.trim();
}

interface Wip {
  /** The WIP commit, or null when the tree was clean or the commit failed. */
  commit: string | null;
  pushed: boolean;
  /** What went wrong, for the error or the handoff note. */
  problem: string | null;
}

/**
 * Runs one accepted task end to end. Never throws: every path ends in an outcome.
 * Completed, failed and quota outcomes are sent through `sendReliable`; a decline or
 * an abort sends nothing.
 */
export async function runTask(
  task: AssignedTask,
  deps: RunnerDeps,
  signal: AbortSignal,
  opts: { resumed?: boolean } = {},
): Promise<RunOutcome> {
  const { adapter, logger } = deps;
  const now = deps.now ?? ((): Date => new Date());
  /** Set once the worktree is prepared; it is removed at the end unless `keepWorktree`. */
  let dir: string | null = null;
  let keepWorktree = false;
  let engineSummary = '';

  const log = (level: 'info' | 'warn' | 'error', m: string): void => logger[level](`task ${task.id}: ${m}`);
  const aborted = (): RunOutcome => ({
    kind: 'aborted',
    reason: signal.reason === 'revoked' ? 'revoked' : 'stopping',
  });
  const complete = (status: 'completed' | 'failed', result: TaskResult): RunOutcome => ({
    kind: status,
    msg: { type: 'task.complete', taskId: task.id, status, result, attempt: task.attempt },
  });
  const fail = (errors: Array<string | null>, extra: Partial<TaskResult> = {}): RunOutcome => {
    const error = errors.filter((e): e is string => e !== null).join('\n');
    return complete('failed', { summary: engineSummary.trim() !== '' ? engineSummary : error, ...extra, error });
  };

  /** Commits whatever the engine left as WIP and pushes it, so partial work is not lost. */
  const saveWip = async (worktree: string, reason: string): Promise<Wip> => {
    let commit: string | null;
    try {
      commit = await commitAll(worktree, `WIP ${taskHead(task)}: ${reason}`, deps.identity);
    } catch (err) {
      // `worktree remove --force` would discard the uncommitted work; a retry here reuses the worktree
      keepWorktree = true;
      const problem = `committing the work in progress failed; the worktree is kept at ${worktree}\n${messageOf(err)}`;
      log('error', problem);
      return { commit: null, pushed: false, problem };
    }
    if (commit === null) return { commit: null, pushed: false, problem: null };
    try {
      await pushBranch(worktree, task.branch);
      return { commit, pushed: true, problem: null };
    } catch (err) {
      const problem = `pushing the WIP commit ${commit} failed: ${messageOf(err)}`;
      log('error', problem);
      return { commit, pushed: false, problem };
    }
  };

  const failWithWip = async (worktree: string, reason: string, error: string): Promise<RunOutcome> => {
    const wip = await saveWip(worktree, reason);
    const pushed = wip.pushed && wip.commit !== null ? { branch: task.branch, commit: wip.commit } : {};
    return fail([error, wip.problem], pushed);
  };

  const quotaHandoff = async (
    worktree: string,
    verdict: Extract<Classification, { kind: 'quota' }>,
  ): Promise<RunOutcome> => {
    const wip = await saveWip(worktree, 'quota handoff');
    const model = task.route.model ?? adapter.defaultModel() ?? 'default';
    const lines = [`${adapter.executor} (${model}) ran out of quota.`];
    if (wip.pushed) lines.push(`Its work in progress is committed on ${task.branch} as ${wip.commit ?? ''}.`);
    else if (wip.problem === null) lines.push('It left no uncommitted changes.');
    else lines.push(wip.problem);
    const msg: TaskQuotaExhaustedMsg = {
      type: 'task.quota_exhausted',
      taskId: task.id,
      executor: adapter.executor,
      model,
      ...(verdict.modelScope !== undefined ? { modelScope: verdict.modelScope } : {}),
      ...(verdict.resetAt !== undefined ? { resetAt: verdict.resetAt } : {}),
      raw: verdict.raw,
      handoff: { branch: task.branch, commit: wip.pushed ? wip.commit : null, note: lines.join(' ') },
      attempt: task.attempt,
    };
    return { kind: 'quota', msg };
  };

  /** An abort once the engine has started: the WIP is saved, nothing is reported. */
  const abortWithWip = async (worktree: string): Promise<RunOutcome> => {
    const outcome = aborted();
    if (outcome.kind === 'aborted') await saveWip(worktree, outcome.reason);
    return outcome;
  };

  const runEngine = async (worktree: string, testCommand: string | null): Promise<RunOutput> => {
    const throttle = createProgressThrottle((message) =>
      deps.send({ type: 'task.progress', taskId: task.id, message }),
    );
    try {
      return await adapter.run({
        prompt: buildPrompt(task, { resumed: opts.resumed, testCommand }),
        cwd: worktree,
        model: task.route.model,
        effort: task.route.effort,
        signal,
        timeoutMs: deps.engineTimeoutMs,
        onLine: (line) => {
          const text = adapter.progressText(line);
          if (text !== null) throttle.push(text);
        },
      });
    } finally {
      throttle.stop();
    }
  };

  const execute = async (): Promise<RunOutcome> => {
    if (signal.aborted) return aborted();

    // 1. worktree
    let worktree: string;
    try {
      worktree = worktreePath(deps.paths, task.id);
      const { from } = await prepareWorktree(deps.repo, worktree, task.branch, task.baseBranch);
      log('info', `worktree ready at ${worktree} (from ${from})`);
    } catch (err) {
      if (err instanceof BranchInUseError) return { kind: 'declined', reason: `branch-in-use: ${err.path}` };
      return fail([`worktree: ${messageOf(err)}`]);
    }
    dir = worktree;
    if (signal.aborted) return aborted();

    const shellOpts = { signal, timeoutMs: deps.engineTimeoutMs, env: deps.env };

    // 2. setup
    const setupCommand = nonEmpty(task.context['setupCommand']) ?? nonEmpty(deps.env['CORTEX_SETUP_CMD']);
    if (setupCommand !== null) {
      const setup = await runShell(setupCommand, worktree, shellOpts);
      if (signal.aborted) return aborted();
      if (setup.exitCode !== 0) {
        const tail = lastLines(setup.output.trimEnd(), SETUP_TAIL_LINES);
        return fail([`setup command failed (exit ${setup.exitCode})${tail === '' ? '' : `\n${tail}`}`]);
      }
    }

    // 3. engine
    const testCommand = nonEmpty(task.testCommand) ?? nonEmpty(deps.env['CORTEX_TEST_CMD']);
    const run = await runEngine(worktree, testCommand);
    engineSummary = adapter.summary(run.stdout);
    log('info', `engine exited with ${String(run.exitCode)}${run.timedOut ? ' (timed out)' : ''}`);

    // 4. classify
    if (signal.aborted) return abortWithWip(worktree);
    if (run.timedOut) {
      return failWithWip(worktree, 'engine timeout', `engine timed out after ${minutes(deps.engineTimeoutMs)} min`);
    }
    const verdict = adapter.classify(run.exitCode, run.stdout, run.stderr, {
      model: task.route.model ?? adapter.defaultModel(),
      now: now(),
    });
    if (verdict.kind === 'quota') return quotaHandoff(worktree, verdict);
    if (verdict.kind === 'error') return failWithWip(worktree, 'engine error', verdict.message);

    // 5. tests
    let testOutput: string | undefined;
    let testError: string | null = null;
    if (testCommand !== null) {
      const tests = await runShell(testCommand, worktree, shellOpts);
      if (signal.aborted) return abortWithWip(worktree);
      testOutput = lastLines(tests.output, TEST_TAIL_LINES);
      if (tests.exitCode !== 0) testError = `tests failed (exit ${tests.exitCode})`;
    }
    const withTests = testOutput !== undefined ? { testOutput } : {};

    // 6. commit; from here on an abort lets git finish
    let commit: string | null;
    try {
      commit = (await commitAll(worktree, commitTitle(task), deps.identity)) ?? (await priorWork(worktree, task.baseBranch));
    } catch (err) {
      keepWorktree = true;
      return fail([testError, `could not commit the work; the worktree is kept at ${worktree}\n${messageOf(err)}`], withTests);
    }
    if (commit === null) {
      if (testError !== null) return fail([testError], withTests);
      if (task.context['allowEmpty'] !== true) return fail(['engine made no changes'], withTests);
      return complete('completed', { summary: engineSummary, ...withTests });
    }

    // 7. push and pull request
    try {
      await pushBranch(worktree, task.branch);
    } catch (err) {
      return fail([testError, `${messageOf(err)}\nthe commit ${commit} stays on the local branch ${task.branch}`], withTests);
    }
    let pr: { prUrl?: string; compareUrl?: string } = {};
    try {
      pr = await openPullRequest(
        worktree,
        {
          branch: task.branch,
          baseBranch: task.baseBranch,
          title: commitTitle(task),
          body: prBody(task, engineSummary, testOutput),
          remote: deps.remote,
        },
        deps.gh,
      );
    } catch (err) {
      log('warn', `opening a pull request failed: ${messageOf(err)}`);
    }

    // 8. result
    const summary =
      pr.prUrl === undefined && pr.compareUrl !== undefined
        ? [engineSummary, `No pull request was opened (gh unavailable). Compare: ${pr.compareUrl}`]
            .filter((s) => s !== '')
            .join('\n\n')
        : engineSummary;
    const result: TaskResult = {
      summary,
      ...(pr.prUrl !== undefined ? { prUrl: pr.prUrl } : {}),
      branch: task.branch,
      commit,
      ...withTests,
    };
    if (testError === null) return complete('completed', result);
    return complete('failed', { ...result, summary: summary === '' ? testError : summary, error: testError });
  };

  /** Removes the worktree, then reports the outcome; an aborted run reports nothing. */
  const settle = async (outcome: RunOutcome): Promise<RunOutcome> => {
    if (dir !== null && !keepWorktree) {
      try {
        await removeWorktree(deps.repo, dir);
      } catch (err) {
        log('warn', messageOf(err));
      }
    }
    if (signal.aborted) {
      const result = aborted();
      log('info', `${result.kind} (${signal.reason === 'revoked' ? 'revoked' : 'stopping'})`);
      return result;
    }
    log('info', outcome.kind);
    if (outcome.kind === 'completed' || outcome.kind === 'failed' || outcome.kind === 'quota') {
      try {
        deps.sendReliable(outcome.msg);
      } catch (err) {
        log('error', `sending the outcome failed: ${messageOf(err)}`);
      }
    }
    return outcome;
  };

  let outcome: RunOutcome;
  try {
    outcome = await execute();
  } catch (err) {
    log('error', `unexpected error: ${messageOf(err)}`);
    outcome = fail([messageOf(err)]);
  }
  return settle(outcome);
}
