import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONDUCTOR_PROTOCOL_VERSION } from '@cortex/shared-types';
import type {
  AssignedTask,
  EngineInfo,
  Executor,
  RegisteredMsg,
  TaskAssignedMsg,
  TaskCompleteMsg,
  TaskQuotaExhaustedMsg,
  TaskRevokedMsg,
  WorkerToHubMsg,
} from '@cortex/shared-types';
import type { EngineAdapter } from './engines/types.js';
import { sanitizeRemoteUrl } from './git.js';
import type { Logger } from './logger.js';
import { workerPaths } from './paths.js';
import type { WorkerPaths } from './paths.js';
import type { RunOutcome, RunnerDeps } from './runner.js';
import { readState, writeState } from './state.js';
import type { WorkerState } from './state.js';
import { FIXTURE_GIT_IDENTITY, createGitFixture, isolateGitConfig } from './test-utils/git-fixture.js';
import type { GitFixture } from './test-utils/git-fixture.js';
import { WORKER_VERSION } from './version.js';
import { Worker } from './worker.js';
import type { WorkerDeps } from './worker.js';

const HOST = 'host-1';
const REMOTE = 'https://bot:pw@github.com/o/r.git';
const TASK_A = 'task_aaaaaaaaaaaaaaaa';
const TASK_B = 'task_bbbbbbbbbbbbbbbb';
const BRANCH = 'task/k-1';
const IDLE: WorkerToHubMsg = { type: 'status.update', state: 'idle' };
const BUSY: WorkerToHubMsg = { type: 'status.update', state: 'busy' };

let fx: GitFixture;
let configDir: string;
let restoreConfig: () => void;
let paths: WorkerPaths;

beforeEach(() => {
  configDir = mkdtempSync(path.join(os.tmpdir(), 'cortex-worker-config-'));
  restoreConfig = isolateGitConfig(configDir, FIXTURE_GIT_IDENTITY);
  fx = createGitFixture();
  paths = workerPaths('worker-test', path.join(fx.root, 'home'));
});

afterEach(() => {
  fx.cleanup();
  restoreConfig();
  rmSync(configDir, { recursive: true, force: true });
});

function makeTask(over: Partial<AssignedTask> = {}): AssignedTask {
  return {
    id: TASK_A,
    key: 'K-1',
    title: 'Add a file',
    description: 'Write engine.txt.',
    context: {},
    files: [],
    branch: BRANCH,
    baseBranch: 'main',
    route: { executor: null, model: null, effort: null },
    attempt: 3,
    leaseExpiresAt: '2026-10-17T01:00:00.000Z',
    reviews: [],
    handoff: null,
    testCommand: null,
    ...over,
  };
}

function assigned(task: AssignedTask, type: TaskAssignedMsg['type'] = 'task.assigned'): TaskAssignedMsg {
  return { type, task, taskId: task.id, title: task.title, description: task.description };
}

function revoked(taskId: string): TaskRevokedMsg {
  return { type: 'task.revoked', taskId, reason: 'reclaimed' };
}

function done(task: AssignedTask, status: 'completed' | 'failed' = 'completed'): TaskCompleteMsg {
  return { type: 'task.complete', taskId: task.id, status, result: { summary: 'Wrote engine.txt.' }, attempt: task.attempt };
}

function quota(task: AssignedTask): TaskQuotaExhaustedMsg {
  return {
    type: 'task.quota_exhausted',
    taskId: task.id,
    executor: 'claude',
    model: 'fake-default',
    raw: 'usage limit',
    handoff: { branch: task.branch, commit: null, note: 'ran out of quota' },
    attempt: task.attempt,
  };
}

function fakeAdapter(executor: Executor): EngineAdapter {
  return {
    executor,
    detect: () => Promise.resolve({ found: true }),
    models: () => Promise.resolve(['*']),
    defaultModel: () => null,
    buildArgs: () => ({ args: [] }),
    run: () => Promise.reject(new Error('the fake run never starts an engine')),
    classify: () => ({ kind: 'ok' }),
    progressText: () => null,
    summary: () => '',
  };
}

interface RunCall {
  task: AssignedTask;
  deps: RunnerDeps;
  signal: AbortSignal;
  opts: { resumed?: boolean } | undefined;
  finish: (o: RunOutcome) => void;
}

