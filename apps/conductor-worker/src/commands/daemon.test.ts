import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Executor } from '@cortex/shared-types';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { parseCli, startForeground } from '../cli.js';
import type { CliArgs, StartOptions } from '../cli.js';
import type { EngineAdapter } from '../engines/types.js';
import { HubClient } from '../hub-client.js';
import { workerPaths } from '../paths.js';
import type { WorkerPaths } from '../paths.js';
import { writeState } from '../state.js';
import type { WorkerState } from '../state.js';
import { createGitFixture } from '../test-utils/git-fixture.js';
import type { GitFixture } from '../test-utils/git-fixture.js';
import { WORKER_VERSION } from '../version.js';
import { claimPidFile, isAlive, printLogs, readPid, startDaemon, statusText, stopWorker } from './daemon.js';

const posixOnly = it.skipIf(process.platform === 'win32');

let root: string;
let n = 0;
const children: ChildProcess[] = [];
const detached = new WeakSet<ChildProcess>();
const strayPids: number[] = [];

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'cw-daemon-')));
});

afterEach(() => {
  for (const c of children.splice(0)) {
    if (c.pid === undefined) continue;
    if (detached.has(c) && process.platform !== 'win32') {
      try {
        process.kill(-c.pid, 'SIGKILL'); // its grandchildren too
      } catch {
        // group gone
      }
    }
    if (isAlive(c.pid)) c.kill('SIGKILL');
  }
  for (const pid of strayPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function freshPaths(agentId = 'a'): WorkerPaths {
  const paths = workerPaths(agentId, path.join(root, `home${n++}`));
  mkdirSync(paths.home, { recursive: true });
  return paths;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** A node process running `code`; killed after the test. */
function spawnNode(code: string, opts: { detached?: boolean; env?: NodeJS.ProcessEnv } = {}): ChildProcess {
  const c = spawn(process.execPath, ['-e', code], {
    stdio: 'ignore',
    detached: opts.detached ?? false,
    env: { ...process.env, ...opts.env },
  });
  children.push(c);
  if (opts.detached === true) detached.add(c);
  return c;
}

async function deadPid(): Promise<number> {
  const c = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((r) => c.once('exit', r));
  if (c.pid === undefined) throw new Error('no pid');
  return c.pid;
}

function writePid(paths: WorkerPaths, pid: number): void {
  mkdirSync(paths.home, { recursive: true });
  writeFileSync(paths.pidFile, `${pid}\n`);
}

const startArgs = (extra: string[] = []): CliArgs => {
  const a = parseCli(['start', ...extra]);
  if ('error' in a) throw new Error(a.error);
  return a;
};

describe('readPid and isAlive', () => {
  it('reads a positive integer pid, else null', () => {
    const paths = freshPaths();
    expect(readPid(paths)).toBeNull();
    writePid(paths, 4242);
    expect(readPid(paths)).toBe(4242);
    for (const bad of ['', 'abc', '-3', '0', '12abc', '1.5']) {
      writeFileSync(paths.pidFile, bad);
      expect(readPid(paths)).toBeNull();
    }
  });

  it('tells a live pid from a dead one', async () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(await deadPid())).toBe(false);
    expect(isAlive(0)).toBe(false);
    expect(isAlive(-1)).toBe(false);
  });
});

describe('claimPidFile', () => {
  it('claims a missing or stale pid file and gives way to a live holder', async () => {
    const paths = freshPaths();
    expect(claimPidFile(paths)).toBeNull();
    expect(readPid(paths)).toBe(process.pid);
    writePid(paths, await deadPid());
    expect(claimPidFile(paths)).toBeNull();
    expect(readPid(paths)).toBe(process.pid);
    writeFileSync(paths.pidFile, 'garbage');
    expect(claimPidFile(paths)).toBeNull();
    expect(readPid(paths)).toBe(process.pid);
    const live = spawnNode('setInterval(() => {}, 1000)');
    writePid(paths, live.pid ?? 0);
    expect(claimPidFile(paths)).toBe(live.pid);
    expect(readPid(paths)).toBe(live.pid);
  });

  it('keeps the pid file another start claimed after this one judged the old file stale', async () => {
    const paths = freshPaths();
    writePid(paths, await deadPid());
    const rival = spawnNode('setInterval(() => {}, 1000)');
    let reads = 0;
    const racingRead = (file: string): string | null => {
      const text = existsSync(file) ? readFileSync(file, 'utf8') : null;
      if (++reads === 1) {
        // the rival start removes the stale file and writes its own, just after our first look
        rmSync(file);
        writeFileSync(file, `${rival.pid}\n`, { flag: 'wx' });
      }
      return text;
    };
    expect(claimPidFile(paths, racingRead)).toBe(rival.pid);
    expect(readPid(paths)).toBe(rival.pid);
  });
});

// ── startDaemon ──

/** The script startDaemon runs: records its argv and env, then writes the pid file (or not). */
const FAKE_WORKER = `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const env = process.env;
writeFileSync(env.FAKE_INFO_FILE, JSON.stringify({
  pid: process.pid,
  pidFileBefore: existsSync(env.FAKE_PID_FILE) ? readFileSync(env.FAKE_PID_FILE, 'utf8') : null,
  argv: process.argv.slice(2),
  daemon: env.CORTEX_WORKER_DAEMON ?? null,
  apiKey: env.CORTEX_API_KEY ?? null,
}));
if (env.FAKE_MODE === 'exit') {
  console.error('fake worker: giving up');
  process.exit(3);
}
console.log('fake worker started');
if (env.FAKE_MODE !== 'silent') writeFileSync(env.FAKE_PID_FILE, process.pid + '\\n');
setInterval(() => {}, 1000);
`;

interface FakeInfo {
  pid: number;
  pidFileBefore: string | null;
  argv: string[];
  daemon: string | null;
  apiKey: string | null;
}

describe('startDaemon', () => {
  let dir: string;
  let script: string;
  let info: string;

  beforeEach(() => {
    dir = path.join(root, `daemon${n++}`);
    mkdirSync(dir, { recursive: true });
    script = path.join(dir, 'fake-worker.mjs');
    writeFileSync(script, FAKE_WORKER);
    info = path.join(dir, 'info.json');
  });

  const fakeEnv = (paths: WorkerPaths, mode = 'normal'): NodeJS.ProcessEnv => ({
    ...process.env,
    FAKE_PID_FILE: paths.pidFile,
    FAKE_INFO_FILE: info,
    FAKE_MODE: mode,
    CORTEX_API_KEY: undefined,
  });

  const readInfo = (): FakeInfo => JSON.parse(readFileSync(info, 'utf8')) as FakeInfo;

  it('startDaemon writes a pid and the child survives the parent', async () => {
    const paths = freshPaths();
    const argv = ['-d', '--agent-id', 'a', '-fd', '--engines=claude'];
    const r = await startDaemon(startArgs(['-d']), paths, script, argv, { env: fakeEnv(paths) });
    if (!('pid' in r)) throw new Error(r.error);
    strayPids.push(r.pid);
    expect(readPid(paths)).toBe(r.pid);
    expect(isAlive(r.pid)).toBe(true);
    // re-run as `start` without the daemon flag, told it is the daemon
    expect(readInfo()).toEqual({
      pid: r.pid,
      pidFileBefore: null,
      argv: ['start', '--agent-id', 'a', '-f', '--engines=claude'],
      daemon: '1',
      apiKey: null,
    });
    // its stdout and stderr go to the log
    await until(() => existsSync(paths.logFile) && readFileSync(paths.logFile, 'utf8').includes('fake worker started'), 'log');
    if (process.platform !== 'win32') {
      // detached: it leads its own process group, so the terminal's signals do not reach it
      expect(() => process.kill(-r.pid, 0)).not.toThrow();
    }
  });

  posixOnly('the child outlives a parent process that exits', async () => {
    const paths = freshPaths();
    const bundle = path.join(dir, 'daemon.bundle.mjs');
    await build({
      entryPoints: [fileURLToPath(new URL('./daemon.ts', import.meta.url))],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: bundle,
      logLevel: 'silent',
    });
    const parent = path.join(dir, 'parent.mjs');
    writeFileSync(
      parent,
      `import { startDaemon } from ${JSON.stringify(pathToFileURL(bundle).href)};
const r = await startDaemon({ command: 'start', daemon: true, follow: false, probe: false },
  JSON.parse(process.env.FAKE_PATHS), process.env.FAKE_SCRIPT, ['-d']);
process.stdout.write(JSON.stringify(r));
`,
    );
    // returns once the parent exits: the daemon must not hold the parent's pipes either
    const out = execFileSync(process.execPath, [parent], {
      env: { ...fakeEnv(paths), FAKE_PATHS: JSON.stringify(paths), FAKE_SCRIPT: script },
      encoding: 'utf8',
      timeout: 15_000,
    });
    const r = JSON.parse(out) as { pid?: number; error?: string };
    if (r.pid === undefined) throw new Error(r.error ?? out);
    strayPids.push(r.pid);
    await sleep(100);
    expect(isAlive(r.pid)).toBe(true);
    expect(readPid(paths)).toBe(r.pid);
  });

  it('refuses when the pid file points at a live process, without spawning', async () => {
    const paths = freshPaths();
    const live = spawnNode('setInterval(() => {}, 1000)');
    writePid(paths, live.pid ?? 0);
    const r = await startDaemon(startArgs(['-d']), paths, script, ['-d'], { env: fakeEnv(paths) });
    expect(r).toEqual({ error: `already running (pid ${live.pid})` });
    expect(existsSync(info)).toBe(false);
  });

  it('ignores a stale pid file and leaves replacing it to the child', async () => {
    const paths = freshPaths();
    const dead = await deadPid();
    writePid(paths, dead);
    const env = { ...fakeEnv(paths), CORTEX_API_KEY: 'from-env' };
    const r = await startDaemon(startArgs(['-d']), paths, script, ['-d'], { env });
    if (!('pid' in r)) throw new Error(r.error);
    strayPids.push(r.pid);
    expect(readPid(paths)).toBe(r.pid);
    // the child's claim replaces it; a parent that removed it could remove a racing child's claim
    expect(readInfo().pidFileBefore).toBe(`${dead}\n`);
    // without --api-key the key the env holds passes through as is
    expect(readInfo().apiKey).toBe('from-env');
  });

  it('hands --api-key to the child in its env, never in its argv', async () => {
    const paths = freshPaths();
    const argv = ['-d', '--api-key', 'k-first', '--agent-id', 'a', '--api-key=k-last', '--engines=claude'];
    const env = { ...fakeEnv(paths), CORTEX_API_KEY: 'from-env' };
    const r = await startDaemon(startArgs(argv), paths, script, argv, { env });
    if (!('pid' in r)) throw new Error(r.error);
    strayPids.push(r.pid);
    const got = readInfo();
    expect(got.argv).toEqual(['start', '--agent-id', 'a', '--engines=claude']);
    // the flag wins over the env, as it does for a foreground start
    expect(got.apiKey).toBe('k-last');
  });

  it('reports a worker that exits before writing its pid file', async () => {
    const paths = freshPaths();
    const r = await startDaemon(startArgs(['-d']), paths, script, ['-d'], { env: fakeEnv(paths, 'exit') });
    expect(r).toEqual({ error: expect.stringMatching(/exited.*code 3.*worker\.log/) });
    expect(readFileSync(paths.logFile, 'utf8')).toContain('fake worker: giving up');
  });

  it('gives up when no pid file appears in time', async () => {
    const paths = freshPaths();
    const r = await startDaemon(startArgs(['-d']), paths, script, ['-d'], {
      env: fakeEnv(paths, 'silent'),
      timeoutMs: 300,
    });
    await until(() => existsSync(info), 'the fake to start');
    const pid = readInfo().pid;
    strayPids.push(pid);
    expect(r).toEqual({ error: expect.stringContaining(`pid ${pid}`) });
    expect(r).toEqual({ error: expect.stringMatching(/may still be starting.*cortex-worker status --agent-id a.*worker\.log/) });
    // the child is left running: it may just be slow
    expect(isAlive(pid)).toBe(true);
  });
});

// ── stopWorker ──

/** Exits once the stop file exists, leaving a marker. */
const OBEYS_STOP_FILE = `
const fs = require('node:fs');
setInterval(() => {
  if (fs.existsSync(process.env.STOP_FILE)) {
    fs.writeFileSync(process.env.MARKER, 'saw the stop file');
    process.exit(0);
  }
}, 20);
`;

describe('stopWorker', () => {
  it("stopWorker uses the stop file and returns 'stopped' when the process exits in time", async () => {
    const paths = freshPaths();
    const marker = path.join(paths.home, 'marker');
    const w = spawnNode(OBEYS_STOP_FILE, { detached: true, env: { STOP_FILE: paths.stopFile, MARKER: marker } });
    writePid(paths, w.pid ?? 0);
    expect(await stopWorker(paths, { graceMs: 5000 })).toBe('stopped');
    expect(readFileSync(marker, 'utf8')).toBe('saw the stop file');
    expect(isAlive(w.pid ?? 0)).toBe(false);
    expect(existsSync(paths.pidFile)).toBe(false);
    expect(existsSync(paths.stopFile)).toBe(false);
  });

  posixOnly("stopWorker kills the tree after graceMs and returns 'killed'", async () => {
    const paths = freshPaths();
    const gcFile = path.join(paths.home, 'grandchild.pid');
    // a daemon (group leader) that ignores the stop file and has a grandchild
    const w = spawnNode(
      `const { spawn } = require('node:child_process');
       const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
       require('node:fs').writeFileSync(process.env.GC_FILE, String(g.pid));
       setInterval(() => {}, 1000);`,
      { detached: true, env: { GC_FILE: gcFile } },
    );
    await until(() => existsSync(gcFile), 'the grandchild');
    const grandchild = Number(readFileSync(gcFile, 'utf8'));
    strayPids.push(grandchild);
    writePid(paths, w.pid ?? 0);
    const started = Date.now();
    expect(await stopWorker(paths, { graceMs: 300 })).toBe('killed');
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(isAlive(w.pid ?? 0)).toBe(false);
    await until(() => !isAlive(grandchild), 'the grandchild to die');
    expect(existsSync(paths.pidFile)).toBe(false);
    expect(existsSync(paths.stopFile)).toBe(false);
  });

  posixOnly("kills a foreground worker, which leads no process group, and returns 'killed'", async () => {
    const paths = freshPaths();
    const w = spawnNode("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)");
    writePid(paths, w.pid ?? 0);
    await sleep(100); // let it install the SIGTERM handler
    expect(await stopWorker(paths, { graceMs: 200 })).toBe('killed');
    expect(isAlive(w.pid ?? 0)).toBe(false);
    expect(existsSync(paths.pidFile)).toBe(false);
  });

  posixOnly('also kills the engine process group the worker recorded, which the worker tree kill misses', async () => {
    const paths = freshPaths();
    const engineFile = path.join(paths.home, 'engine.pid');
    // a daemon that ignores the stop file and runs an engine in a process group of its own, as runCli does
    const w = spawnNode(
      `const { spawn } = require('node:child_process');
       const e = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
       require('node:fs').writeFileSync(process.env.ENGINE_FILE, String(e.pid));
       setInterval(() => {}, 1000);`,
      { detached: true, env: { ENGINE_FILE: engineFile } },
    );
    await until(() => existsSync(engineFile), 'the engine');
    const engine = Number(readFileSync(engineFile, 'utf8'));
    strayPids.push(engine);
    writeState(paths.stateFile, { activeTaskId: 't-1', unconfirmed: null, lastRegistered: null, engineGroup: engine });
    writePid(paths, w.pid ?? 0);
    expect(await stopWorker(paths, { graceMs: 200 })).toBe('killed');
    expect(isAlive(w.pid ?? 0)).toBe(false);
    await until(() => !isAlive(engine), 'the engine to die', 3000);
  });

  posixOnly('a recorded engine group that is gone already does not fail the stop', async () => {
    const paths = freshPaths();
    const w = spawnNode('setInterval(() => {}, 1000)', { detached: true });
    writeState(paths.stateFile, { activeTaskId: null, unconfirmed: null, lastRegistered: null, engineGroup: await deadPid() });
    writePid(paths, w.pid ?? 0);
    expect(await stopWorker(paths, { graceMs: 200 })).toBe('killed');
    expect(isAlive(w.pid ?? 0)).toBe(false);
  });

  it("stopWorker returns 'not-running' for a stale pid file", async () => {
    const paths = freshPaths();
    writePid(paths, await deadPid());
    expect(await stopWorker(paths, { graceMs: 200 })).toBe('not-running');
    expect(existsSync(paths.stopFile)).toBe(false);
    expect(existsSync(paths.pidFile)).toBe(false);
  });

  it("returns 'not-running' without a pid file and leaves no stop file", async () => {
    const paths = freshPaths();
    expect(await stopWorker(paths, { graceMs: 200 })).toBe('not-running');
    expect(existsSync(paths.stopFile)).toBe(false);
  });
});

// ── status ──

describe('statusText', () => {
  const state: WorkerState = {
    activeTaskId: 't-9',
    unconfirmed: null,
    lastRegistered: { projectId: 'p-1', hubVersion: '1.2.3', at: '2026-10-17T10:00:00.000Z' },
    engineGroup: null,
  };

  it('shows running, the pid, the agent id, the task and the last registration', () => {
    const paths = freshPaths('box-repo');
    writePid(paths, process.pid);
    const text = statusText(paths, state);
    expect(text).toContain(`running (pid ${process.pid})`);
    expect(text).toContain('box-repo');
    expect(text).toContain('t-9');
    expect(text).toMatch(/2026-10-17T10:00:00\.000Z.*1\.2\.3.*p-1/);
    expect(text).toContain(paths.logFile);
  });

  it('shows stopped, a stale pid, no task and never registered', async () => {
    const paths = freshPaths();
    const empty: WorkerState = { activeTaskId: null, unconfirmed: null, lastRegistered: null, engineGroup: null };
    expect(statusText(paths, empty)).toMatch(/stopped/);
    expect(statusText(paths, empty)).toMatch(/active task:\s+none/);
    expect(statusText(paths, empty)).toMatch(/last registered:\s+never/);
    const dead = await deadPid();
    writePid(paths, dead);
    expect(statusText(paths, empty)).toMatch(new RegExp(`stopped.*stale.*${dead}`));
  });
});

// ── logs ──

function collect(): { out: PassThrough; text: () => string } {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (c: Buffer) => chunks.push(c));
  return { out, text: () => Buffer.concat(chunks).toString('utf8') };
}

const numbered = (from: number, to: number): string =>
  Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}\n`).join('');

describe('printLogs', () => {
  it('printLogs prints the last 200 lines and follows appended lines', async () => {
    const paths = freshPaths();
    writeFileSync(paths.logFile, numbered(1, 250));
    const once = collect();
    await printLogs(paths, { follow: false, out: once.out });
    expect(once.text()).toBe(numbered(51, 250));

    const ac = new AbortController();
    const f = collect();
    const done = printLogs(paths, { follow: true, out: f.out, signal: ac.signal, pollMs: 20 });
    await until(() => f.text() === numbered(51, 250), 'the tail');
    appendFileSync(paths.logFile, 'line 251\nline 2');
    appendFileSync(paths.logFile, '52\n');
    await until(() => f.text().endsWith('line 251\nline 252\n'), 'the appended lines');
    ac.abort();
    await done;
  });

  it('takes a line count', async () => {
    const paths = freshPaths();
    writeFileSync(paths.logFile, numbered(1, 5));
    const c = collect();
    await printLogs(paths, { follow: false, lines: 2, out: c.out });
    expect(c.text()).toBe('line 4\nline 5\n');
  });

  it('starts over when the file is rotated', async () => {
    const paths = freshPaths();
    writeFileSync(paths.logFile, numbered(1, 50));
    const ac = new AbortController();
    const c = collect();
    const done = printLogs(paths, { follow: true, out: c.out, signal: ac.signal, pollMs: 20 });
    await until(() => c.text().endsWith('line 50\n'), 'the tail');
    renameSync(paths.logFile, `${paths.logFile}.1`);
    writeFileSync(paths.logFile, 'fresh 1\n');
    await until(() => c.text().endsWith('line 50\nfresh 1\n'), 'the rotated file');
    ac.abort();
    await done;
  });

  it('notes a missing log file, and with follow waits for it', async () => {
    const paths = freshPaths();
    const once = collect();
    await printLogs(paths, { follow: false, out: once.out });
    expect(once.text()).toBe(`no log file yet at ${paths.logFile}\n`);

    const ac = new AbortController();
    const c = collect();
    const done = printLogs(paths, { follow: true, out: c.out, signal: ac.signal, pollMs: 20 });
    await sleep(60);
    mkdirSync(paths.home, { recursive: true });
    writeFileSync(paths.logFile, 'first\n');
    await until(() => c.text().endsWith('first\n'), 'the new file');
    ac.abort();
    await done;
  });

  it('returns at once for an aborted signal', async () => {
    const paths = freshPaths();
    writeFileSync(paths.logFile, 'x\n');
    const ac = new AbortController();
    ac.abort();
    await printLogs(paths, { follow: true, out: collect().out, signal: ac.signal });
  });
});

// ── start (foreground) ──

const KEY = 'ctx_test_key_start_0123';

interface TestHub {
  base: string;
  frames: Array<Record<string, unknown>>;
  requests: IncomingMessage[];
  closes: number[];
  close: () => Promise<void>;
}

async function startHub(closeWith?: number): Promise<TestHub> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const hub: TestHub = {
    base: `http://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    frames: [],
    requests: [],
    closes: [],
    close: async () => {
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    hub.requests.push(req);
    ws.on('close', (code: number) => hub.closes.push(code));
    if (closeWith !== undefined) {
      ws.close(closeWith, 'test');
      return;
    }
    ws.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      hub.frames.push(msg);
      if (msg['type'] === 'worker.register') {
        ws.send(JSON.stringify({ type: 'registered', connectionId: 'c-1', projectId: 'p-1', hubVersion: WORKER_VERSION }));
      }
    });
  });
  return hub;
}

