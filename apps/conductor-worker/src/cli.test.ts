import { EventEmitter } from 'node:events';
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { envWithoutSecret, isEntrypoint, main, parseCli, resolveAgentId, scrubSecret } from './cli.js';
import { DEFAULT_STOP_GRACE_MS, isAlive } from './commands/daemon.js';
import { workerPaths } from './paths.js';
import { WORKER_VERSION } from './version.js';

const posixOnly = it.skipIf(process.platform === 'win32');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

describe('parseCli', () => {
  it('parses --version', () => {
    expect(parseCli(['--version'])).toMatchObject({ command: 'version' });
    expect(parseCli(['version'])).toMatchObject({ command: 'version' });
  });

  it('defaults to help', () => {
    expect(parseCli([])).toMatchObject({ command: 'help' });
    expect(parseCli(['-h'])).toMatchObject({ command: 'help' });
  });

  it('rejects unknown commands', () => {
    expect(parseCli(['bogus'])).toEqual({ error: expect.stringMatching(/unknown command/) });
  });

  it('parses start --daemon --agent-id a --engines claude,agy --capabilities x,y', () => {
    expect(
      parseCli(['start', '--daemon', '--agent-id', 'a', '--engines', 'claude,agy', '--capabilities', 'x,y']),
    ).toEqual({
      command: 'start',
      daemon: true,
      follow: false,
      probe: false,
      agentId: 'a',
      engines: ['claude', 'agy'],
      capabilities: ['x', 'y'],
      engineTimeoutMin: 90,
    });
  });

  it('parses the remaining start options', () => {
    expect(
      parseCli(['start', '-d', '--repo', '../r', '--hub', 'https://h.example', '--api-key', 'k', '--engine-timeout', '2.5']),
    ).toMatchObject({ daemon: true, repo: '../r', hub: 'https://h.example', apiKey: 'k', engineTimeoutMin: 2.5 });
  });

  it('rejects an unknown engine', () => {
    expect(parseCli(['start', '--engines', 'claude,cursor'])).toEqual({
      error: expect.stringMatching(/unknown engine: cursor/),
    });
    expect(parseCli(['start', '--engines', ' , '])).toEqual({ error: expect.stringMatching(/--engines/) });
  });

  it('defaults engines to agy,claude,codex,gemini', () => {
    expect(parseCli(['start'])).toMatchObject({ engines: ['agy', 'claude', 'codex', 'gemini'], capabilities: [] });
  });

  it('trims and de-duplicates the comma lists', () => {
    expect(parseCli(['start', '--engines', ' codex , claude,codex', '--capabilities', 'a,, b ,a'])).toMatchObject({
      engines: ['codex', 'claude'],
      capabilities: ['a', 'b'],
    });
  });

  it('rejects a non-positive or non-numeric --engine-timeout', () => {
    for (const v of ['0', '-5', 'abc', '', 'Infinity']) {
      expect(parseCli(['start', `--engine-timeout=${v}`])).toEqual({
        error: expect.stringMatching(/--engine-timeout/),
      });
    }
  });

  it('parses logs -f, doctor --probe, stop, status, update and hub-url', () => {
    expect(parseCli(['logs', '-f'])).toMatchObject({ command: 'logs', follow: true });
    expect(parseCli(['doctor', '--probe'])).toMatchObject({ command: 'doctor', probe: true });
    for (const c of ['stop', 'status', 'update', 'hub-url'] as const) {
      expect(parseCli([c])).toMatchObject({ command: c, daemon: false, follow: false, probe: false });
    }
  });

  it('rejects unknown options, a missing value and extra arguments', () => {
    expect(parseCli(['start', '--bogus'])).toEqual({ error: expect.stringMatching(/bogus/) });
    expect(parseCli(['start', '--agent-id'])).toEqual({ error: expect.stringMatching(/agent-id/) });
    expect(parseCli(['start', 'extra'])).toEqual({ error: expect.stringMatching(/unexpected argument: extra/) });
  });

  it('wants the command first', () => {
    expect(parseCli(['--daemon', 'start'])).toEqual({ error: expect.stringMatching(/command/) });
  });
});

