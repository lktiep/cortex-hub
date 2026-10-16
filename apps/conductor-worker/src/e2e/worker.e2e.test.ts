// End to end through the built bundle: `node dist/cortex-worker.mjs start` against a fake hub
// (a WebSocketServer), a fake agy and a fake gh, pushing to a bare origin over loopback HTTP.
// No network, no real engine, no real gh, and none of the developer's git or cortex config:
// the worker runs with its own HOME and without system git config.
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AssignedTask, HubToWorkerMsg, RouteSpec, WorkerToHubMsg } from '@cortex/shared-types';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { createGitFixture, FIXTURE_GIT_IDENTITY, isolateGitConfig, type GitFixture } from '../test-utils/git-fixture.js';
import {
  BUNDLE,
  closeGitServer,
  createSteps,
  isAlive,
  killQuietly,
  portOf,
  PR_URL,
  QUOTA_RESET_MS,
  readJsonLines,
  readPidFile,
  RESET_TOLERANCE_MS,
  serveGit,
  within,
  workerEnv,
  type GitServer,
} from './harness.js';

// Distinctive on purpose: the worker drops every env entry whose value contains the key, so a
// key such as `k` would also drop CORTEX_TEST_CMD ("tests ok") and any path holding a "k".
const API_KEY = 'e2e-key-3f9c1a7d5b2e8046';
const AGENT_ID = 'e2e-1';

type MsgType = WorkerToHubMsg['type'];
type MsgOf<K extends MsgType> = Extract<WorkerToHubMsg, { type: K }>;
interface Received<M extends WorkerToHubMsg = WorkerToHubMsg> {
  index: number;
  /** Index of the hub connection it arrived on. */
  conn: number;
  /** Date.now() when the hub received it. */
  at: number;
  msg: M;
}

function makeTask(n: number, title: string, route: Partial<RouteSpec>): AssignedTask {
  return {
    id: `task-e2e-t${n}`,
    key: `T${n}`,
    title,
    description: `End-to-end task ${n}.`,
    context: {},
    files: [],
    branch: `task/t${n}`,
    baseBranch: 'main',
    route: { executor: 'agy', model: null, effort: null, ...route },
    attempt: 1,
    leaseExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    reviews: [],
    handoff: null,
    testCommand: null,
  };
}

