// Opt-in, full stack: the built worker bundle against a real hub (dashboard-api, reached through
// hub-mcp's /ws/conductor proxy), with the fake agy and gh and a loopback git origin. The hub
// gets a three-task tree, A -> B -> C, and this file checks what the hub records as the worker
// runs it: A waits in review with a pull request until it is approved, B's first model runs out
// of quota and the hub moves B to its fallback, and C runs last. Every assertion about order,
// routes and quota is read back from the hub's REST API, not from what the worker says.
//
// Skipped unless all three CORTEX_E2E_* variables are set, and on Windows. To run it:
//
//   pnpm build
//   # dist/index.js reads its schema next to itself; tsc does not copy it (the Dockerfile does)
//   cp apps/dashboard-api/src/db/schema.sql apps/dashboard-api/dist/db/schema.sql
//   tmp=$(mktemp -d)                          # a throwaway database: see "what it leaves behind"
//   DATABASE_PATH=$tmp/cortex.db PORT=4510 node apps/dashboard-api/dist/index.js &
//   PORT=4511 DASHBOARD_API_URL=http://127.0.0.1:4510 node apps/hub-mcp/dist/node.js &
//   curl -sX POST http://127.0.0.1:4510/api/keys -H 'Content-Type: application/json' \
//     -d '{"name":"conductor-e2e","scope":"all"}'          # prints {"key":"sk_ctx_…", …}
//   CORTEX_E2E_API_URL=http://127.0.0.1:4510 \
//   CORTEX_E2E_HUB_URL=http://127.0.0.1:4511 \
//   CORTEX_E2E_API_KEY=sk_ctx_… \
//     pnpm --filter @cortex/conductor-worker exec vitest run src/e2e/hub.e2e.test.ts
//
// Any free ports will do. No Docker, Qdrant or model provider is needed.
//
//   CORTEX_E2E_API_URL  the dashboard-api origin, without /api. Its conductor routes take no
//                       login, so the test creates the project and the tree and approves A there.
//   CORTEX_E2E_HUB_URL  what the worker gets as --hub. hub-mcp checks the key with dashboard-api
//                       and proxies /ws/conductor; the dashboard-api origin works too.
//   CORTEX_E2E_API_KEY  a key that is not scoped to a project (POST /api/keys makes one): the
//                       hub matches the worker's repo to the project this test creates, and closes
//                       a key scoped to another project with 4003. It reaches the worker through
//                       CORTEX_API_KEY, never its command line.
//
// What it leaves behind: the project, its tasks and the worker's state under a temporary HOME
// are removed afterwards, but the hub keeps an agy `claude-sonnet-5-5-*` quota row for this
// machine's hostname for about 89 hours (the fake's "Resets in 89h3m4s"), and there is no REST
// route to clear it. Against a hub that real workers on this machine use, that row stops the hub
// from routing them to claude-sonnet-5-5 models; use a throwaway DATABASE_PATH as above. It also
// makes the hub skip B's first model on the next run, so step 1 refuses to go on while the row is
// there: run again against a fresh database.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RouteSpec, TreeCreateRequest, TreeCreateResponse, WorkerView } from '@cortex/shared-types';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { createGitFixture, FIXTURE_GIT_IDENTITY, isolateGitConfig, type GitFixture } from '../test-utils/git-fixture.js';
import {
  BUNDLE,
  closeGitServer,
  createSteps,
  portOf,
  PR_URL,
  QUOTA_RESET_MS,
  readJsonLines,
  RESET_TOLERANCE_MS,
  serveGit,
  within,
  workerEnv,
  type GitServer,
} from './harness.js';

const API_URL = (process.env['CORTEX_E2E_API_URL'] ?? '').replace(/\/+$/, '');
const HUB_URL = process.env['CORTEX_E2E_HUB_URL'] ?? '';
const API_KEY = process.env['CORTEX_E2E_API_KEY'] ?? '';

