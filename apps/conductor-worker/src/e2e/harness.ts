// Shared by the end-to-end tests (worker.e2e.test.ts, hub.e2e.test.ts): the built bundle, the
// fake agy and gh, a loopback git server, the worker's scrubbed environment and bounded steps.
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BUNDLE = path.resolve(HERE, '../../dist/cortex-worker.mjs');
const FAKE_AGY = path.join(HERE, 'fake-agy.mjs');
const FAKE_GH = path.join(HERE, 'fake-gh.mjs');

/** What fake-gh prints for `gh pr create`. */
export const PR_URL = 'https://github.com/acme/demo/pull/1';
export const TEST_CMD = `node -e "console.log('tests ok')"`;
/** A prompt holding this makes fake-agy.mjs run out of quota whatever the model (its QUOTA_MARKER). */
export const QUOTA_MARKER = '[e2e-quota]';
/** "Resets in 89h3m4s" in quota.stderr.txt. */
export const QUOTA_RESET_MS = ((89 * 60 + 3) * 60 + 4) * 1000;
export const RESET_TOLERANCE_MS = 5 * 60_000;

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** `p`, or 'timeout' after `ms`; the timer never outlives the race. */
export async function within<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export function killQuietly(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
  }
}

export function readPidFile(file: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function readJsonLines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as T);
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * A /bin/sh wrapper that runs `script` with the node running this test: it works whatever
 * mode the .mjs was checked out with and whichever node is first on PATH.
 */
function writeWrapper(dir: string, name: string, script: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}

export function portOf(server: { address(): AddressInfo | string | null }): number {
  const a = server.address();
  if (a === null || typeof a === 'string') throw new Error('server has no TCP address');
  return a.port;
}

/**
 * The worker's environment: this process's, minus anything that would reach past the test (a
 * GIT_DIR from a git hook, the developer's CORTEX_API_KEY or CORTEX_SETUP_CMD, a GH_TOKEN), with
 * its own HOME, no system git config, and wrappers for the fake agy and gh written to `bin`,
 * which comes first on PATH so a lookup by name never reaches a real agy or gh either.
 */
export function workerEnv(opts: {
  home: string;
  bin: string;
  agyLog: string;
  ghLog: string;
  extra?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(GIT_|CORTEX_|GH_|GITHUB_)/.test(k) || k === 'HUB_API_KEY') continue;
    inherited[k] = v;
  }
  return {
    ...inherited,
    HOME: opts.home,
    USERPROFILE: opts.home,
    XDG_CONFIG_HOME: path.join(opts.home, '.config'),
    PATH: `${opts.bin}${path.delimiter}${process.env['PATH'] ?? ''}`,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    CORTEX_AGY_BIN: writeWrapper(opts.bin, 'agy', FAKE_AGY),
    CORTEX_GH_BIN: writeWrapper(opts.bin, 'gh', FAKE_GH),
    CORTEX_TEST_CMD: TEST_CMD,
    E2E_AGY_LOG: opts.agyLog,
    E2E_GH_LOG: opts.ghLog,
    ...opts.extra,
  };
}

export interface GitServer {
  server: http.Server;
  /** `git http-backend` processes that have not exited yet. */
  children: Set<ChildProcess>;
  /** One entry per request whose backend failed or wrote to stderr. */
  failures: string[];
}

/** Bounds what one backend's stderr can add to a failure message. */
const BACKEND_STDERR_MAX = 8_192;

/**
 * Serves the repositories under `projectRoot` over smart HTTP on 127.0.0.1 through
 * `git http-backend`, so the clone's origin can be an http URL with userinfo that git
 * accepts and the worker must strip, without leaving the machine.
 */