function fakeAdapter(executor: Executor, found = true): EngineAdapter {
  return {
    executor,
    detect: () => Promise.resolve({ found }),
    models: () => Promise.resolve(['*']),
    defaultModel: () => null,
    buildArgs: () => ({ args: [] }),
    run: () => Promise.reject(new Error('no engine in this test')),
    classify: () => ({ kind: 'ok' }),
    progressText: () => null,
    summary: () => '',
  };
}

describe('start', () => {
  let fx: GitFixture;
  let hub: TestHub | null = null;
  const running: Array<{ signals: EventEmitter; done: Promise<number> }> = [];

  beforeAll(() => {
    fx = createGitFixture();
  });
  afterAll(() => fx.cleanup());
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const r of running.splice(0)) {
      r.signals.emit('SIGTERM');
      await r.done;
    }
    await hub?.close();
    hub = null;
  });

  interface Harness {
    paths: WorkerPaths;
    signals: EventEmitter;
    exit: ReturnType<typeof vi.fn>;
    adapterEnvs: NodeJS.ProcessEnv[];
    opts: StartOptions;
    log: () => string;
  }

  function harness(h: TestHub | null, over: Partial<StartOptions> = {}): Harness {
    const home = path.join(root, `home${n++}`);
    mkdirSync(home, { recursive: true });
    const signals = new EventEmitter();
    const exit = vi.fn();
    const adapterEnvs: NodeJS.ProcessEnv[] = [];
    const paths = workerPaths('w1', home);
    const opts: StartOptions = {
      env: {
        PATH: process.env.PATH,
        CORTEX_HUB_URL: h?.base ?? 'http://127.0.0.1:9',
        CORTEX_API_KEY: KEY,
        CORTEX_AGENT_ID: 'w1',
        CORTEX_WORKER_DAEMON: '1',
        ALSO_THE_KEY: KEY,
      },
      homeDir: home,
      hostname: 'box',
      cwd: fx.repo,
      signals,
      exit: exit as unknown as (code: number) => void,
      stopPollMs: 20,
      createAdapters: (names, env) => {
        adapterEnvs.push(env);
        return names.map((x) => fakeAdapter(x));
      },
      ...over,
    };
    const log = (): string => (existsSync(paths.logFile) ? readFileSync(paths.logFile, 'utf8') : '');
    return { paths, signals, exit, adapterEnvs, opts, log };
  }

  function launch(h: Harness, args: CliArgs = startArgs()): Promise<number> {
    const done = startForeground(args, h.opts);
    running.push({ signals: h.signals, done });
    return done;
  }

  const settled = (p: Promise<number>): Promise<boolean> =>
    Promise.race([p.then(() => true), sleep(0).then(() => false)]);

  it('start refuses when the pid file points at a live process', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = harness(null);
    const live = spawnNode('setInterval(() => {}, 1000)');
    writePid(h.paths, live.pid ?? 0);
    expect(await startForeground(startArgs(), h.opts)).toBe(1);
    expect(err).toHaveBeenCalledWith(`already running (pid ${live.pid})`);
    expect(readPid(h.paths)).toBe(live.pid);
  });

  it('registers with the hub, then stops on the stop file', async () => {
    hub = await startHub();
    const h = harness(hub);
    const done = launch(h, startArgs(['--capabilities', 'x,y', '--engines', 'codex,claude']));
    await until(() => hub?.frames.some((f) => f['type'] === 'worker.register') === true, 'worker.register');
    expect(readPid(h.paths)).toBe(process.pid);
    const reg = hub.frames.find((f) => f['type'] === 'worker.register') ?? {};
    expect(reg).toMatchObject({
      hostname: 'box',
      repo: fx.origin,
      capabilities: ['x', 'y'],
      engines: [{ executor: 'codex' }, { executor: 'claude' }],
      defaultExecutor: 'codex',
    });
    const url = new URL(hub.requests[0]?.url ?? '', 'ws://x');
    expect(url.pathname).toBe('/ws/conductor');
    expect(url.searchParams.get('agentId')).toBe('w1');
    expect(hub.requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);

    // the engines and their setup/test commands never see the key, whatever the variable
    expect(h.adapterEnvs).toHaveLength(1);
    expect(Object.values(h.adapterEnvs[0] ?? {}).some((v) => v === KEY)).toBe(false);
    expect(h.adapterEnvs[0]?.ALSO_THE_KEY).toBeUndefined();
    expect(h.adapterEnvs[0]?.PATH).toBe(process.env.PATH);

    writeFileSync(h.paths.stopFile, '');
    expect(await done).toBe(0);
    expect(existsSync(h.paths.pidFile)).toBe(false);
    expect(existsSync(h.paths.stopFile)).toBe(false);
    await until(() => hub?.closes.includes(1000) === true, 'a clean close');
    expect(h.signals.listenerCount('SIGINT') + h.signals.listenerCount('SIGTERM')).toBe(0);
    expect(h.log()).toContain('w1');
    expect(h.log()).not.toContain(KEY);
  });

  it('deletes a leftover stop file before it starts watching for one', async () => {
    hub = await startHub();
    const h = harness(hub);
    mkdirSync(h.paths.home, { recursive: true });
    writeFileSync(h.paths.stopFile, 'left by a killed run');
    const done = launch(h);
    await until(() => hub?.frames.length !== 0, 'worker.register');
    await sleep(150); // several stop-file polls
    expect(await settled(done)).toBe(false);
    expect(existsSync(h.paths.stopFile)).toBe(false);
  });

  it('SIGTERM stops gracefully; a second signal exits 130 at once', async () => {
    hub = await startHub();
    const h = harness(hub);
    const done = launch(h);
    await until(() => hub?.frames.length !== 0, 'worker.register');
    h.signals.emit('SIGTERM');
    h.signals.emit('SIGINT');
    expect(h.exit).toHaveBeenCalledWith(130);
    expect(await done).toBe(0);
    expect(existsSync(h.paths.pidFile)).toBe(false);
  });

  it('removes every process.env entry whose value is the key, so git, gh and hooks never see it', async () => {
    vi.stubEnv('CW_TEST_KEY_COPY', KEY);
    vi.stubEnv('CW_TEST_KEY_HEADER', `Authorization: Bearer ${KEY}`);
    vi.stubEnv('CW_TEST_UNRELATED', 'keep me');
    hub = await startHub();
    const h = harness(hub);
    void launch(h);
    await until(() => hub?.frames.length !== 0, 'worker.register');
    expect(Object.entries(process.env).filter(([, v]) => v === KEY)).toEqual([]);
    expect(process.env['CW_TEST_UNRELATED']).toBe('keep me');
    // exact values only: matching substrings, a short key would take PATH with it
    expect(process.env['CW_TEST_KEY_HEADER']).toBe(`Authorization: Bearer ${KEY}`);
    // the engines' env is the scrubbed one too
    expect(Object.values(h.adapterEnvs[0] ?? {}).some((v) => v === KEY)).toBe(false);
  });

  /** Emits `names` from inside `HubClient.stop`, i.e. while a shutdown is under way. */
  function signalDuringShutdown(h: Harness, names: Array<'SIGINT' | 'SIGTERM'>): { exitCallsAfter: number[] } {
    const realStop = HubClient.prototype.stop;
    const seen = { exitCallsAfter: [] as number[] };
    vi.spyOn(HubClient.prototype, 'stop').mockImplementation(function (this: HubClient) {
      for (const name of names) {
        h.signals.emit(name);
        seen.exitCallsAfter.push(h.exit.mock.calls.length);
      }
      return realStop.call(this);
    });
    return seen;
  }

  it('one signal during a stop-file shutdown does not exit at once; a second one exits 130', async () => {
    hub = await startHub();
    const h = harness(hub);
    const seen = signalDuringShutdown(h, ['SIGTERM', 'SIGINT']);
    const done = launch(h);
    await until(() => hub?.frames.length !== 0, 'worker.register');
    writeFileSync(h.paths.stopFile, '');
    expect(await done).toBe(0);
    expect(seen.exitCallsAfter).toEqual([0, 1]);
    expect(h.exit.mock.calls).toEqual([[130]]);
  });

  it('one signal during the shutdown after a fatal close neither exits nor changes the exit code 2', async () => {
    hub = await startHub(4003);
    const h = harness(hub);
    const seen = signalDuringShutdown(h, ['SIGINT']);
    expect(await launch(h)).toBe(2);
    expect(seen.exitCallsAfter).toEqual([0]);
    expect(h.exit).not.toHaveBeenCalled();
  });

  it.each([
    [4003, /check the key.*env CORTEX_API_KEY/],
    [4001, /check the key.*env CORTEX_API_KEY/],
    [4009, /--agent-id/],
    [4000, /another instance on this host took over/],
  ])('close code %i exits 2 with a hint', async (code, hint) => {
    hub = await startHub(code);
    const h = harness(hub);
    expect(await launch(h)).toBe(2);
    expect(h.log()).toMatch(hint);
    expect(h.log()).not.toContain(KEY);
    expect(existsSync(h.paths.pidFile)).toBe(false);
  });

  it('exits 1 naming the install commands when no engine is found', async () => {
    const h = harness(null, { createAdapters: (names) => names.map((x) => fakeAdapter(x, false)) });
    expect(await launch(h, startArgs(['--engines', 'claude,agy']))).toBe(1);
    expect(h.log()).toMatch(/no engine found/);
    expect(h.log()).toContain('npm install -g @anthropic-ai/claude-code');
    expect(h.log()).toContain('antigravity');
    expect(existsSync(h.paths.pidFile)).toBe(false);
  });

  it('exits 1 for a repo without an origin', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bare = path.join(root, `no-git${n++}`);
    mkdirSync(bare);
    const h = harness(null, { cwd: bare });
    expect(await startForeground(startArgs(), h.opts)).toBe(1);
    expect(String(err.mock.calls[0]?.[0])).toMatch(/origin/);
    expect(existsSync(h.paths.pidFile)).toBe(false);
  });

  it('exits 1 when no hub is configured', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = harness(null);
    const env = { ...h.opts.env };
    delete env.CORTEX_HUB_URL;
    expect(await startForeground(startArgs(), { ...h.opts, env })).toBe(1);
    expect(String(err.mock.calls[0]?.[0])).toMatch(/--hub/);
  });
});