interface Sent {
  via: 'send' | 'reliable';
  msg: WorkerToHubMsg;
}

interface Harness {
  deps: WorkerDeps;
  sent: Sent[];
  logs: string[];
  calls: RunCall[];
  claude: EngineAdapter;
  registered: { value: boolean };
  /** Called inside `sendReliable`, before the message is recorded. */
  onReliable: { fn: ((m: WorkerToHubMsg) => void) | null };
}

/**
 * A run that waits for `finish`. An abort ends it with the signal's reason, as the runner
 * does, unless `abortEnds` is false: the run then unwinds only when `finish` is called.
 */
function harness(over: Partial<WorkerDeps> = {}, o: { abortEnds?: boolean } = {}): Harness {
  const sent: Sent[] = [];
  const logs: string[] = [];
  const calls: RunCall[] = [];
  const registered = { value: true };
  const onReliable: Harness['onReliable'] = { fn: null };
  const claude = fakeAdapter('claude');
  const engines: EngineInfo[] = [{ executor: 'claude', models: ['*'], defaultModel: null }];
  const logger: Logger = {
    info: (m) => logs.push(`INFO ${m}`),
    warn: (m) => logs.push(`WARN ${m}`),
    error: (m) => logs.push(`ERROR ${m}`),
    addSecret: () => undefined,
  };
  const deps: WorkerDeps = {
    agentId: 'worker-test',
    hostname: HOST,
    repo: fx.repo,
    remote: REMOTE,
    capabilities: ['typescript'],
    adapters: [claude],
    engines,
    defaultExecutor: 'claude',
    paths,
    logger,
    send: (m) => {
      sent.push({ via: 'send', msg: m });
      return true;
    },
    sendReliable: (m) => {
      onReliable.fn?.(m);
      sent.push({ via: 'reliable', msg: m });
    },
    gh: () => Promise.resolve({ code: 1, stdout: '', stderr: 'unexpected gh call' }),
    env: { PATH: process.env.PATH },
    engineTimeoutMs: 60_000,
    identity: { name: 'Cortex Worker', email: 'cortex-worker@localhost' },
    isRegistered: () => registered.value,
    run: (task, runDeps, signal, opts) =>
      new Promise<RunOutcome>((resolve) => {
        calls.push({ task, deps: runDeps, signal, opts, finish: resolve });
        if (o.abortEnds === false) return;
        signal.addEventListener(
          'abort',
          () => resolve({ kind: 'aborted', reason: signal.reason === 'revoked' ? 'revoked' : 'stopping' }),
          { once: true },
        );
      }),
    ...over,
  };
  return { deps, sent, logs, calls, claude, registered, onReliable };
}

const types = (h: Harness): string[] =>
  h.sent.map((s) => (s.msg.type === 'status.update' ? `status.update:${s.msg.state}` : s.msg.type));
const state = (): WorkerState => readState(paths.stateFile);
const accept = (taskId = TASK_A): Sent => ({ via: 'reliable', msg: { type: 'task.accept', taskId } });

async function started(h: Harness, n = 1): Promise<RunCall> {
  await vi.waitFor(() => expect(h.calls).toHaveLength(n), { timeout: 5_000 });
  const call = h.calls[n - 1];
  if (call === undefined) throw new Error('no run call');
  return call;
}

describe('registerPayload', () => {
  it('register payload carries protocol, version, sanitised repo, engines and activeTaskId', async () => {
    const h = harness();
    const w = new Worker(h.deps);
    const base = {
      type: 'worker.register',
      protocol: CONDUCTOR_PROTOCOL_VERSION,
      version: WORKER_VERSION,
      hostname: HOST,
      os: process.platform,
      repo: sanitizeRemoteUrl(REMOTE),
      capabilities: ['typescript'],
      engines: h.deps.engines,
      defaultExecutor: 'claude',
    };
    expect(w.registerPayload()).toEqual(base);
    expect(w.registerPayload().repo).not.toContain('pw');

    w.handle(assigned(makeTask()));
    await started(h);
    expect(w.registerPayload()).toEqual({ ...base, activeTaskId: TASK_A });
  });

  it('reports the unconfirmed task, else the persisted active task', () => {
    const h = harness();
    writeState(paths.stateFile, { activeTaskId: TASK_B, unconfirmed: null, lastRegistered: null, engineGroup: null });
    expect(new Worker(h.deps).registerPayload().activeTaskId).toBe(TASK_B);

    const msg = done(makeTask());
    writeState(paths.stateFile, { activeTaskId: null, unconfirmed: { taskId: TASK_A, msg }, lastRegistered: null, engineGroup: null });
    expect(new Worker(h.deps).registerPayload().activeTaskId).toBe(TASK_A);
  });
});

