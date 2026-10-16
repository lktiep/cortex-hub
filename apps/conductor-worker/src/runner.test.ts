import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssignedTask, TaskProgressMsg } from '@cortex/shared-types';
import { runCli } from './engines/run.js';
import type { Classification, EngineAdapter, RunInput, RunOutput } from './engines/types.js';
import type { GhRun } from './git.js';
import type { Logger } from './logger.js';
import { workerPaths, worktreePath } from './paths.js';
import type { WorkerPaths } from './paths.js';
import { commitTitle, runTask } from './runner.js';
import type { RunOutcome, RunnerDeps } from './runner.js';
import { FIXTURE_GIT_IDENTITY, createGitFixture, isolateGitConfig } from './test-utils/git-fixture.js';
import type { GitFixture } from './test-utils/git-fixture.js';

type Reliable = Parameters<RunnerDeps['sendReliable']>[0];

const TASK_ID = 'task_0123456789abcdef';
const BRANCH = 'task/k-1';
const PR_URL = 'https://github.com/o/r/pull/7';
const REMOTE = 'https://github.com/o/r.git';
const NOW = new Date('2026-10-17T00:00:00.000Z');
const posixOnly = it.skipIf(process.platform === 'win32');
/** Starts a background sleeper, records its pid in $1, and waits on it. */
const SLEEPER = 'sleep 30 & echo $! > "$1"; wait';

let fx: GitFixture;
let configDir: string;
let restoreConfig: () => void;
let paths: WorkerPaths;

beforeEach(() => {
  configDir = mkdtempSync(path.join(os.tmpdir(), 'cortex-runner-config-'));
  restoreConfig = isolateGitConfig(configDir, FIXTURE_GIT_IDENTITY);
  fx = createGitFixture();
  paths = workerPaths('runner-test', path.join(fx.root, 'home'));
});

afterEach(() => {
  vi.useRealTimers();
  fx.cleanup();
  restoreConfig();
  rmSync(configDir, { recursive: true, force: true });
});

function makeTask(over: Partial<AssignedTask> = {}): AssignedTask {
  return {
    id: TASK_ID,
    key: 'K-1',
    title: 'Add a file\nwith more detail below',
    description: 'Write engine.txt.',
    context: {},
    files: [],
    branch: BRANCH,
    baseBranch: 'main',
    route: { executor: 'claude', model: null, effort: null },
    attempt: 3,
    leaseExpiresAt: '2026-10-17T01:00:00.000Z',
    reviews: [],
    handoff: null,
    testCommand: null,
    ...over,
  };
}

function writeChange(cwd: string, name = 'engine.txt'): void {
  writeFileSync(path.join(cwd, name), 'work\n');
}

interface FakeEngine {
  adapter: EngineAdapter;
  inputs: RunInput[];
  classified: Array<{ model: string | null; now?: Date }>;
}

function fakeEngine(
  o: {
    run?: (input: RunInput) => Partial<RunOutput> | Promise<Partial<RunOutput>>;
    classify?: Classification;
    summary?: string;
    defaultModel?: string | null;
  } = {},
): FakeEngine {
  const inputs: RunInput[] = [];
  const classified: FakeEngine['classified'] = [];
  const defaultRun = (input: RunInput): Partial<RunOutput> => {
    writeChange(input.cwd);
    return { exitCode: 0, stdout: 'done\n' };
  };
  const adapter: EngineAdapter = {
    executor: 'claude',
    detect: () => Promise.resolve({ found: true }),
    models: () => Promise.resolve(['*']),
    defaultModel: () => (o.defaultModel === undefined ? 'fake-default' : o.defaultModel),
    buildArgs: () => ({ args: [] }),
    async run(input) {
      inputs.push(input);
      const r = await (o.run ?? defaultRun)(input);
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false, aborted: false, ...r };
    },
    classify(_exitCode, _stdout, _stderr, ctx) {
      classified.push({ model: ctx?.model ?? null, now: ctx?.now });
      return o.classify ?? { kind: 'ok' };
    },
    progressText: (line) => (line.startsWith('#') ? null : `p:${line}`),
    summary: () => o.summary ?? 'Wrote engine.txt.',
  };
  return { adapter, inputs, classified };
}