describe('envWithoutSecret', () => {
  it('drops every entry whose value is the secret, whatever its name', () => {
    const env = {
      PATH: '/bin',
      CORTEX_API_KEY: 'sk-123',
      MY_TOKEN: 'sk-123',
      HEADERS: 'Authorization: Bearer sk-123',
      OTHER: 'sk-12',
      EMPTY: undefined,
    };
    expect(envWithoutSecret(env, 'sk-123')).toEqual({
      PATH: '/bin',
      HEADERS: 'Authorization: Bearer sk-123',
      OTHER: 'sk-12',
      EMPTY: undefined,
    });
    expect(env.CORTEX_API_KEY).toBe('sk-123');
  });

  it('keeps PATH and every other value that merely contains a short key', () => {
    const env = { PATH: '/usr/local/bin', HOME: '/home/s', CORTEX_API_KEY: 's', CMD: 'tests ok' };
    expect(envWithoutSecret(env, 's')).toEqual({ PATH: '/usr/local/bin', HOME: '/home/s', CMD: 'tests ok' });
  });

  it('keeps everything for an empty secret', () => {
    expect(envWithoutSecret({ A: 'x' }, '')).toEqual({ A: 'x' });
  });
});

describe('scrubSecret', () => {
  it('deletes, in place, every entry whose value is the secret', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/bin', CORTEX_API_KEY: 'sk-123', HEADERS: 'Bearer sk-123', OTHER: 'sk-12' };
    scrubSecret(env, 'sk-123');
    expect(env).toEqual({ PATH: '/bin', HEADERS: 'Bearer sk-123', OTHER: 'sk-12' });
    scrubSecret(env, '');
    expect(env).toEqual({ PATH: '/bin', HEADERS: 'Bearer sk-123', OTHER: 'sk-12' });
  });

  it('leaves PATH alone for a one-character key it contains', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/local/bin', CORTEX_API_KEY: 's' };
    scrubSecret(env, 's');
    expect(env).toEqual({ PATH: '/usr/local/bin' });
  });
});

describe('resolveAgentId', () => {
  const base = { command: 'status', daemon: false, follow: false, probe: false } as const;

  it('takes --agent-id, then CORTEX_AGENT_ID, then host + repo folder', () => {
    expect(resolveAgentId({ ...base, agentId: 'flag' }, { CORTEX_AGENT_ID: 'env' }, 'Box', '/x/repo')).toBe('flag');
    expect(resolveAgentId(base, { CORTEX_AGENT_ID: 'env' }, 'Box', '/x/repo')).toBe('env');
    expect(resolveAgentId(base, { CORTEX_AGENT_ID: '' }, 'Box', '/x/repo')).toBe('box-repo');
    expect(resolveAgentId({ ...base, repo: 'other' }, {}, 'Box', '/x/repo')).toBe('box-other');
  });
});

describe('WORKER_VERSION', () => {
  it('is the dev placeholder under vitest', () => {
    expect(WORKER_VERSION).toBe('0.0.0-dev');
  });
});

describe('isEntrypoint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-entry-'));
  const file = join(dir, 'Entry.mjs');
  writeFileSync(file, '');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const url = pathToFileURL(file).href;

  it('follows a symlink to the real file', () => {
    if (process.platform === 'win32') return;
    const link = join(dir, 'link.mjs');
    symlinkSync(file, link);
    expect(isEntrypoint(url, link)).toBe(true);
  });

  it('ignores path casing only on win32', () => {
    const swapped = join(dir, 'entry.mjs');
    expect(isEntrypoint(url, swapped, 'win32')).toBe(true);
    expect(isEntrypoint(url, swapped, 'linux')).toBe(false);
  });

  it('is false for a malformed or non-file url', () => {
    expect(isEntrypoint('not a url', '/x')).toBe(false);
    expect(isEntrypoint('https://h/x.mjs', '/x')).toBe(false);
  });

  it('is false without argv1', () => {
    expect(isEntrypoint(url, undefined)).toBe(false);
    expect(isEntrypoint(url, '')).toBe(false);
  });
});

