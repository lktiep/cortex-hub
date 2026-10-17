import type {
  AssignedTask,
  TaskCompleteMsg,
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
  scrubCredentials,
} from './git.js';
import type { GhRun, RunResult } from './git.js';
import type { Logger } from './logger.js';
import { worktreePath } from './paths.js';
import type { WorkerPaths } from './paths.js';
import { lastLines, runShell } from './process.js';
import { createProgressThrottle } from './progress.js';
import { buildPrompt } from './prompt.js';

/**
 * What a run needs from the worker. The runner never sends an outcome: the worker
 * records the returned message as unconfirmed, then sends it.
 */
export interface RunnerDeps {
  repo: string;
  remote: string;
  paths: WorkerPaths;
  adapter: EngineAdapter;
  send: (m: TaskProgressMsg) => void;
  gh: GhRun;
  logger: Logger;
  env: NodeJS.ProcessEnv;
  engineTimeoutMs: number;
  identity: { name: string; email: string };
  now?: () => Date;
  /** Told the engine's process group once it starts (POSIX), and null once the engine is done. */
  onEngineGroup?: (pgid: number | null) => void;
}

export type AbortReason = 'revoked' | 'stopping';

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

function gitTail(r: RunResult): string {
  return scrubCredentials(lastLines((r.stderr.trim() !== '' ? r.stderr : r.stdout).trim(), 20));
}

interface TreeState {
  /** Uncommitted changes, untracked files included. */
  dirty: boolean;
  /** Commits on the branch that origin/<baseBranch> does not have, e.g. an earlier attempt's WIP. */
  ahead: boolean;
}

/** What the engine left behind, read before the test command can add artifacts of its own. */
async function treeState(dir: string, baseBranch: string): Promise<TreeState> {
  const status = await git(['status', '--porcelain'], { cwd: dir });
  if (status.code !== 0) throw new Error(`checking the worktree for changes failed: ${gitTail(status)}`);
  const range = `origin/${baseBranch}..HEAD`;
  const count = await git(['rev-list', '--count', range], { cwd: dir });
  if (count.code !== 0) throw new Error(`checking ${range} for earlier commits failed: ${gitTail(count)}`);
  return { dirty: status.stdout.trim() !== '', ahead: Number(count.stdout.trim()) > 0 };
}