interface GhCall {
  args: string[];
  input?: string;
}

function fakeGh(o: { authed?: boolean; onCall?: (args: string[]) => void } = {}): { gh: GhRun; calls: GhCall[] } {
  const calls: GhCall[] = [];
  const gh: GhRun = (args, opts) => {
    calls.push({ args, input: opts.input });
    o.onCall?.(args);
    if (args[0] === 'auth') {
      return Promise.resolve(
        o.authed === false ? { code: 1, stdout: '', stderr: 'not logged in' } : { code: 0, stdout: '', stderr: '' },
      );
    }
    if (args[0] === 'pr' && args[1] === 'create') {
      return Promise.resolve({ code: 0, stdout: `Creating pull request\n${PR_URL}\n`, stderr: '' });
    }
    return Promise.resolve({ code: 1, stdout: '', stderr: 'unexpected gh call' });
  };
  return { gh, calls };
}

interface Harness {
  deps: RunnerDeps;
  progress: TaskProgressMsg[];
  reliable: Reliable[];
  logs: string[];
  ghCalls: GhCall[];
}

function harness(
  adapter: EngineAdapter,
  o: { env?: NodeJS.ProcessEnv; gh?: { gh: GhRun; calls: GhCall[] }; engineTimeoutMs?: number } = {},
): Harness {
  const progress: TaskProgressMsg[] = [];
  const reliable: Reliable[] = [];
  const logs: string[] = [];
  const { gh, calls } = o.gh ?? fakeGh();
  const logger: Logger = {
    info: (m) => logs.push(`INFO ${m}`),
    warn: (m) => logs.push(`WARN ${m}`),
    error: (m) => logs.push(`ERROR ${m}`),
    addSecret: () => undefined,
  };
  const deps: RunnerDeps = {
    repo: fx.repo,
    remote: REMOTE,
    paths,
    adapter,
    send: (m) => progress.push(m),
    sendReliable: (m) => reliable.push(m),
    gh,
    logger,
    env: { PATH: process.env.PATH, ...o.env },
    engineTimeoutMs: o.engineTimeoutMs ?? 60_000,
    identity: { name: 'Cortex Worker', email: 'cortex-worker@localhost' },
    now: () => NOW,
  };
  return { deps, progress, reliable, logs, ghCalls: calls };
}

const run = (task: AssignedTask, h: Harness, signal = new AbortController().signal, opts?: { resumed?: boolean }) =>
  runTask(task, h.deps, signal, opts);

function msgOf(out: RunOutcome) {
  if (out.kind !== 'completed' && out.kind !== 'failed') throw new Error(`expected a task.complete, got ${out.kind}`);
  return out.msg;
}

function quotaOf(out: RunOutcome) {
  if (out.kind !== 'quota') throw new Error(`expected quota, got ${out.kind}`);
  return out.msg;
}