/** Stands in for the bundle `start -d` re-runs: records what it got, then writes its pid file. */
const FAKE_WORKER = `
import { writeFileSync } from 'node:fs';
const env = process.env;
writeFileSync(env.FAKE_INFO_FILE, JSON.stringify({
  pid: process.pid,
  argv: process.argv.slice(2),
  daemon: env.CORTEX_WORKER_DAEMON ?? null,
  apiKey: env.CORTEX_API_KEY ?? null,
}));
writeFileSync(env.FAKE_PID_FILE, process.pid + '\\n');
setInterval(() => {}, 1000);
`;

const SHEBANG = '#!/usr/bin/env node';

describe('main', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'cw-main-')));
  const savedArgv = [...process.argv];
  const strays: number[] = [];
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  afterEach(() => {
    vi.restoreAllMocks();
    process.argv.splice(0, process.argv.length, ...savedArgv);
    for (const pid of strays.splice(0)) {
      for (const target of process.platform === 'win32' ? [pid] : [-pid, pid]) {
        try {
          process.kill(target, 'SIGKILL');
        } catch {
          // gone already
        }
      }
    }
  });

  /** Points process.argv[1], the default script path, at `file`. */
  const runAs = (file: string): void => {
    process.argv.splice(1, 1, file);
  };

  const quiet = (): { log: ReturnType<typeof vi.spyOn>; err: ReturnType<typeof vi.spyOn> } => ({
    log: vi.spyOn(console, 'log').mockImplementation(() => undefined),
    err: vi.spyOn(console, 'error').mockImplementation(() => undefined),
  });

  it('returns 2 for unknown commands and 0 for --version', async () => {
    const { log } = quiet();
    expect(await main(['bogus'], { homeDir: home, env: {} })).toBe(2);
    expect(await main(['--version'], { homeDir: home, env: {} })).toBe(0);
    expect(log).toHaveBeenCalledWith('0.0.0-dev');
  });

  it('hub-url prints only the hub base, and fails without one', async () => {
    const { log, err } = quiet();
    expect(await main(['hub-url'], { homeDir: home, env: { CORTEX_HUB_URL: 'https://h.example/mcp' } })).toBe(0);
    expect(log.mock.calls).toEqual([['https://h.example']]);
    expect(await main(['hub-url'], { homeDir: home, env: {} })).toBe(1);
    expect(String(err.mock.calls[0]?.[0])).toMatch(/--hub/);
  });

  it('doctor prints the checks and exits 1 when a required one fails', async () => {
    const { log } = quiet();
    const code = await main(['doctor'], {
      homeDir: home,
      env: {},
      cwd: home,
      doctor: { adapters: [], engines: [], gitVersion: async () => 'git version x', gh: async () => ({ code: 0, stdout: '', stderr: '' }) },
    });
    expect(code).toBe(1);
    const out = String(log.mock.calls[0]?.[0]);
    expect(out).toContain('✗ hub config');
    expect(out).toContain('✓ git — git version x');
  });

  it('help gives the stop grace period from the constant stop uses', async () => {
    const { log } = quiet();
    expect(await main(['help'], { homeDir: home, env: {} })).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain(`waits up to ${DEFAULT_STOP_GRACE_MS / 1000} s`);
  });

  it('start -d re-runs process.argv[1] detached, without the daemon flag or the key in its argv', async () => {
    const { log, err } = quiet();
    const dir = mkdtempSync(join(home, 'daemon-'));
    const script = join(dir, 'fake-worker.mjs');
    writeFileSync(script, FAKE_WORKER);
    const info = join(dir, 'info.json');
    const paths = workerPaths('m1', home);
    runAs(script);
    const code = await main(['start', '-d', '--agent-id', 'm1', '--api-key', 'k-sekrit', '--engines=claude'], {
      homeDir: home,
      env: { PATH: process.env.PATH, FAKE_INFO_FILE: info, FAKE_PID_FILE: paths.pidFile },
    });
    expect(err.mock.calls).toEqual([]);
    expect(code).toBe(0);
    const got = JSON.parse(readFileSync(info, 'utf8')) as { pid: number };
    strays.push(got.pid);
    expect(got).toEqual({
      pid: got.pid,
      argv: ['start', '--agent-id', 'm1', '--engines=claude'],
      daemon: '1',
      apiKey: 'k-sekrit',
    });
    expect(isAlive(got.pid)).toBe(true);
    expect(log.mock.calls).toEqual([
      [`cortex-worker started in the background (pid ${got.pid})`],
      [`log: ${paths.logFile}`],
    ]);
  });

  posixOnly('update replaces the real file behind process.argv[1] with the bundle of the detected hub', async () => {
    const { log, err } = quiet();
    const dir = mkdtempSync(join(home, 'update-'));
    const real = join(dir, 'lib', 'cortex-worker.mjs');
    mkdirSync(join(dir, 'lib'));
    writeFileSync(real, `${SHEBANG}\nconsole.log('old');\n`, { mode: 0o755 });
    const link = join(dir, 'cortex-worker');
    symlinkSync(real, link);
    runAs(link);
    const NEW = `${SHEBANG}\nconsole.log('new');\n`;
    const urls: string[] = [];
    const fetchStub = ((input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      urls.push(url);
      if (url.endsWith('/conductor/worker.version')) return Promise.resolve(new Response('9.9.9\n'));
      if (url.endsWith('/conductor/worker.mjs')) return Promise.resolve(new Response(NEW));
      return Promise.resolve(new Response('not found', { status: 404 }));
    }) as typeof fetch;
    const code = await main(['update'], {
      homeDir: home,
      cwd: dir,
      env: { CORTEX_HUB_URL: 'https://hub.example/mcp' },
      fetch: fetchStub,
    });
    expect(err.mock.calls).toEqual([]);
    expect(code).toBe(0);
    // detectHubBase turned the MCP url into the hub base
    expect(urls).toEqual(['https://hub.example/conductor/worker.version', 'https://hub.example/conductor/worker.mjs']);
    expect(readFileSync(real, 'utf8')).toBe(NEW);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(log.mock.calls).toEqual([[`updated ${real} to v9.9.9; restart the worker to use v9.9.9`]]);
  });

  it('logs -f follows the log until SIGINT aborts it, then lets go of the signals', async () => {
    const paths = workerPaths('l1', home);
    mkdirSync(paths.home, { recursive: true });
    writeFileSync(paths.logFile, 'first line\n');
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stdout.write);
    const signals = new EventEmitter();
    const done = main(['logs', '-f', '--agent-id', 'l1'], { homeDir: home, env: {}, signals });
    await until(() => chunks.join('').includes('first line\n'), 'the tail');
    expect(signals.listenerCount('SIGINT')).toBe(1);
    expect(signals.listenerCount('SIGTERM')).toBe(1);
    appendFileSync(paths.logFile, 'second line\n');
    await until(() => chunks.join('').includes('second line\n'), 'the appended line');
    signals.emit('SIGINT');
    expect(await Promise.race([done, sleep(2000).then(() => 'still following')])).toBe(0);
    expect(signals.listenerCount('SIGINT') + signals.listenerCount('SIGTERM')).toBe(0);
  });

  it('stop and status find the worker by the same agent id as start', async () => {
    const { log } = quiet();
    const opts = { homeDir: home, env: {}, hostname: 'Box', cwd: '/x/my-repo' };
    expect(await main(['stop'], opts)).toBe(0);
    expect(String(log.mock.calls.at(-1)?.[0])).toMatch(/box-my-repo is not running/);
    expect(await main(['status', '--agent-id', 'w1'], opts)).toBe(0);
    expect(String(log.mock.calls.at(-1)?.[0])).toContain(workerPaths('w1', home).logFile);
  });
});