/** Names in a shared hub must not collide with another run's. */
const RUN = randomBytes(4).toString('hex');
const AGENT_ID = `e2e-hub-${RUN}`;
const QUOTA_MODEL = 'claude-sonnet-5-5-low';
/** The quota row the hub writes for QUOTA_MODEL. */
const QUOTA_SCOPE = 'claude-sonnet-5-5-*';
const FALLBACK: RouteSpec = { executor: 'agy', model: 'gemini-4-argon-low', effort: null };
/**
 * The hub stamps assigned_at to the second. Every agy run lasting longer than that puts each
 * assignment in a later second than the one before it, which is what step 5 compares.
 */
const AGY_MIN_MS = 1_100;
const POLL_MS = 200;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

type Key = 'A' | 'B' | 'C';
const KEYS: readonly Key[] = ['A', 'B', 'C'];
const TITLES: Record<Key, string> = {
  A: 'Add a greeting to the README',
  B: 'Survive a quota on the way',
  C: 'Finish after both',
};

/** The conductor_tasks columns this test reads, as GET /api/conductor/:id/tree returns them. */
interface TaskRow {
  id: string;
  task_key: string | null;
  status: string;
  attempt: number;
  assigned_to_agent: string | null;
  assigned_at: string | null;
  completed_at: string | null;
  branch: string | null;
  /** JSON: RouteSpec. */
  current_route: string | null;
  /** JSON: TaskResult. */
  result: string | null;
}
interface TreeView {
  root: TaskRow;
  tasks: TaskRow[];
  workers: WorkerView[];
}
type Tree = Record<Key, TaskRow>;

function parseJson<T>(text: string | null, what: string): T {
  if (text === null) throw new Error(`${what} is null`);
  return JSON.parse(text) as T;
}

/** Date.parse of a timestamp the hub must have set. */
function timeOf(t: TaskRow, field: 'assigned_at' | 'completed_at'): number {
  const v = t[field];
  if (v === null) throw new Error(`${t.task_key ?? t.id}.${field} is null`);
  return Date.parse(v);
}