describe('task.assigned', () => {
  it('sends accept, busy, then complete and idle in order', async () => {
    const h = harness();
    const w = new Worker(h.deps);
    const task = makeTask();
    w.handle(assigned(task));
    const call = await started(h);

    expect(w.busy).toBe(true);
    expect(state().activeTaskId).toBe(TASK_A);
    expect(call.task).toBe(task);
    expect(call.opts).toEqual({ resumed: false });
    expect(call.deps.adapter).toBe(h.claude);
    expect(call.deps).toMatchObject({
      repo: fx.repo,
      remote: REMOTE,
      paths,
      engineTimeoutMs: 60_000,
      identity: { name: 'Cortex Worker', email: 'cortex-worker@localhost' },
    });
    // progress goes out best effort through deps.send
    call.deps.send({ type: 'task.progress', taskId: TASK_A, message: 'working' });

    call.finish({ kind: 'completed', msg: done(task) });
    await w.idle();
    expect(h.sent).toEqual([
      accept(),
      { via: 'send', msg: BUSY },
      { via: 'send', msg: { type: 'task.progress', taskId: TASK_A, message: 'working' } },
      { via: 'reliable', msg: done(task) },
      { via: 'send', msg: IDLE },
    ]);
    expect(w.busy).toBe(false);
    expect(state()).toEqual({ activeTaskId: null, unconfirmed: { taskId: TASK_A, msg: done(task) }, lastRegistered: null, engineGroup: null });
  });

  it.each([
    ['completed', (t: AssignedTask): RunOutcome => ({ kind: 'completed', msg: done(t) })],
    ['failed', (t: AssignedTask): RunOutcome => ({ kind: 'failed', msg: done(t, 'failed') })],
    ['quota', (t: AssignedTask): RunOutcome => ({ kind: 'quota', msg: quota(t) })],
  ])('persists a %s outcome as unconfirmed before sending it', async (_kind, outcomeOf) => {
    const h = harness();
    const seen: WorkerState[] = [];
    h.onReliable.fn = (m) => {
      if (m.type === 'task.complete' || m.type === 'task.quota_exhausted') seen.push(state());
    };
    const w = new Worker(h.deps);
    const task = makeTask();
    w.handle(assigned(task));
    const outcome = outcomeOf(task);
    (await started(h)).finish(outcome);
    await w.idle();

    if (outcome.kind !== 'completed' && outcome.kind !== 'failed' && outcome.kind !== 'quota') throw new Error('unreachable');
    expect(seen).toEqual([{ activeTaskId: null, unconfirmed: { taskId: TASK_A, msg: outcome.msg }, lastRegistered: null, engineGroup: null }]);
    expect(h.sent.slice(-2)).toEqual([
      { via: 'reliable', msg: outcome.msg },
      { via: 'send', msg: IDLE },
    ]);
  });

  it('declines a second task as busy while one runs', async () => {
    const h = harness();
    const w = new Worker(h.deps);
    w.handle(assigned(makeTask()));
    await started(h);

    w.handle(assigned(makeTask({ id: TASK_B, attempt: 7 })));
    w.handle(assigned(makeTask({ id: TASK_B, attempt: 7 }), 'task.resumed'));
    await Promise.resolve();
    expect(h.sent).toEqual([
      accept(),
      { via: 'send', msg: BUSY },
      { via: 'reliable', msg: { type: 'task.decline', taskId: TASK_B, reason: 'busy', attempt: 7 } },
      { via: 'reliable', msg: { type: 'task.decline', taskId: TASK_B, reason: 'busy', attempt: 7 } },
    ]);
    expect(h.calls).toHaveLength(1);
    expect(state().activeTaskId).toBe(TASK_A);
  });

  it('declines a second task as busy while the first is still being checked', async () => {
    const h = harness();
    const w = new Worker(h.deps);
    w.handle(assigned(makeTask()));
    w.handle(assigned(makeTask({ id: TASK_B, attempt: 2 })));
    await started(h);
    expect(h.sent).toEqual([
      { via: 'reliable', msg: { type: 'task.decline', taskId: TASK_B, reason: 'busy', attempt: 2 } },
      accept(),
      { via: 'send', msg: BUSY },
    ]);
    expect(h.calls).toHaveLength(1);
  });

  it('ignores a duplicate task.assigned for the running task', async () => {
    const h = harness();
    const w = new Worker(h.deps);
    w.handle(assigned(makeTask()));
    await started(h);
    w.handle(assigned(makeTask()));
    await Promise.resolve();
    expect(h.sent).toEqual([accept(), { via: 'send', msg: BUSY }]);
    expect(h.calls).toHaveLength(1);
    expect(h.logs.some((l) => l.startsWith('INFO') && l.includes(TASK_A) && l.includes('already running'))).toBe(true);
  });

  it.each(['task.assigned', 'task.resumed'] as const)(
    'declines a new attempt of the task it still holds as busy (%s)',
    async (type) => {
      const h = harness({}, { abortEnds: false });
      const w = new Worker(h.deps);
      w.handle(assigned(makeTask()));
      const call = await started(h);
      w.handle(revoked(TASK_A));
      // the hub reassigned the task before this worker finished unwinding it
      w.handle(assigned(makeTask({ attempt: 4 }), type));
      call.finish({ kind: 'aborted', reason: 'revoked' });
      await w.idle();
      expect(h.sent).toEqual([
        accept(),
        { via: 'send', msg: BUSY },
        { via: 'reliable', msg: { type: 'task.decline', taskId: TASK_A, reason: 'busy', attempt: 4 } },
        { via: 'send', msg: IDLE },
      ]);
      expect(h.calls).toHaveLength(1);
      expect(state()).toEqual({ activeTaskId: null, unconfirmed: null, lastRegistered: null, engineGroup: null });
    },
  );

  it('declines a new attempt of a task revoked while it is still being checked as busy', async () => {
    const h = harness();
    const w = new Worker(h.deps);
    w.handle(assigned(makeTask()));
    w.handle(revoked(TASK_A));
    w.handle(assigned(makeTask({ attempt: 4 })));
    await w.idle();
    expect(h.sent).toEqual([
      { via: 'reliable', msg: { type: 'task.decline', taskId: TASK_A, reason: 'busy', attempt: 4 } },
      { via: 'send', msg: IDLE },
    ]);
    expect(h.calls).toHaveLength(0);
  });

  it('persists the active task before sending task.accept', async () => {
    const h = harness();
    writeState(paths.stateFile, {
      activeTaskId: null,
      unconfirmed: { taskId: TASK_B, msg: done(makeTask({ id: TASK_B })) },
      lastRegistered: null,
      engineGroup: null,
    });
    const seen: WorkerState[] = [];
    h.onReliable.fn = (m) => {
      if (m.type === 'task.accept') seen.push(state());
    };
    const w = new Worker(h.deps);
    w.handle(assigned(makeTask()));
    await started(h);
    expect(seen).toEqual([{ activeTaskId: TASK_A, unconfirmed: null, lastRegistered: null, engineGroup: null }]);
  });

  it("declines when the route's executor is not available", async () => {
    const h = harness();
    const unconfirmed = { taskId: TASK_B, msg: done(makeTask({ id: TASK_B })) };
    writeState(paths.stateFile, { activeTaskId: null, unconfirmed, lastRegistered: null, engineGroup: null });
    const w = new Worker(h.deps);
    w.handle(assigned(makeTask({ route: { executor: 'codex', model: null, effort: null } })));
    await w.idle();
    expect(h.sent).toEqual([
      {
        via: 'reliable',
        msg: { type: 'task.decline', taskId: TASK_A, reason: `executor codex not available on ${HOST}`, attempt: 3 },
      },
    ]);
    expect(h.calls).toHaveLength(0);
    expect(w.busy).toBe(false);
    expect(state()).toEqual({ activeTaskId: null, unconfirmed, lastRegistered: null, engineGroup: null });
  });

  it('declines when there is no route executor and no default engine', async () => {
    const h = harness({ adapters: [], engines: [], defaultExecutor: null });
    const w = new Worker(h.deps);
    w.handle(assigned(makeTask()));
    await w.idle();
    expect(h.sent).toEqual([
      { via: 'reliable', msg: { type: 'task.decline', taskId: TASK_A, reason: `no engine available on ${HOST}`, attempt: 3 } },
    ]);
    expect(h.calls).toHaveLength(0);
  });

  it('declines with no engine when the route names none and the default engine is missing', async () => {
    const h = harness({ adapters: [] });
    const w = new Worker(h.deps);
    w.handle(assigned(makeTask()));
    await w.idle();
    expect(h.sent).toEqual([
      { via: 'reliable', msg: { type: 'task.decline', taskId: TASK_A, reason: `no engine available on ${HOST}`, attempt: 3 } },
    ]);
    expect(h.calls).toHaveLength(0);
  });

  it('runs the route executor rather than the default one', async () => {
    const codex = fakeAdapter('codex');
    const h = harness();
    h.deps.adapters = [h.claude, codex];
    const w = new Worker(h.deps);
    w.handle(assigned(makeTask({ route: { executor: 'codex', model: null, effort: null } })));
    expect((await started(h)).deps.adapter).toBe(codex);
  });

  it('declines an unsafe task id before accepting and leaves the state alone', async () => {
    const h = harness();
    writeState(paths.stateFile, { activeTaskId: TASK_B, unconfirmed: null, lastRegistered: null, engineGroup: null });
    const w = new Worker(h.deps);
    w.handle(assigned(makeTask({ id: '../escape' })));
    await w.idle();
    expect(h.sent).toEqual([
      { via: 'reliable', msg: { type: 'task.decline', taskId: '../escape', reason: 'unsafe task id: ../escape', attempt: 3 } },
    ]);
    expect(h.calls).toHaveLength(0);
    expect(state().activeTaskId).toBe(TASK_B);
  });

  it('declines with branch-in-use before accepting when the branch is checked out elsewhere', async () => {
    const other = path.join(fx.scratch, 'other');
    fx.run(fx.repo, ['worktree', 'add', '-b', BRANCH, other]);
    const h = harness();
    const w = new Worker(h.deps);
    w.handle(assigned(makeTask()));
    await w.idle();
    expect(h.sent).toEqual([
      { via: 'reliable', msg: { type: 'task.decline', taskId: TASK_A, reason: `branch-in-use: ${other}`, attempt: 3 } },
    ]);
    expect(h.sent.some((s) => s.msg.type === 'task.accept')).toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(state().activeTaskId).toBeNull();
  });

  it("forwards a runner 'declined' outcome as task.decline and clears state", async () => {
    const h = harness();
    const w = new Worker(h.deps);
    w.handle(assigned(makeTask()));
    (await started(h)).finish({ kind: 'declined', reason: 'branch-in-use: /elsewhere' });
    await w.idle();
    expect(h.sent).toEqual([
      accept(),
      { via: 'send', msg: BUSY },
      { via: 'reliable', msg: { type: 'task.decline', taskId: TASK_A, reason: 'branch-in-use: /elsewhere', attempt: 3 } },
      { via: 'send', msg: IDLE },
    ]);
    expect(state()).toEqual({ activeTaskId: null, unconfirmed: null, lastRegistered: null, engineGroup: null });
  });

  it('clears an unconfirmed outcome once a new task is accepted', async () => {
    const h = harness();
    writeState(paths.stateFile, {
      activeTaskId: null,
      unconfirmed: { taskId: TASK_B, msg: done(makeTask({ id: TASK_B })) },
      lastRegistered: null,
      engineGroup: null,
    });
    const w = new Worker(h.deps);
    w.handle(assigned(makeTask()));
    await started(h);
    expect(state()).toEqual({ activeTaskId: TASK_A, unconfirmed: null, lastRegistered: null, engineGroup: null });
  });

  it('reports a run that throws as a failed task', async () => {
    const h = harness({ run: () => Promise.reject(new Error('boom')) });
    const w = new Worker(h.deps);
    w.handle(assigned(makeTask()));
    await vi.waitFor(() => expect(types(h)).toContain('status.update:idle'));
    await w.idle();
    const error = 'the runner threw: boom';
    const msg: TaskCompleteMsg = {
      type: 'task.complete',
      taskId: TASK_A,
      status: 'failed',
      result: { summary: error, error },
      attempt: 3,
    };
    expect(h.sent.slice(-2)).toEqual([
      { via: 'reliable', msg },
      { via: 'send', msg: IDLE },
    ]);
    expect(state().unconfirmed).toEqual({ taskId: TASK_A, msg });
  });

  it('keeps going in memory when the state file cannot be written', async () => {
    const blocker = path.join(fx.root, 'not-a-dir');
    writeFileSync(blocker, '');
    const h = harness({ paths: { ...paths, stateFile: path.join(blocker, 'state.json') } });
    const w = new Worker(h.deps);
    const task = makeTask();
    w.handle(assigned(task));
    (await started(h)).finish({ kind: 'completed', msg: done(task) });
    await w.idle();
    expect(types(h)).toEqual(['task.accept', 'status.update:busy', 'task.complete', 'status.update:idle']);
    expect(h.logs.some((l) => l.startsWith('ERROR') && l.includes('state'))).toBe(true);
    expect(w.registerPayload().activeTaskId).toBe(TASK_A);
  });
});