const dirOf = (id = TASK_ID): string => worktreePath(paths, id);
const remoteSubject = (branch = BRANCH): string => fx.run(fx.origin, ['log', '-1', '--format=%s', branch]);
const remoteSha = (branch = BRANCH): string => fx.run(fx.origin, ['rev-parse', branch]);
function remoteHas(branch: string): boolean {
  try {
    fx.run(fx.origin, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}
const real = (p: string): string => realpathSync.native(p);

function failingHook(name: 'pre-commit' | 'pre-push', text: string): void {
  const hook = path.join(fx.repo, '.git', 'hooks', name);
  writeFileSync(hook, `#!/bin/sh\necho "${text}" >&2\nexit 1\n`);
  chmodSync(hook, 0o755);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function expectGone(pidFile: string): Promise<void> {
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  expect(pid).toBeGreaterThan(0);
  await waitFor(() => !alive(pid), 3000);
}

describe('commitTitle', () => {
  it('uses the key, else the first 8 chars of the id, and the first line of the title', () => {
    expect(commitTitle(makeTask())).toBe('K-1: Add a file');
    expect(commitTitle(makeTask({ key: null }))).toBe('task_012: Add a file');
  });
});

describe('runTask', () => {
  it("completes: commits '<key>: <title>', pushes, returns prUrl and test tail", async () => {
    const engine = fakeEngine();
    const h = harness(engine.adapter);
    const task = makeTask({ testCommand: 'echo all green', route: { executor: 'claude', model: 'm-1', effort: 'high' } });
    const out = await run(task, h);

    expect(remoteSubject()).toBe('K-1: Add a file');
    expect(out).toEqual({
      kind: 'completed',
      msg: {
        type: 'task.complete',
        taskId: TASK_ID,
        status: 'completed',
        attempt: 3,
        result: { summary: 'Wrote engine.txt.', prUrl: PR_URL, branch: BRANCH, commit: remoteSha(), testOutput: 'all green' },
      },
    });
    expect(h.reliable).toEqual([msgOf(out)]);

    const input = engine.inputs[0];
    expect(input?.cwd).toBe(dirOf());
    expect(input?.model).toBe('m-1');
    expect(input?.effort).toBe('high');
    expect(input?.timeoutMs).toBe(60_000);
    expect(input?.prompt).toContain('Add a file');
    expect(input?.prompt).toContain('`echo all green`');
    expect(engine.classified).toEqual([{ model: 'm-1', now: NOW }]);

    const create = h.ghCalls.find((c) => c.args[0] === 'pr' && c.args[1] === 'create');
    expect(create?.args).toEqual(
      expect.arrayContaining(['--base', 'main', '--head', BRANCH, '--title', 'K-1: Add a file']),
    );
    expect(create?.input).toContain('Wrote engine.txt.');
    expect(create?.input).toContain(TASK_ID);
    expect(create?.input).toContain('```\nall green\n```');
  });

  it("fails with 'engine made no changes' on a clean tree", async () => {
    const engine = fakeEngine({ run: () => ({ exitCode: 0, stdout: 'nothing to do' }) });
    const h = harness(engine.adapter);
    // only `true` allows an empty result
    const out = await run(makeTask({ context: { allowEmpty: 'yes' } }), h);

    const msg = msgOf(out);
    expect(out.kind).toBe('failed');
    expect(msg).toMatchObject({ type: 'task.complete', taskId: TASK_ID, status: 'failed', attempt: 3 });
    expect(msg.result.error).toBe('engine made no changes');
    expect(msg.result.branch).toBeUndefined();
    expect(msg.result.commit).toBeUndefined();
    expect(remoteHas(BRANCH)).toBe(false);
    expect(h.reliable).toEqual([msg]);
  });

  it('completes on a clean tree when context.allowEmpty is true', async () => {
    const engine = fakeEngine({ run: () => ({ exitCode: 0, stdout: 'checked, nothing to change' }) });
    const h = harness(engine.adapter);
    const out = await run(makeTask({ context: { allowEmpty: true } }), h);

    expect(out).toEqual({
      kind: 'completed',
      msg: { type: 'task.complete', taskId: TASK_ID, status: 'completed', attempt: 3, result: { summary: 'Wrote engine.txt.' } },
    });
    expect(remoteHas(BRANCH)).toBe(false);
    expect(h.ghCalls).toEqual([]);
  });

  posixOnly('fails when tests exit non-zero but still pushes and reports branch, commit and testOutput', async () => {
    const h = harness(fakeEngine().adapter);
    const out = await run(makeTask({ testCommand: 'echo red; exit 3' }), h);

    const msg = msgOf(out);
    expect(out.kind).toBe('failed');
    expect(remoteSubject()).toBe('K-1: Add a file');
    expect(msg.result).toEqual({
      summary: 'Wrote engine.txt.',
      error: 'tests failed (exit 3)',
      prUrl: PR_URL,
      branch: BRANCH,
      commit: remoteSha(),
      testOutput: 'red',
    });
  });

  posixOnly('keeps only the last 200 test lines', async () => {
    const engine = fakeEngine();
    const cmd = 'i=1; while [ $i -le 250 ]; do echo line $i; i=$((i+1)); done';
    const h = harness(engine.adapter, { env: { CORTEX_TEST_CMD: cmd } });
    const out = await run(makeTask(), h);

    const lines = msgOf(out).result.testOutput?.split('\n') ?? [];
    expect(out.kind).toBe('completed');
    expect(lines).toHaveLength(200);
    expect(lines[0]).toBe('line 51');
    expect(lines[199]).toBe('line 250');
    // the engine is told about the command the worker will run
    expect(engine.inputs[0]?.prompt).toContain(cmd);
  });

  it("quota: pushes 'WIP <key>: quota handoff' and returns the handoff with commit sha", async () => {
    const engine = fakeEngine({
      classify: { kind: 'quota', resetAt: '2026-10-17T05:00:00.000Z', modelScope: 'opus-*', raw: 'usage limit reached' },
    });
    const h = harness(engine.adapter);
    const out = await run(makeTask(), h);

    expect(remoteSubject()).toBe('WIP K-1: quota handoff');
    expect(out).toEqual({
      kind: 'quota',
      msg: {
        type: 'task.quota_exhausted',
        taskId: TASK_ID,
        executor: 'claude',
        model: 'fake-default',
        modelScope: 'opus-*',
        resetAt: '2026-10-17T05:00:00.000Z',
        raw: 'usage limit reached',
        handoff: { branch: BRANCH, commit: remoteSha(), note: expect.any(String) as string },
        attempt: 3,
      },
    });
    expect(quotaOf(out).handoff.note).toContain(remoteSha());
    expect(h.reliable).toEqual([quotaOf(out)]);
  });

  it('quota on a clean tree returns handoff.commit null', async () => {
    const engine = fakeEngine({
      run: () => ({ exitCode: 1 }),
      classify: { kind: 'quota', raw: '429' },
      defaultModel: null,
    });
    const h = harness(engine.adapter);
    const out = await run(makeTask(), h);

    const msg = quotaOf(out);
    expect(msg.handoff).toEqual({ branch: BRANCH, commit: null, note: expect.any(String) as string });
    // no route model and no adapter default
    expect(msg.model).toBe('default');
    expect(msg.attempt).toBe(3);
    expect(remoteHas(BRANCH)).toBe(false);
  });

  it('engine error returns failed with the classifier message', async () => {
    const engine = fakeEngine({
      run: (input) => {
        writeChange(input.cwd);
        return { exitCode: 2, stderr: 'boom' };
      },
      classify: { kind: 'error', message: 'engine exploded' },
    });
    const h = harness(engine.adapter);
    const out = await run(makeTask(), h);

    const msg = msgOf(out);
    expect(out.kind).toBe('failed');
    expect(msg.result.error).toBe('engine exploded');
    // partial work is not lost
    expect(remoteSubject()).toBe('WIP K-1: engine error');
    expect(msg.result).toMatchObject({ branch: BRANCH, commit: remoteSha() });
    expect(h.reliable).toEqual([msg]);
  });

  posixOnly('engine timeout returns failed and kills the engine', async () => {
    const pidFile = path.join(fx.root, 'engine.pid');
    const engine = fakeEngine({
      run: (input) => {
        writeChange(input.cwd);
        return runCli('sh', { args: ['-c', SLEEPER, 'sh', pidFile] }, input, {
          platform: process.platform,
          env: process.env,
        });
      },
      // a timed-out run fails whatever the classifier says
      classify: { kind: 'ok' },
    });
    const h = harness(engine.adapter, { engineTimeoutMs: 1200 });
    const out = await run(makeTask(), h);

    const msg = msgOf(out);
    expect(out.kind).toBe('failed');
    expect(msg.result.error).toBe('engine timed out after 0.02 min');
    expect(remoteSubject()).toBe('WIP K-1: engine timeout');
    expect(msg.result).toMatchObject({ branch: BRANCH, commit: remoteSha() });
    await expectGone(pidFile);
  });

  posixOnly('revoke aborts: engine killed, WIP pushed, no completion message', async () => {
    const ac = new AbortController();
    const pidFile = path.join(fx.root, 'engine.pid');
    const engine = fakeEngine({
      run: (input) => {
        writeChange(input.cwd);
        const p = runCli('sh', { args: ['-c', SLEEPER, 'sh', pidFile] }, input, {
          platform: process.platform,
          env: process.env,
        });
        void waitFor(() => existsSync(pidFile)).then(() => ac.abort('revoked'));
        return p;
      },
    });
    const h = harness(engine.adapter);
    const out = await run(makeTask(), h, ac.signal);

    expect(out).toEqual({ kind: 'aborted', reason: 'revoked' });
    expect(h.reliable).toEqual([]);
    expect(remoteSubject()).toBe('WIP K-1: revoked');
    expect(existsSync(dirOf())).toBe(false);
    await expectGone(pidFile);
  });

  posixOnly('an abort before the engine starts makes no WIP commit', async () => {
    const ac = new AbortController();
    const engine = fakeEngine();
    const h = harness(engine.adapter);
    setTimeout(() => ac.abort('stopping'), 300);
    const out = await run(makeTask({ context: { setupCommand: 'sleep 30' } }), h, ac.signal);

    expect(out).toEqual({ kind: 'aborted', reason: 'stopping' });
    expect(engine.inputs).toEqual([]);
    expect(remoteHas(BRANCH)).toBe(false);
    expect(existsSync(dirOf())).toBe(false);
    expect(h.reliable).toEqual([]);
  });

  it('an abort during commit, push and PR lets git finish, then returns aborted', async () => {
    const ac = new AbortController();
    const gh = fakeGh({ onCall: () => ac.abort('stopping') });
    const h = harness(fakeEngine().adapter, { gh });
    const out = await run(makeTask(), h, ac.signal);

    expect(out).toEqual({ kind: 'aborted', reason: 'stopping' });
    expect(remoteSubject()).toBe('K-1: Add a file');
    expect(h.reliable).toEqual([]);
    expect(existsSync(dirOf())).toBe(false);
  });

  it('declines with branch-in-use when the branch is checked out elsewhere', async () => {
    const engine = fakeEngine();
    const h = harness(engine.adapter);
    const out = await run(makeTask({ branch: 'main' }), h);

    expect(out.kind).toBe('declined');
    const reason = out.kind === 'declined' ? out.reason : '';
    expect(reason.startsWith('branch-in-use: ')).toBe(true);
    expect(real(reason.slice('branch-in-use: '.length))).toBe(real(fx.repo));
    expect(engine.inputs).toEqual([]);
    expect(h.reliable).toEqual([]);
  });

  it('fails with worktree: <message> when the worktree cannot be prepared', async () => {
    const engine = fakeEngine();
    const h = harness(engine.adapter);
    const missingBase = await run(makeTask({ baseBranch: 'nope' }), h);
    expect(msgOf(missingBase).result.error).toBe('worktree: base branch nope not found on origin');
    expect(existsSync(dirOf())).toBe(false);

    const unsafe = await run(makeTask({ id: '../x' }), h);
    expect(msgOf(unsafe)).toMatchObject({ taskId: '../x', status: 'failed', attempt: 3 });
    expect(msgOf(unsafe).result.error).toBe('worktree: unsafe task id: ../x');
    expect(engine.inputs).toEqual([]);
    expect(h.reliable).toHaveLength(2);
  });

  posixOnly('runs the setup command before the engine and fails the task when it fails', async () => {
    const marker = path.join(fx.root, 'setup-ran');
    let sawMarker = false;
    const ok = fakeEngine({
      run: (input) => {
        sawMarker = existsSync(marker);
        writeChange(input.cwd);
        return { exitCode: 0 };
      },
    });
    const okRun = await run(
      makeTask({ context: { setupCommand: 'echo ready > "$MARKER"' } }),
      harness(ok.adapter, { env: { MARKER: marker } }),
    );
    expect(okRun.kind).toBe('completed');
    expect(sawMarker).toBe(true);

    const bad = fakeEngine();
    const setup = 'i=1; while [ $i -le 45 ]; do echo out $i; i=$((i+1)); done; exit 7';
    const h = harness(bad.adapter, { env: { CORTEX_SETUP_CMD: setup } });
    // an empty context.setupCommand falls back to CORTEX_SETUP_CMD
    const out = await run(makeTask({ id: 'task_setup', branch: 'task/setup', context: { setupCommand: '' } }), h);

    const msg = msgOf(out);
    expect(out.kind).toBe('failed');
    const lines = msg.result.error?.split('\n') ?? [];
    expect(lines[0]).toBe('setup command failed (exit 7)');
    expect(lines.slice(1)).toEqual(Array.from({ length: 40 }, (_, i) => `out ${i + 6}`));
    expect(bad.inputs).toEqual([]);
    expect(existsSync(dirOf('task_setup'))).toBe(false);
    expect(remoteHas('task/setup')).toBe(false);
  });

  it('removes the worktree after every outcome, but keeps the branch', async () => {
    const cases: Array<{ id: string; engine: FakeEngine; kind: RunOutcome['kind'] }> = [
      { id: 'task_done', engine: fakeEngine(), kind: 'completed' },
      { id: 'task_error', engine: fakeEngine({ classify: { kind: 'error', message: 'x' } }), kind: 'failed' },
      { id: 'task_quota', engine: fakeEngine({ classify: { kind: 'quota', raw: 'q' } }), kind: 'quota' },
      {
        id: 'task_empty',
        engine: fakeEngine({ run: () => ({ exitCode: 0 }) }),
        kind: 'failed',
      },
    ];
    for (const c of cases) {
      const branch = `task/${c.id}`;
      const out = await run(makeTask({ id: c.id, branch }), harness(c.engine.adapter));
      expect(out.kind).toBe(c.kind);
      expect(existsSync(dirOf(c.id))).toBe(false);
      expect(fx.run(fx.repo, ['worktree', 'list', '--porcelain'])).not.toContain(c.id);
      expect(fx.run(fx.repo, ['branch', '--list', branch])).toContain(branch);
    }
  });

  it('progress is throttled', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const engine = fakeEngine({
      run: (input) => {
        writeChange(input.cwd);
        input.onLine('# not progress');
        for (let i = 0; i < 50; i++) {
          input.onLine(`line ${i}`);
          vi.advanceTimersByTime(20);
        }
        return { exitCode: 0, stdout: 'done' };
      },
    });
    const h = harness(engine.adapter);
    const out = await run(makeTask(), h);
    vi.advanceTimersByTime(10_000);

    expect(out.kind).toBe('completed');
    expect(h.progress).toEqual([{ type: 'task.progress', taskId: TASK_ID, message: 'p:line 0' }]);
  });

  it('counts commits already on the branch as changes', async () => {
    const other = path.join(fx.scratch, 'other');
    fx.run(fx.scratch, ['clone', fx.origin, other]);
    fx.run(other, ['checkout', '-b', BRANCH]);
    writeFileSync(path.join(other, 'wip.txt'), 'earlier run');
    fx.run(other, ['add', 'wip.txt']);
    fx.run(other, ['commit', '-m', 'WIP K-1: quota handoff']);
    fx.run(other, ['push', 'origin', BRANCH]);
    const prior = fx.run(other, ['rev-parse', 'HEAD']);

    const engine = fakeEngine({ run: () => ({ exitCode: 0, stdout: 'already done' }) });
    const h = harness(engine.adapter);
    const task = makeTask({ handoff: { branch: BRANCH, commit: prior, note: 'ran out of quota' } });
    const out = await run(task, h, undefined, { resumed: true });

    expect(out.kind).toBe('completed');
    expect(msgOf(out).result).toMatchObject({ branch: BRANCH, commit: prior, prUrl: PR_URL });
    expect(remoteSha()).toBe(prior);
    expect(engine.inputs[0]?.prompt).toContain('## Resuming');
  });

  it('appends the compare URL to the summary when no pull request was opened', async () => {
    const h = harness(fakeEngine().adapter, { gh: fakeGh({ authed: false }) });
    const out = await run(makeTask(), h);

    const result = msgOf(out).result;
    expect(out.kind).toBe('completed');
    expect(result.prUrl).toBeUndefined();
    expect(result.summary).toBe(
      'Wrote engine.txt.\n\nNo pull request was opened (gh unavailable). ' +
        'Compare: https://github.com/o/r/compare/main...task/k-1?expand=1',
    );
  });

  it('fails with the error of an unexpected throw and removes the worktree', async () => {
    const engine = fakeEngine({
      run: () => {
        throw new Error('adapter crashed');
      },
    });
    const h = harness(engine.adapter);
    const out = await run(makeTask(), h);

    expect(msgOf(out)).toMatchObject({ status: 'failed', attempt: 3, result: { error: 'adapter crashed' } });
    expect(existsSync(dirOf())).toBe(false);
  });

  posixOnly('a rejected commit keeps the worktree and names it in the error', async () => {
    failingHook('pre-commit', 'lint exploded');
    const h = harness(fakeEngine().adapter);
    const out = await run(makeTask(), h);

    const error = msgOf(out).result.error ?? '';
    expect(out.kind).toBe('failed');
    expect(error).toContain('lint exploded');
    expect(error).toContain(dirOf());
    expect(existsSync(path.join(dirOf(), 'engine.txt'))).toBe(true);
    expect(remoteHas(BRANCH)).toBe(false);
  });

  posixOnly('a rejected WIP commit keeps the worktree and names it in the handoff note', async () => {
    failingHook('pre-commit', 'lint exploded');
    const h = harness(fakeEngine({ classify: { kind: 'quota', raw: 'q' } }).adapter);
    const out = await run(makeTask(), h);

    const msg = quotaOf(out);
    expect(msg.handoff.commit).toBeNull();
    expect(msg.handoff.note).toContain(dirOf());
    expect(existsSync(path.join(dirOf(), 'engine.txt'))).toBe(true);
  });

  posixOnly('a failed WIP push is logged and leaves no commit in the result or handoff', async () => {
    failingHook('pre-push', 'push refused');
    const failed = await run(
      makeTask(),
      harness(fakeEngine({ classify: { kind: 'error', message: 'engine exploded' } }).adapter),
    );
    const result = msgOf(failed).result;
    expect(result.error).toMatch(/^engine exploded\n.*push/s);
    expect(result.commit).toBeUndefined();
    expect(result.branch).toBeUndefined();

    const h = harness(fakeEngine({ classify: { kind: 'quota', raw: 'q' } }).adapter);
    const quota = await run(makeTask({ id: 'task_quota', branch: 'task/quota' }), h);
    const msg = quotaOf(quota);
    expect(msg.handoff.commit).toBeNull();
    expect(msg.handoff.note).toMatch(/push/);
    expect(h.logs.some((l) => l.startsWith('ERROR') && l.includes('push'))).toBe(true);
    expect(remoteHas('task/quota')).toBe(false);
  });
});