export async function serveGit(projectRoot: string, home: string): Promise<GitServer> {
  const children = new Set<ChildProcess>();
  const failures: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const env: NodeJS.ProcessEnv = {
      PATH: process.env['PATH'],
      HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_PROJECT_ROOT: projectRoot,
      GIT_HTTP_EXPORT_ALL: '1',
      // http-backend enables receive-pack (push) only for an authenticated user
      REMOTE_USER: 'e2e',
      REQUEST_METHOD: req.method ?? 'GET',
      PATH_INFO: decodeURIComponent(url.pathname),
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: req.headers['content-type'] ?? '',
    };
    if (req.headers['content-length'] !== undefined) env['CONTENT_LENGTH'] = req.headers['content-length'];
    if (req.headers['content-encoding'] !== undefined) env['HTTP_CONTENT_ENCODING'] = req.headers['content-encoding'];
    const protocol = req.headers['git-protocol'];
    if (typeof protocol === 'string') env['GIT_PROTOCOL'] = protocol;

    const request = `${req.method ?? 'GET'} ${url.pathname}${url.search}`;
    const child = spawn('git', ['http-backend'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    let stderr = '';
    let killedHere = false;
    child.stderr.setEncoding('utf8').on('data', (c: string) => {
      if (stderr.length < BACKEND_STDERR_MAX) stderr += c.slice(0, BACKEND_STDERR_MAX - stderr.length);
    });
    child.on('error', (err) => {
      stderr += `${err.message}\n`;
    });
    child.on('close', (code, signal) => {
      children.delete(child);
      const failed = code !== 0 && !killedHere;
      if (failed || stderr !== '') {
        failures.push(`${request}: http-backend exited with ${code ?? signal ?? '?'}\n${stderr.trimEnd()}`);
      }
      if (res.writableEnded) return;
      if (!res.headersSent && failed) {
        res.statusCode = 502;
        res.setHeader('content-type', 'text/plain');
        res.end(`git http-backend exited with ${code ?? signal ?? '?'} before its headers\n${stderr}`);
        return;
      }
      res.end();
    });
    // a client that goes away mid-request would leave the backend waiting on its stdin
    res.on('close', () => {
      if (child.exitCode === null && child.signalCode === null) {
        killedHere = true;
        child.kill('SIGTERM');
      }
    });
    child.stdin.on('error', () => undefined);
    req.pipe(child.stdin);

    // CGI output: headers (with an optional Status line), a blank line, then the body
    let head = Buffer.alloc(0);
    let inBody = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (inBody) {
        res.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      inBody = true;
      for (const line of head.subarray(0, end).toString('latin1').split('\r\n')) {
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === 'status') res.statusCode = Number.parseInt(value, 10);
        else res.setHeader(name, value);
      }
      res.write(head.subarray(end + 4));
    });
    // without a complete CGI head there is nothing to end yet: 'close' answers with a 502
    child.stdout.on('end', () => {
      if (inBody) res.end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, children, failures };
}

/** Kills the backends still running and closes the server. */
export async function closeGitServer(git: GitServer): Promise<void> {
  for (const c of git.children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  git.server.closeAllConnections();
  await new Promise<void>((resolve) => git.server.close(() => resolve()));
}

export interface Steps {
  /**
   * One step of the scenario. `timeoutMs` is the vitest timeout; the body gets 2 s less, so its
   * own bound fails it with `tail()` before vitest does. Each step's timeout is the sum of its
   * inner waits plus 15 s, so a stuck wait reports itself before the bound fires.
   */
  step(name: string, body: () => Promise<void>, timeoutMs: number): void;
  /**
   * Polls `probe` every `intervalMs` until it returns a value; throws after `timeoutMs`, and
   * stops once a step has failed.
   */
  waitFor<T>(
    what: string,
    probe: () => T | undefined | Promise<T | undefined>,
    timeoutMs: number,
    intervalMs?: number,
  ): Promise<T>;
}

/**
 * Steps that share one worker and build on each other: once one fails, the rest are skipped.
 * `tail` (the worker's output, say) is appended to every timeout.
 */
export function createSteps(tail: () => string): Steps {
  let failedStep: string | null = null;

  async function waitFor<T>(
    what: string,
    probe: () => T | undefined | Promise<T | undefined>,
    timeoutMs: number,
    intervalMs = 20,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // a step abandoned at its bound must not keep polling into the next step or afterAll
      if (failedStep !== null) throw new Error(`stopped waiting for ${what}: step "${failedStep}" failed`);
      const v = await probe();
      if (v !== undefined) return v;
      if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}\n${tail()}`);
      await delay(intervalMs);
    }
  }

  function step(name: string, body: () => Promise<void>, timeoutMs: number): void {
    const boundMs = timeoutMs - 2_000;
    it(
      name,
      async (ctx) => {
        ctx.skip(failedStep !== null, `needs step "${failedStep ?? ''}", which failed`);
        // a vitest-level timeout rejects from outside the body, so record the failure here too
        ctx.onTestFailed(() => {
          failedStep ??= name;
        });
        const run = body();
        // after the bound gives up on it, its own rejection is expected, not unhandled
        run.catch(() => undefined);
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            run,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                reject(new Error(`step still running after ${boundMs} ms\n${tail()}`));
              }, boundMs);
            }),
          ]);
        } catch (err) {
          failedStep = name;
          throw err;
        } finally {
          clearTimeout(timer);
        }
      },
      timeoutMs,
    );
  }

  return { step, waitFor };
}