describe('task.resumed', () => {
  it('ignores task.resumed for the task already running', async () => {
    const h = harness();
    const w = new Worker(h.deps);
    w.handle(assigned(makeTask()));
    await started(h);
    w.handle(assigned(makeTask(), 'task.resumed'));
    await Promise.resolve();
    expect(h.sent).toEqual([accept(), { via: 'send', msg: BUSY }]);
    expect(h.calls).toHaveLength(1);
  });

  it('re-sends the stored outcome when the hub resumes a finished task', async () => {
    const h = harness();
    const msg = done(makeTask());
    writeState(paths.stateFile, { activeTaskId: null, unconfirmed: { taskId: TASK_A, msg }, lastRegistered: null, engineGroup: null });
    const w = new Worker(h.deps);
    w.handle(assigned(makeTask(), 'task.resumed'));
    await w.idle();
    expect(h.sent).toEqual([{ via: 'reliable', msg }]);
    expect(h.calls).toHaveLength(0);
    expect(w.busy).toBe(false);
    expect(state().unconfirmed).toEqual({ taskId: TASK_A, msg });
  });

  it('runs a resumed task afresh when the stored outcome is for another attempt', async () => {
    const h = harness();
    const old = done(makeTask({ attempt: 1 }));
    writeState(paths.stateFile, { activeTaskId: null, unconfirmed: { taskId: TASK_A, msg: old }, lastRegistered: null, engineGroup: null });
    const w = new Worker(h.deps);
    w.handle(assigned(makeTask({ attempt: 2 }), 'task.resumed'));
    const call = await started(h);
    expect(call.opts).toEqual({ resumed: true });
    expect(h.sent).toEqual([accept(), { via: 'send', msg: BUSY }]);
    expect(state()).toEqual({ activeTaskId: TASK_A, unconfirmed: null, lastRegistered: null, engineGroup: null });
  });

  it('runs the task the worker stopped with, as resumed', async () => {
    const h = harness();
    writeState(paths.stateFile, { activeTaskId: TASK_A, unconfirmed: null, lastRegistered: null, engineGroup: null });
    const w = new Worker(h.deps);
    w.handle(assigned(makeTask(), 'task.resumed'));
    expect((await started(h)).opts).toEqual({ resumed: true });
    expect(h.sent).toEqual([accept(), { via: 'send', msg: BUSY }]);
  });
});