describe.skipIf(
  !process.env['CORTEX_E2E_API_URL'] ||
    !process.env['CORTEX_E2E_HUB_URL'] ||
    !process.env['CORTEX_E2E_API_KEY'] ||
    process.platform === 'win32',
)('cortex-worker against a real hub (built bundle, fake agy and gh)', () => {
  let tmp = '';
  let home = '';
  let agyLog = '';
  let fixture: GitFixture | null = null;
  let restoreGitConfig: (() => void) | null = null;
  let gitServer: GitServer | null = null;
  let projectId: string | null = null;
  let rootId: string | null = null;
  /** Task ids by key, G (the group) included. */
  let ids: Record<string, string> = {};
  let worker: ChildProcess | null = null;
  let workerExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;
  let workerOutput = '';
  let lastTree: TreeView | null = null;

  /** The worker's output, the hub's last view of the tree and the git backend's complaints. */
  const tail = (): string => {
    const parts = [`--- worker output (tail) ---\n${workerOutput.split('\n').slice(-40).join('\n')}`];
    if (lastTree !== null) {
      const rows = lastTree.tasks.map(
        (t) =>
          `${t.task_key ?? t.id} ${t.status} attempt=${t.attempt} assigned_at=${t.assigned_at ?? '-'} ` +
          `completed_at=${t.completed_at ?? '-'} route=${t.current_route ?? '-'}`,
      );
      parts.push(`--- hub tree (last poll) ---\n${rows.join('\n')}`);
    }
    const backend = gitServer?.failures.slice(-5) ?? [];
    if (backend.length > 0) parts.push(`--- git http-backend (stderr) ---\n${backend.join('\n')}`);
    return parts.join('\n');
  };

  const { step, waitFor } = createSteps(tail);

  async function api<T>(method: 'GET' | 'POST' | 'DELETE', route: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method, signal: AbortSignal.timeout(10_000) };
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${API_URL}/api${route}`, init);
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} /api${route}: HTTP ${res.status} ${text.slice(0, 500)}`);
    return JSON.parse(text) as T;
  }

  function idOf(key: Key): string {
    const id = ids[key];
    if (id === undefined) throw new Error(`the hub returned no id for ${key}`);
    return id;
  }

  /** The tree as the hub has it now, by key; fails fast once a task fails or the worker exits. */
  async function tree(): Promise<Tree> {
    if (rootId === null) throw new Error('no tree');
    const view = await api<TreeView>('GET', `/conductor/${rootId}/tree`);
    lastTree = view;
    const byKey: Partial<Tree> = {};
    for (const t of view.tasks) if (t.task_key === 'A' || t.task_key === 'B' || t.task_key === 'C') byKey[t.task_key] = t;
    for (const key of KEYS) {
      const t = byKey[key];
      if (t === undefined) throw new Error(`the hub's tree has no task ${key}\n${tail()}`);
      if (t.status === 'failed' || t.status === 'cancelled') throw new Error(`task ${key} is ${t.status}\n${tail()}`);
    }
    if (worker !== null && (worker.exitCode !== null || worker.signalCode !== null)) {
      throw new Error(`the worker exited (${worker.signalCode ?? String(worker.exitCode)})\n${tail()}`);
    }
    return byKey as Tree;
  }

  /** Polls the hub's tree until `pred` holds. */
  const treeUntil = (what: string, pred: (t: Tree) => boolean, timeoutMs: number): Promise<Tree> =>
    waitFor(
      what,
      async () => {
        const t = await tree();
        return pred(t) ? t : undefined;
      },
      timeoutMs,
      POLL_MS,
    );

  async function ourWorker(): Promise<WorkerView | undefined> {
    const { agents } = await api<{ agents: WorkerView[] }>('GET', '/conductor/agents');
    return agents.find((a) => a.agentId === AGENT_ID);
  }

  function originGit(args: string[]): string {
    if (fixture === null) throw new Error('no fixture');
    return fixture.run(fixture.root, ['--git-dir', fixture.origin, ...args]);
  }

  beforeAll(async () => {
    if (!existsSync(BUNDLE)) {
      throw new Error(`${BUNDLE} is missing: run \`pnpm --filter @cortex/conductor-worker build\` first`);
    }
    tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'cortex-worker-hub-e2e-')));
    home = path.join(tmp, 'home');
    const bin = path.join(tmp, 'bin');
    mkdirSync(home);
    mkdirSync(bin);
    restoreGitConfig = isolateGitConfig(tmp, FIXTURE_GIT_IDENTITY);
    fixture = createGitFixture();
    gitServer = await serveGit(fixture.root, home);
    // the worker reports this URL as its repo, and the hub matches it to the project below
    const repoUrl = `http://127.0.0.1:${portOf(gitServer.server)}/origin.git`;
    fixture.run(fixture.repo, ['remote', 'set-url', 'origin', repoUrl]);

    const project = await api<{ id: string }>('POST', '/orgs/org-default/projects', {
      name: `conductor-e2e-${RUN}`,
      description: 'cortex-worker hub.e2e.test.ts; removed when the run ends',
      gitRepoUrl: repoUrl,
    });
    projectId = project.id;

    // pinned to this run's worker, so no other worker on a shared hub takes them
    const common = { parentKey: 'G', pinnedAgent: AGENT_ID } as const;
    const request: TreeCreateRequest = {
      projectId,
      tasks: [
        { key: 'G', title: `conductor e2e ${RUN}`, kind: 'group' },
        { key: 'A', title: TITLES.A, ...common, reviewRequired: true },
        {
          key: 'B',
          title: TITLES.B,
          ...common,
          dependsOn: ['A'],
          executor: 'agy',
          model: QUOTA_MODEL,
          fallback: [FALLBACK],
          reviewRequired: false,
        },
        { key: 'C', title: TITLES.C, ...common, dependsOn: ['B'], reviewRequired: false },
      ],
    };
    const created = await api<TreeCreateResponse>('POST', '/conductor/tree', request);
    ids = created.ids;
    rootId = created.ids['G'] ?? null;
    expect(created.rootIds).toEqual([rootId]);
    expect(created.ready).toBe(1);

    agyLog = path.join(tmp, 'agy.log');
    const env = workerEnv({
      home,
      bin,
      agyLog,
      ghLog: path.join(tmp, 'gh.log'),
      extra: { CORTEX_API_KEY: API_KEY, E2E_AGY_MIN_MS: String(AGY_MIN_MS) },
    });
    const child = spawn(
      process.execPath,
      [BUNDLE, 'start', '--hub', HUB_URL, '--agent-id', AGENT_ID, '--repo', fixture.repo, '--engines', 'agy'],
      { cwd: tmp, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    worker = child;
    workerExit = new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child.stdout.setEncoding('utf8').on('data', (c: string) => (workerOutput += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (workerOutput += c));
  }, 60_000);

  afterAll(async () => {
    const errors: unknown[] = [];
    const attempt = async (fn: () => unknown): Promise<void> => {
      try {
        await fn();
      } catch (err) {
        errors.push(err);
      }
    };
    await attempt(async () => {
      if (worker === null || workerExit === null || worker.exitCode !== null || worker.signalCode !== null) return;
      worker.kill('SIGTERM');
      if ((await within(workerExit, 15_000)) === 'timeout') {
        worker.kill('SIGKILL');
        await within(workerExit, 5_000);
      }
    });
    // children before parents, and nothing left for the dispatcher to hand out
    for (const key of ['C', 'B', 'A', 'G']) {
      const id = ids[key];
      if (id === undefined) continue;
      await attempt(async () => {
        const { task } = await api<{ task: { status: string } }>('GET', `/conductor/${id}`);
        if (!TERMINAL.has(task.status)) await api('POST', `/conductor/${id}/cancel`, { reason: 'e2e cleanup' });
        await api('DELETE', `/conductor/${id}`);
      });
    }
    await attempt(async () => {
      if (projectId !== null) await api('DELETE', `/projects/${projectId}`);
    });
    await attempt(async () => {
      if (gitServer !== null) await closeGitServer(gitServer);
    });
    await attempt(() => fixture?.cleanup());
    await attempt(() => restoreGitConfig?.());
    await attempt(() => {
      if (tmp !== '') rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
    });
    if (errors.length > 0) throw new AggregateError(errors, 'hub e2e cleanup failed');
  }, 60_000);

  step('1. registers, and the hub matches its repo to the project', async () => {
    const view = await waitFor('the hub to list the worker', ourWorker, 20_000, POLL_MS);
    expect(view.projectId).toBe(projectId);
    expect(view.hostname).toBe(os.hostname());
    const agy = view.engines.find((e) => e.executor === 'agy');
    expect(agy?.models).toEqual(expect.arrayContaining([QUOTA_MODEL, FALLBACK.model]));
    const stale = view.quota.find((q) => q.executor === 'agy' && q.model === QUOTA_SCOPE);
    expect(
      stale,
      `the hub already holds an agy ${QUOTA_SCOPE} quota row for ${os.hostname()} until ${stale?.exhaustedUntil ?? ''}, ` +
        'from an earlier run, so it would never give B its first model: run against a fresh DATABASE_PATH',
    ).toBeUndefined();
  }, 35_000); // waits: 20 s

  step('2. dispatches A first; A waits in review with its pull request', async () => {
    const t = await treeUntil('A to reach review', (x) => x.A.status === 'review', 60_000);
    expect(t.A.assigned_to_agent).toBe(AGENT_ID);
    expect(t.A.assigned_at).not.toBeNull();
    expect(parseJson<{ prUrl?: string }>(t.A.result, 'A.result').prUrl).toBe(PR_URL);
    expect(t.A.branch).not.toBeNull();
    expect(originGit(['log', '-1', '--format=%s', t.A.branch ?? ''])).toBe(`A: ${TITLES.A}`);
    for (const key of ['B', 'C'] as const) {
      expect(t[key].status, key).toBe('blocked');
      expect(t[key].assigned_at, key).toBeNull();
    }
  }, 75_000); // waits: 60 s

  step('3. approving A completes it and dispatches B', async () => {
    const { task } = await api<{ task: TaskRow }>('POST', `/conductor/${idOf('A')}/review`, {
      verdict: 'approve',
      by: 'hub.e2e.test.ts',
    });
    expect(task.status).toBe('completed');
    const t = await treeUntil('B to be dispatched', (x) => x.B.assigned_at !== null, 20_000);
    expect(t.A.status).toBe('completed');
    expect(t.B.assigned_to_agent).toBe(AGENT_ID);
    expect(t.C.status).toBe('blocked');
    expect(t.C.assigned_at).toBeNull();
  }, 35_000); // waits: 20 s

  step('4. B runs out of quota; the hub records it and B completes on its fallback', async () => {
    const started = Date.now();
    const t = await treeUntil('B to complete', (x) => x.B.status === 'completed', 90_000);
    expect(parseJson<RouteSpec>(t.B.current_route, 'B.current_route')).toEqual(FALLBACK);
    expect(t.B.attempt).toBe(2);
    expect(t.B.assigned_to_agent).toBe(AGENT_ID);

    const view = await ourWorker();
    const row = view?.quota.find((q) => q.executor === 'agy' && q.model === QUOTA_SCOPE);
    expect(row, JSON.stringify(view?.quota)).toBeDefined();
    const until = Date.parse(row?.exhaustedUntil ?? '');
    expect(until).toBeGreaterThanOrEqual(started - 60_000 + QUOTA_RESET_MS - RESET_TOLERANCE_MS);
    expect(until).toBeLessThanOrEqual(Date.now() + QUOTA_RESET_MS + RESET_TOLERANCE_MS);

    // the fallback run picked up the quota run's work in progress on the same branch
    const branch = t.B.branch ?? '';
    expect(originGit(['log', '-1', '--format=%s', branch])).toBe(`B: ${TITLES.B}`);
    expect(originGit(['log', '-1', '--format=%s', `${branch}^1`])).toBe('WIP B: quota handoff');
    // found by model, not by position: the quota run, then the fallback run right after it
    const runs = readJsonLines<{ model: string; prompt: string }>(agyLog);
    const quotaRun = runs.findIndex((r) => r.model === QUOTA_MODEL);
    expect(quotaRun, JSON.stringify(runs.map((r) => r.model))).toBeGreaterThanOrEqual(0);
    expect(runs.filter((r) => r.model === QUOTA_MODEL)).toHaveLength(1);
    const fallbackRun = runs[quotaRun + 1];
    expect(fallbackRun?.model).toBe(FALLBACK.model);
    expect(fallbackRun?.prompt).toContain('## Handoff from the previous run');
  }, 105_000); // waits: 90 s

  step('5. C runs last: the hub assigned A, B and C in that order', async () => {
    const t = await treeUntil('C to complete', (x) => x.C.status === 'completed', 60_000);
    expect(t.C.assigned_to_agent).toBe(AGENT_ID);
    const order = KEYS.map((k) => `${k}=${t[k].assigned_at ?? '-'}`).join(' ');
    expect(timeOf(t.A, 'assigned_at'), order).toBeLessThan(timeOf(t.B, 'assigned_at'));
    expect(timeOf(t.B, 'assigned_at'), order).toBeLessThan(timeOf(t.C, 'assigned_at'));
    // each one only after the one it depends on was done
    expect(timeOf(t.B, 'assigned_at')).toBeGreaterThanOrEqual(timeOf(t.A, 'completed_at'));
    expect(timeOf(t.C, 'assigned_at')).toBeGreaterThanOrEqual(timeOf(t.B, 'completed_at'));

    // nothing the worker printed or logged, and nothing the hub stored, carries the key
    expect(workerOutput).not.toContain(API_KEY);
    expect(readFileSync(path.join(home, '.cortex', 'worker', AGENT_ID, 'worker.log'), 'utf8')).not.toContain(API_KEY);
    expect(JSON.stringify(lastTree)).not.toContain(API_KEY);
  }, 75_000); // waits: 60 s
});