async function headCommit(dir: string): Promise<string> {
  const head = await git(['rev-parse', 'HEAD'], { cwd: dir });
  if (head.code !== 0) throw new Error(`reading the branch head failed: ${gitTail(head)}`);
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
 * Runs one accepted task end to end and returns its outcome. Never throws, and never
 * sends the outcome itself. An abort returns `aborted`, unless it is a stop that lands
 * once the final commit exists: the run then finishes and returns its outcome.
 *
 * The worktree is removed at the end, except when work would be lost with it: a commit
 * or push that failed, an unexpected throw once the engine started, or a worktree kept
 * from an earlier attempt when this run stops before its engine runs. A retry then finds
 * it again (`from: 'existing'`).
 */
export async function runTask(
  task: AssignedTask,
  deps: RunnerDeps,
  signal: AbortSignal,
  opts: { resumed?: boolean } = {},
): Promise<RunOutcome> {
  const { adapter, logger } = deps;
  const now = deps.now ?? ((): Date => new Date());
  /** Set once the worktree is prepared. */
  let dir: string | null = null;
  /** The worktree came from an earlier attempt. */
  let reused = false;
  let engineStarted = false;
  let keepWorktree = false;
  /** The task's final commit exists: a stop no longer hides the outcome, only a revoke does. */
  let committed = false;
  let engineSummary = '';

  const log = (level: 'info' | 'warn' | 'error', m: string): void => logger[level](`task ${task.id}: ${m}`);
  const aborted = (): { kind: 'aborted'; reason: AbortReason } => ({
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
      // the commit lives only on the local branch, which a fresh `worktree add -B` would reset
      keepWorktree = true;
      const problem =
        `the WIP commit ${commit} was not pushed; it is on the local branch ${task.branch} ` +
        `in the worktree kept at ${worktree}\n${messageOf(err)}`;
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
    // Without a route model or an adapter default, the model the engine used is unknown. The hub
    // checks a model-null route only against '*' rows, so send '*' and no narrower model scope.
    const known = task.route.model ?? adapter.defaultModel();
    const model = known ?? '*';
    const lines = [`${adapter.executor} (${known ?? 'default model'}) ran out of quota.`];
    if (wip.pushed) lines.push(`Its work in progress is committed on ${task.branch} as ${wip.commit ?? ''}.`);
    else if (wip.problem === null) lines.push('It left no uncommitted changes.');
    else lines.push(wip.problem);
    const msg: TaskQuotaExhaustedMsg = {
      type: 'task.quota_exhausted',
      taskId: task.id,
      executor: adapter.executor,
      model,
      ...(known !== null && verdict.modelScope !== undefined ? { modelScope: verdict.modelScope } : {}),
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
    await saveWip(worktree, outcome.reason);
    return outcome;
  };

  const runEngine = async (worktree: string, testCommand: string | null): Promise<RunOutput> => {
    const prompt = buildPrompt(task, {
      resumed: opts.resumed,
      testCommand,
      measure: (p) => adapter.promptLength?.(p) ?? p.length,
      noCommands: adapter.refusesCommands?.() === true,
    });
    const throttle = createProgressThrottle((message) =>
      deps.send({ type: 'task.progress', taskId: task.id, message }),
    );
    engineStarted = true;
    let grouped = false;
    try {
      return await adapter.run({
        prompt,
        cwd: worktree,
        model: task.route.model,
        effort: task.route.effort,
        signal,
        timeoutMs: deps.engineTimeoutMs,
        onLine: (line) => {
          const text = adapter.progressText(line);
          if (text !== null) throttle.push(text);
        },
        onGroup: (pgid) => {
          grouped = true;
          deps.onEngineGroup?.(pgid);
        },
      });
    } finally {
      throttle.stop();
      // the engine is done; runCli reaps its group before it returns
      if (grouped) deps.onEngineGroup?.(null);
    }
  };

  const execute = async (): Promise<RunOutcome> => {
    if (signal.aborted) return aborted();

    // 1. worktree
    let worktree: string;
    try {
      worktree = worktreePath(deps.paths, task.id);
      const { from } = await prepareWorktree(deps.repo, worktree, task.branch, task.baseBranch);
      reused = from === 'existing';
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
        const tail = scrubCredentials(lastLines(setup.output.trimEnd(), SETUP_TAIL_LINES));
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
    // a clean exit can still be a run cut short (agy: a permission it could not ask for)
    const early = adapter.stoppedEarly?.(run.stdout, run.stderr) ?? null;
    if (early !== null) {
      log('warn', early);
      engineSummary = engineSummary.trim() === '' ? early : `${engineSummary}\n\n${early}`;
    }
    // read now: whatever the test command writes (coverage/, junit.xml) is not the engine's work
    const changes = await treeState(worktree, task.baseBranch);

    // 5. tests
    let testOutput: string | undefined;
    let testError: string | null = null;
    if (testCommand !== null) {
      const tests = await runShell(testCommand, worktree, shellOpts);
      if (signal.aborted) return abortWithWip(worktree);
      testOutput = scrubCredentials(lastLines(tests.output, TEST_TAIL_LINES));
      if (tests.exitCode !== 0) testError = `tests failed (exit ${tests.exitCode})`;
    }
    const withTests = testOutput !== undefined ? { testOutput } : {};

    const noChanges = (): RunOutcome => {
      if (testError !== null) return fail([testError, early], withTests);
      // a run cut short has not found there was nothing to do, even where that is allowed
      if (early !== null) return fail([`engine made no changes: ${early}`], withTests);
      if (task.context['allowEmpty'] !== true) return fail(['engine made no changes'], withTests);
      return complete('completed', { summary: engineSummary, ...withTests });
    };
    if (!changes.dirty && !changes.ahead) return noChanges();

    // 6. commit; from here on an abort lets git finish, and once the commit exists a stop
    //    reports the outcome as usual (a revoke still reports nothing)
    let commit: string | null = null;
    if (changes.dirty) {
      try {
        commit = await commitAll(worktree, commitTitle(task), deps.identity);
      } catch (err) {
        keepWorktree = true;
        return fail([testError, `could not commit the work; the worktree is kept at ${worktree}\n${messageOf(err)}`], withTests);
      }
    }
    commit ??= changes.ahead ? await headCommit(worktree) : null;
    if (commit === null) return noChanges();
    committed = true;

    // 7. push and pull request
    try {
      await pushBranch(worktree, task.branch);
    } catch (err) {
      // the commit lives only on the local branch, which a fresh `worktree add -B` would reset
      keepWorktree = true;
      const error =
        `the commit ${commit} was not pushed; it is on the local branch ${task.branch} ` +
        `in the worktree kept at ${worktree}\n${messageOf(err)}`;
      return fail([testError, error], withTests);
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

  /**
   * Removes the worktree unless something in it must survive. An aborted run reports
   * nothing, except a stop that came after the final commit: that work is reported
   * rather than left for a resumed run to find.
   */
  const settle = async (outcome: RunOutcome): Promise<RunOutcome> => {
    if (dir !== null) {
      if (keepWorktree || (reused && !engineStarted)) {
        log('info', `worktree kept at ${dir}`);
      } else {
        try {
          await removeWorktree(deps.repo, dir);
        } catch (err) {
          log('warn', messageOf(err));
        }
      }
    }
    const keep = committed && signal.reason !== 'revoked';
    const result = signal.aborted && !keep ? aborted() : outcome;
    log('info', result.kind === 'aborted' ? `aborted (${result.reason})` : result.kind);
    return result;
  };

  let outcome: RunOutcome;
  try {
    outcome = await execute();
  } catch (err) {
    const message = messageOf(err);
    log('error', `unexpected error: ${message}`);
    if (engineStarted && dir !== null) {
      // the engine's work exists only in this worktree
      keepWorktree = true;
      outcome = fail([message, `the worktree is kept at ${dir}`]);
    } else {
      outcome = fail([message]);
    }
  }
  return settle(outcome);
}