describe('task.revoked', () => {
  it('clears the unconfirmed outcome on task.revoked', () => {
    const h = harness();
    writeState(paths.stateFile, {
      activeTaskId: null,
      unconfirmed: { taskId: TASK_A, msg: done(makeTask()) },
      lastRegistered: null,
      engineGroup: null,
    });
    const w = new Worker(h.deps);
    w.handle(revoked(TASK_A));
    expect(state().unconfirmed).toBeNull();
    expect(w.registerPayload().activeTaskId).toBeUndefined();
    expect(h.sent).toEqual([]);
  });

  it('clears a persisted active task on task.revoked and logs an unknown one', () => {
    const h = harness();
    writeState(paths.stateFile, { activeTaskId: TASK_A, unconfirmed: null, lastRegistered: null, engineGroup: null });
    const w = new Worker(h.deps);
    w.handle(revoked(TASK_B));
    expect(state().activeTaskId).toBe(TASK_A);
    expect(h.logs.some((l) => l.includes(TASK_B))).toBe(true);
    w.handle(revoked(TASK_A));
    expect(state().activeTaskId).toBeNull();
    expect(h.sent).toEqual([]);
  });

  it('aborts the running task on task.revoked and sends no completion', async () => {
    const h = harness();
    const w = new Worker(h.deps);
    w.handle(assigned(makeTask()));
    const call = await started(h);
    w.handle(revoked(TASK_A));
    expect(call.signal.aborted).toBe(true);
    expect(call.signal.reason).toBe('revoked');
    await w.idle();
    expect(types(h)).toEqual(['task.accept', 'status.update:busy', 'status.update:idle']);
    expect(state()).toEqual({ activeTaskId: null, unconfirmed: null, lastRegistered: null, engineGroup: null });
  });

  it('drops a task revoked while it is still being checked', async () => {
    const h = harness();
    writeState(paths.stateFile, { activeTaskId: TASK_A, unconfirmed: null, lastRegistered: null, engineGroup: null });
    const w = new Worker(h.deps);
    w.handle(assigned(makeTask(), 'task.resumed'));
    w.handle(revoked(TASK_A));
    await w.idle();
    expect(h.sent).toEqual([{ via: 'send', msg: IDLE }]);
    expect(h.calls).toHaveLength(0);
    expect(state().activeTaskId).toBeNull();
  });

  it('sends idle, and never task.accept, for a fresh task revoked before it was accepted', async () => {
    const h = harness();
    const w = new Worker(h.deps);
    w.handle(assigned(makeTask()));
    w.handle(revoked(TASK_A));
    await w.idle();
    expect(h.sent).toEqual([{ via: 'send', msg: IDLE }]);
    expect(h.calls).toHaveLength(0);
    expect(w.busy).toBe(false);
    expect(state()).toEqual({ activeTaskId: null, unconfirmed: null, lastRegistered: null, engineGroup: null });
  });
});