describe.skipIf(process.platform === 'win32')('cortex-worker end to end (built bundle, fake hub, agy and gh)', () => {
  let tmp = '';
  let home = '';
  let fixture: GitFixture | null = null;
  let restoreGitConfig: (() => void) | null = null;
  let gitServer: GitServer | null = null;
  let gitPort = 0;
  let hub: WebSocketServer | null = null;
  let env: NodeJS.ProcessEnv = {};
  let pidFile = '';
  let agyLog = '';
  let ghLog = '';
  let worker: ChildProcess | null = null;
  let workerExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;
  let workerOutput = '';
  const helpers: ChildProcess[] = [];
  const conns: WebSocket[] = [];
  const upgrades: Array<{ url: string; authorization: string | undefined }> = [];
  const received: Received[] = [];

  /** The worker's output tail, plus whatever the git backend complained about. */
  const workerTail = (): string => {
    const tail = `--- worker output (tail) ---\n${workerOutput.split('\n').slice(-40).join('\n')}`;
    const backend = gitServer?.failures.slice(-5) ?? [];
    return backend.length === 0 ? tail : `${tail}\n--- git http-backend (stderr) ---\n${backend.join('\n')}`;
  };

  const { step, waitFor } = createSteps(workerTail);

  function find<K extends MsgType>(type: K, pred: (m: MsgOf<K>) => boolean, from: number): Received<MsgOf<K>> | undefined {
    for (const r of received.slice(from)) {
      if (r.msg.type === type && pred(r.msg as MsgOf<K>)) return r as Received<MsgOf<K>>;
    }
    return undefined;
  }

  /** The first `type` message at or after log index `from` matching `pred`. */
  function next<K extends MsgType>(
    type: K,
    pred: (m: MsgOf<K>) => boolean,
    from: number,
    timeoutMs: number,
  ): Promise<Received<MsgOf<K>>> {
    return waitFor(
      type,
      () => {
        const hit = find(type, pred, from);
        if (hit === undefined && worker !== null && (worker.exitCode !== null || worker.signalCode !== null)) {
          const how = worker.signalCode !== null ? `signal ${worker.signalCode}` : `code ${String(worker.exitCode)}`;
          throw new Error(`the worker exited (${how}) while waiting for ${type}\n${workerTail()}`);
        }
        return hit;
      },
      timeoutMs,
    );
  }

  function hubSend(m: HubToWorkerMsg, conn = conns.length - 1): void {
    const ws = conns[conn];
    if (ws === undefined) throw new Error(`no hub connection #${conn}`);
    ws.send(JSON.stringify(m));
  }

  /** Sends task.assigned; returns the log index the answers start at. */
  function assign(task: AssignedTask): number {
    const from = received.length;
    hubSend({ type: 'task.assigned', task, taskId: task.id, title: task.title, description: task.description });
    return from;
  }

  function originGit(args: string[]): string {
    if (fixture === null) throw new Error('no fixture');
    return fixture.run(fixture.root, ['--git-dir', fixture.origin, ...args]);
  }

  const idleAfter = (from: number): Promise<Received<MsgOf<'status.update'>>> =>
    next('status.update', (m) => m.state === 'idle', from, 20_000);

  /** Outcomes the worker reported for `taskId`; a revoked task must have none. */
  const outcomesOf = (taskId: string): Received[] =>
    received.filter(
      (r) => (r.msg.type === 'task.complete' || r.msg.type === 'task.quota_exhausted') && r.msg.taskId === taskId,
    );

  beforeAll(async () => {
    if (!existsSync(BUNDLE)) {
      throw new Error(`${BUNDLE} is missing: run \`pnpm --filter @cortex/conductor-worker build\` first`);
    }
    tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'cortex-worker-e2e-')));
    home = path.join(tmp, 'home');
    const bin = path.join(tmp, 'bin');
    mkdirSync(home);
    mkdirSync(bin);
    // the fixture's own git calls (test side) see a throwaway global config too
    restoreGitConfig = isolateGitConfig(tmp, FIXTURE_GIT_IDENTITY);
    fixture = createGitFixture();

    gitServer = await serveGit(fixture.root, home);
    gitPort = portOf(gitServer.server);
    // userinfo git accepts, which the worker must strip before it tells the hub
    fixture.run(fixture.repo, ['remote', 'set-url', 'origin', `http://e2e:not-a-real-credential@127.0.0.1:${gitPort}/origin.git`]);

    hub = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    hub.on('connection', (ws, req) => {
      const conn = conns.push(ws) - 1;
      upgrades.push({ url: req.url ?? '', authorization: req.headers.authorization });
      ws.on('message', (data) => {
        received.push({ index: received.length, conn, at: Date.now(), msg: JSON.parse(data.toString()) as WorkerToHubMsg });
      });
    });
    await once(hub, 'listening');

    pidFile = path.join(tmp, 'agy.pid');
    agyLog = path.join(tmp, 'agy.log');
    ghLog = path.join(tmp, 'gh.log');
    env = workerEnv({ home, bin, agyLog, ghLog, extra: { E2E_AGY_PID_FILE: pidFile } });

    const child = spawn(
      process.execPath,
      [
        BUNDLE,
        'start',
        '--hub',
        `http://127.0.0.1:${portOf(hub)}`,
        '--api-key',
        API_KEY,
        '--agent-id',
        AGENT_ID,
        '--repo',
        fixture.repo,
        '--engines',
        'agy',
      ],
      { cwd: tmp, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    worker = child;
    workerExit = new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child.stdout.setEncoding('utf8').on('data', (c: string) => (workerOutput += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (workerOutput += c));
  }, 30_000);

  afterAll(async () => {
    const errors: unknown[] = [];
    const step = async (fn: () => unknown): Promise<void> => {
      try {
        await fn();
      } catch (err) {
        errors.push(err);
      }
    };
    await step(async () => {
      if (worker !== null && worker.exitCode === null && worker.signalCode === null && workerExit !== null) {
        worker.kill('SIGKILL');
        await within(workerExit, 5_000);
      }
    });
    await step(() => {
      for (const h of helpers) if (h.exitCode === null && h.signalCode === null) h.kill('SIGKILL');
    });
    await step(() => {
      // the engine leads its own process group
      const pid = pidFile === '' ? undefined : readPidFile(pidFile);
      if (pid !== undefined) {
        killQuietly(-pid, 'SIGKILL');
        killQuietly(pid, 'SIGKILL');
      }
    });
    await step(async () => {
      for (const ws of conns) ws.terminate();
      const server = hub;
      if (server !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await step(async () => {
      if (gitServer !== null) await closeGitServer(gitServer);
    });
    await step(() => fixture?.cleanup());
    await step(() => restoreGitConfig?.());
    await step(() => {
      if (tmp !== '') rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
    });
    if (errors.length > 0) throw new AggregateError(errors, 'e2e cleanup failed');
  }, 30_000);

  step('1. registers with protocol 2, the agy engine and a repo URL without userinfo', async () => {
    const reg = await next('worker.register', () => true, 0, 20_000);
    const m = reg.msg;
    expect(reg.conn).toBe(0);
    expect(m.protocol).toBe(2);
    expect(m.engines[0]?.executor).toBe('agy');
    expect(m.engines[0]?.models).toContain('gemini-4-argon-low');
    // the clone's origin is http://e2e:not-a-real-credential@127.0.0.1:<port>/origin.git
    expect(fixture?.run(fixture.repo, ['remote', 'get-url', 'origin'])).toContain('@127.0.0.1');
    expect(m.repo).toBe(`http://127.0.0.1:${gitPort}/origin.git`);
    expect(m.repo).not.toContain('@');
    expect(m.activeTaskId).toBeUndefined();

    const upgrade = new URL(upgrades[0]?.url ?? '', 'http://hub.invalid');
    expect(upgrade.pathname).toBe('/ws/conductor');
    expect(upgrade.searchParams.get('agentId')).toBe(AGENT_ID);
    expect(upgrade.searchParams.get('protocol')).toBe('2');
    expect(upgrades[0]?.authorization).toBe(`Bearer ${API_KEY}`);

    hubSend({ type: 'registered', connectionId: 'conn-1', projectId: 'project-e2e', hubVersion: m.version });
  }, 35_000); // waits: 20 s

  step('2. runs T1 to a pushed commit, a pull request and passing tests', async () => {
    const t1 = makeTask(1, 'Add a greeting to the README', { model: 'gemini-4-argon-low' });
    const from = assign(t1);
    const accepted = await next('task.accept', (m) => m.taskId === t1.id, from, 20_000);
    const done = await next('task.complete', (m) => m.taskId === t1.id, accepted.index, 30_000);
    const progress = received
      .slice(accepted.index, done.index)
      .filter((r) => r.msg.type === 'task.progress' && r.msg.taskId === t1.id);
    expect(progress.length).toBeGreaterThanOrEqual(1);

    expect(done.msg.status).toBe('completed');
    expect(done.msg.attempt).toBe(1);
    expect(done.msg.result.prUrl).toBe(PR_URL);
    expect(done.msg.result.testOutput).toContain('tests ok');
    expect(done.msg.result.branch).toBe(t1.branch);
    expect(originGit(['log', '-1', '--format=%s', t1.branch])).toBe(`T1: ${t1.title}`);
    expect(done.msg.result.commit).toBe(originGit(['rev-parse', t1.branch]));

    const prCreate = readJsonLines<{ args: string[] }>(ghLog).find((c) => c.args[0] === 'pr' && c.args[1] === 'create');
    expect(prCreate?.args).toEqual(expect.arrayContaining(['--head', t1.branch, '--base', 'main']));
    await idleAfter(done.index);
  }, 85_000); // waits: 20 + 30 + 20 = 70 s

  step('3. declines T2 as busy while T3 runs; revoking T3 kills agy and pushes its WIP', async () => {
    const t3 = makeTask(3, 'Take a long time', { model: 'slow' });
    const from = assign(t3);
    await next('task.accept', (m) => m.taskId === t3.id, from, 20_000);
    const pid = await waitFor('the slow agy to write its pid', () => readPidFile(pidFile), 20_000);
    expect(isAlive(pid)).toBe(true);

    const t2 = makeTask(2, 'Turned away', { model: 'gemini-4-argon-low' });
    const declined = await next('task.decline', (m) => m.taskId === t2.id, assign(t2), 10_000);
    expect(declined.msg).toEqual({ type: 'task.decline', taskId: t2.id, reason: 'busy', attempt: 1 });

    const revokedAt = received.length;
    hubSend({ type: 'task.revoked', taskId: t3.id, reason: 'e2e: revoked by the test' });
    await waitFor('the slow agy to die', () => (isAlive(pid) ? undefined : true), 15_000);
    await idleAfter(revokedAt);

    // ruling 3: the slow model wrote SLOW.md first, so there is always a WIP commit
    expect(originGit(['log', '-1', '--format=%s', t3.branch])).toBe('WIP T3: revoked');
    expect(originGit(['show', '--name-only', '--format=', t3.branch]).split('\n')).toContain('SLOW.md');
    expect(outcomesOf(t3.id)).toEqual([]);
  }, 100_000); // waits: 20 + 20 + 10 + 15 + 20 = 85 s

  step('4. hands T4 off on quota with a pushed WIP, then finishes it on the same branch', async () => {
    const t4 = makeTask(4, 'Survive a quota', { model: 'claude-sonnet-5-5-low' });
    const quota = await next('task.quota_exhausted', (m) => m.taskId === t4.id, assign(t4), 30_000);
    const q = quota.msg;
    expect(q.executor).toBe('agy');
    expect(q.model).toBe('claude-sonnet-5-5-low');
    expect(q.modelScope).toBe('claude-sonnet-5-5-*');
    expect(q.attempt).toBe(1);
    const resetAt = Date.parse(q.resetAt ?? '');
    expect(Math.abs(resetAt - (quota.at + QUOTA_RESET_MS))).toBeLessThanOrEqual(RESET_TOLERANCE_MS);
    await idleAfter(quota.index);

    const wip = originGit(['rev-parse', t4.branch]);
    expect(q.handoff.branch).toBe(t4.branch);
    expect(q.handoff.commit).toBe(wip);
    expect(originGit(['log', '-1', '--format=%s', t4.branch])).toBe('WIP T4: quota handoff');

    const retry: AssignedTask = {
      ...t4,
      attempt: 2,
      route: { executor: 'agy', model: 'gemini-4-argon-low', effort: null },
      handoff: q.handoff,
    };
    const from = assign(retry);
    const accepted = await next('task.accept', (m) => m.taskId === t4.id, from, 20_000);
    const done = await next('task.complete', (m) => m.taskId === t4.id, accepted.index, 30_000);
    expect(done.msg.status).toBe('completed');
    expect(done.msg.attempt).toBe(2);
    expect(done.msg.result.branch).toBe(t4.branch);
    const head = originGit(['rev-parse', t4.branch]);
    expect(done.msg.result.commit).toBe(head);
    expect(originGit(['rev-parse', `${head}^1`])).toBe(wip);
    expect(originGit(['log', '-1', '--format=%s', t4.branch])).toBe(`T4: ${t4.title}`);

    const lastRun = readJsonLines<{ model: string; prompt: string }>(agyLog).at(-1);
    expect(lastRun?.model).toBe('gemini-4-argon-low');
    expect(lastRun?.prompt).toContain('## Handoff from the previous run');
    await idleAfter(done.index);
  }, 135_000); // waits: 30 + 20 + 20 + 30 + 20 = 120 s

  step('5. reconnects and registers again after the connection drops (1006)', async () => {
    const before = conns.length;
    const from = received.length;
    const last = conns[before - 1];
    if (last === undefined) throw new Error('no hub connection to drop');
    // no close frame: the worker sees 1006
    last.terminate();

    const reg = await next('worker.register', () => true, from, 20_000);
    expect(reg.conn).toBe(before);
    expect(reg.msg.protocol).toBe(2);
    expect(reg.msg.repo).toBe(`http://127.0.0.1:${gitPort}/origin.git`);
    await waitFor(
      'the worker to log close code 1006',
      () => (workerOutput.includes('hub connection closed (code 1006') ? true : undefined),
      5_000,
    );
    hubSend({ type: 'registered', connectionId: 'conn-2', projectId: 'project-e2e', hubVersion: reg.msg.version }, reg.conn);
  }, 40_000); // waits: 20 + 5 = 25 s

  step('6. `cortex-worker stop` stops it: the worker exits 0 within 10 s', async () => {
    if (worker === null || workerExit === null) throw new Error('the worker never started');
    const started = Date.now();
    const stop = spawn(process.execPath, [BUNDLE, 'stop', '--agent-id', AGENT_ID], {
      cwd: tmp,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    helpers.push(stop);
    const stopExit = new Promise<number | null>((resolve) => {
      stop.once('exit', (code) => resolve(code));
    });

    const exited = await within(workerExit, 10_000);
    expect(exited, workerTail()).toEqual({ code: 0, signal: null });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await within(stopExit, 10_000)).toBe(0);

    // nothing the worker said, printed or logged carries the key
    expect(JSON.stringify(received.map((r) => r.msg))).not.toContain(API_KEY);
    expect(workerOutput).not.toContain(API_KEY);
    expect(readFileSync(path.join(home, '.cortex', 'worker', AGENT_ID, 'worker.log'), 'utf8')).not.toContain(API_KEY);
    // the revoked T3 never reported an outcome, before or after the reconnect
    expect(outcomesOf('task-e2e-t3')).toEqual([]);
  }, 35_000); // waits: 10 + 10 = 20 s
});