describe('registered gate', () => {
  it('drops task.assigned and task.resumed while not registered but honours task.revoked', async () => {
    const h = harness();
    h.registered.value = false;
    writeState(paths.stateFile, { activeTaskId: TASK_B, unconfirmed: null, lastRegistered: null, engineGroup: null });
    const w = new Worker(h.deps);
    w.handle(assigned(makeTask()));
    w.handle(assigned(makeTask(), 'task.resumed'));
    await w.idle();
    expect(h.sent).toEqual([]);
    expect(h.calls).toHaveLength(0);
    expect(h.logs.filter((l) => l.startsWith('WARN') && l.includes(TASK_A))).toHaveLength(2);

    w.handle(revoked(TASK_B));
    expect(state().activeTaskId).toBeNull();
  });

  it('never throws out of handle on a malformed message', () => {
    const h = harness();
    const w = new Worker(h.deps);
    expect(() => w.handle({ type: 'task.assigned' } as unknown as TaskAssignedMsg)).not.toThrow();
    expect(h.logs.some((l) => l.startsWith('ERROR'))).toBe(true);
  });
});

describe('stop', () => {
  it('stop keeps activeTaskId so the next start re-registers with it', async () => {
    const h = harness();
    const w = new Worker(h.deps);
    w.handle(assigned(makeTask()));
    const call = await started(h);
    await w.stop();
    expect(call.signal.reason).toBe('stopping');
    expect(w.busy).toBe(false);
    expect(types(h)).toEqual(['task.accept', 'status.update:busy']);
    expect(state().activeTaskId).toBe(TASK_A);
    expect(new Worker(h.deps).registerPayload().activeTaskId).toBe(TASK_A);
  });

  it('stop during the pre-accept check sends nothing and leaves the state alone', async () => {
    const h = harness();
    const before: WorkerState = {
      activeTaskId: null,
      unconfirmed: { taskId: TASK_B, msg: done(makeTask({ id: TASK_B })) },
      lastRegistered: null,
      engineGroup: null,
    };
    writeState(paths.stateFile, before);
    const w = new Worker(h.deps);
    w.handle(assigned(makeTask()));
    await w.stop();
    expect(h.sent).toEqual([]);
    expect(h.calls).toHaveLength(0);
    expect(w.busy).toBe(false);
    expect(state()).toEqual(before);
  });

  it('declines a task offered after stop as busy', async () => {
    const h = harness();
    const w = new Worker(h.deps);
    await w.stop();
    w.handle(assigned(makeTask()));
    await w.idle();
    expect(h.sent).toEqual([
      { via: 'reliable', msg: { type: 'task.decline', taskId: TASK_A, reason: 'busy', attempt: 3 } },
    ]);
    expect(h.calls).toHaveLength(0);
  });
});

describe('onRegistered', () => {
  it('warns once on hub version mismatch and on a null projectId', () => {
    const h = harness();
    const w = new Worker(h.deps);
    const reg: RegisteredMsg = { type: 'registered', connectionId: 'c1', projectId: null, hubVersion: '9.9.9' };
    w.onRegistered(reg);
    w.onRegistered({ ...reg, connectionId: 'c2' });
    const warns = h.logs.filter((l) => l.startsWith('WARN'));
    expect(warns).toEqual([
      `WARN hub is v9.9.9, worker is v${WORKER_VERSION} — run \`cortex-worker update\``,
      "WARN this repo's origin maps to no hub project",
    ]);
    expect(state().lastRegistered).toMatchObject({ projectId: null, hubVersion: '9.9.9' });
    expect(Number.isNaN(Date.parse(state().lastRegistered?.at ?? ''))).toBe(false);
  });

  it('warns again when the hub version changes or the project mapping is lost again', () => {
    const h = harness();
    const w = new Worker(h.deps);
    const version = (v: string): string => `WARN hub is v${v}, worker is v${WORKER_VERSION} — run \`cortex-worker update\``;
    const noProject = "WARN this repo's origin maps to no hub project";
    const warns = (): string[] => h.logs.filter((l) => l.startsWith('WARN'));
    const reg: RegisteredMsg = { type: 'registered', connectionId: 'c1', projectId: null, hubVersion: '9.9.9' };
    w.onRegistered(reg);
    expect(warns()).toEqual([version('9.9.9'), noProject]);
    w.onRegistered({ ...reg, connectionId: 'c2', projectId: 'proj-1', hubVersion: '9.9.10' });
    expect(warns()).toEqual([version('9.9.9'), noProject, version('9.9.10')]);
    w.onRegistered({ ...reg, connectionId: 'c3', hubVersion: '9.9.10' });
    expect(warns()).toEqual([version('9.9.9'), noProject, version('9.9.10'), noProject]);
  });

  it('does not warn when the versions match and the repo maps to a project', () => {
    const h = harness();
    const w = new Worker(h.deps);
    w.onRegistered({ type: 'registered', connectionId: 'c1', projectId: 'proj-1', hubVersion: WORKER_VERSION });
    expect(h.logs.filter((l) => l.startsWith('WARN'))).toEqual([]);
    expect(state().lastRegistered).toMatchObject({ projectId: 'proj-1', hubVersion: WORKER_VERSION });
  });
});

describe('engine process group', () => {
  it('writes the group the runner reports to the state file, and clears it', async () => {
    const h = harness();
    const w = new Worker(h.deps);
    w.handle(assigned(makeTask()));
    const call = await started(h);
    expect(state().engineGroup).toBeNull();
    call.deps.onEngineGroup?.(4242);
    expect(state()).toMatchObject({ activeTaskId: TASK_A, engineGroup: 4242 });
    call.deps.onEngineGroup?.(null);
    expect(state().engineGroup).toBeNull();
    call.finish({ kind: 'completed', msg: done(call.task) });
    await w.idle();
  });

  it('forgets a group an earlier process recorded: its id may belong to another process by now', () => {
    writeState(paths.stateFile, { activeTaskId: TASK_A, unconfirmed: null, lastRegistered: null, engineGroup: 4242 });
    const w = new Worker(harness().deps);
    expect(state()).toEqual({ activeTaskId: TASK_A, unconfirmed: null, lastRegistered: null, engineGroup: null });
    expect(w.registerPayload().activeTaskId).toBe(TASK_A);
  });
});
