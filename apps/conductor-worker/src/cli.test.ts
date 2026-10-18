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
import { saveStartConfig } from './commands/agents.js';
import type { StartConfig } from './commands/agents.js';
import { DEFAULT_STOP_GRACE_MS, isAlive } from './commands/daemon.js';
import { workerPaths, workerRoot } from './paths.js';
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
      all: false,
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
    for (const c of ['stop', 'restart', 'status', 'ls', 'update', 'hub-url'] as const) {
      expect(parseCli([c])).toMatchObject({ command: c, daemon: false, follow: false, probe: false, all: false });
    }
  });

  it('rejects unknown options, a missing value and extra arguments', () => {
    expect(parseCli(['start', '--bogus'])).toEqual({ error: expect.stringMatching(/bogus/) });
    expect(parseCli(['start', '--agent-id'])).toEqual({ error: expect.stringMatching(/agent-id/) });
    expect(parseCli(['start', 'a', 'extra'])).toEqual({ error: expect.stringMatching(/unexpected argument: extra/) });
  });

  it('takes the agent after the command: a name for start, a name or number for the rest', () => {
    expect(parseCli(['start', 'acme', '-d'])).toMatchObject({ command: 'start', agentId: 'acme', daemon: true });
    expect(parseCli(['logs', '2', '-f'])).toMatchObject({ command: 'logs', agent: '2', follow: true });
    expect(parseCli(['logs', '2'])).not.toHaveProperty('agentId');
    for (const c of ['stop', 'restart', 'status', 'doctor'] as const) {
      expect(parseCli([c, 'acme'])).toMatchObject({ command: c, agent: 'acme' });
    }
  });

  it('rejects an agent where none fits, one given twice, or a number for start', () => {
    for (const c of ['ls', 'update', 'hub-url']) {
      expect(parseCli([c, 'x'])).toEqual({ error: expect.stringMatching(/unexpected argument: x/) });
    }
    expect(parseCli(['logs', 'a', '--agent-id', 'b'])).toEqual({ error: expect.stringMatching(/agent once/) });
    expect(parseCli(['start', '2'])).toEqual({ error: expect.stringMatching(/cw restart 2/) });
  });

  it('takes --all for stop and restart only, and not with an agent', () => {
    expect(parseCli(['stop', '--all'])).toMatchObject({ command: 'stop', all: true });
    expect(parseCli(['restart', '--all'])).toMatchObject({ command: 'restart', all: true });
    expect(parseCli(['logs', '--all'])).toEqual({ error: expect.stringMatching(/--all works with stop and restart/) });
    expect(parseCli(['stop', '2', '--all'])).toEqual({ error: expect.stringMatching(/not both/) });
    expect(parseCli(['stop', '--all', '--agent-id', 'a'])).toEqual({ error: expect.stringMatching(/not both/) });
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
  const base = { command: 'status', daemon: false, follow: false, probe: false, all: false } as const;

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

/** Stands in for a background worker: records how it was started, then runs until its stop file appears. */
const FAKE_AGENT = `
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const argv = process.argv.slice(2);
const home = join(process.env.FAKE_ROOT, argv[argv.indexOf('--agent-id') + 1]);
mkdirSync(home, { recursive: true });
writeFileSync(join(home, 'info.json'), JSON.stringify({
  pid: process.pid,
  argv,
  apiKey: process.env.CORTEX_API_KEY ?? null,
  setup: process.env.CORTEX_SETUP_CMD ?? null,
}));
writeFileSync(join(home, 'worker.pid'), process.pid + '\\n');
const timer = setInterval(() => {
  if (!existsSync(join(home, 'worker.stop'))) return;
  clearInterval(timer);
  rmSync(join(home, 'worker.pid'), { force: true });
  process.exit(0);
}, 20);
`;

describe('main', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'cw-main-')));
  const savedArgv = [...process.argv];
  const strays: number[] = [];
  const homes: string[] = [home];
  /** A home of its own, for a test that must not see the agents the others leave behind. */
  const freshHome = (): string => {
    const h = realpathSync(mkdtempSync(join(tmpdir(), 'cw-main-')));
    homes.push(h);
    return h;
  };
  afterAll(() => {
    for (const h of homes) rmSync(h, { recursive: true, force: true });
  });
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
    expect(String(log.mock.calls[0]?.[0])).toContain('cw logs 2 -f');
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
      ['see it: cw status m1    follow its log: cw logs m1 -f'],
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
    const opts = { homeDir: freshHome(), env: {}, hostname: 'Box', cwd: '/x/my-repo' };
    expect(await main(['stop'], opts)).toBe(0);
    expect(String(log.mock.calls.at(-1)?.[0])).toMatch(/box-my-repo is not running/);
    expect(await main(['status', '--agent-id', 'w1'], opts)).toBe(0);
    expect(String(log.mock.calls.at(-1)?.[0])).toContain(workerPaths('w1', opts.homeDir).logFile);
  });

  describe('agents by number', () => {
    const saveAgent = (h: string, id: string, extra: Partial<StartConfig> = {}): void =>
      saveStartConfig(workerPaths(id, h).startFile, {
        agentId: id,
        repo: `/src/${id}`,
        hub: 'https://hub.example',
        engines: ['claude'],
        capabilities: [],
        engineTimeoutMin: 90,
        env: {},
        ...extra,
      });
    const logOnly = (h: string, id: string, text = ''): void => {
      const p = workerPaths(id, h);
      mkdirSync(p.home, { recursive: true });
      writeFileSync(p.logFile, text);
    };
    const stdout = (): string[] => {
      const chunks: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
        chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      }) as typeof process.stdout.write);
      return chunks;
    };
    interface FakeInfo {
      pid: number;
      argv: string[];
      apiKey: string | null;
      setup: string | null;
    }
    const fakeAgent = (h: string): { script: string; env: NodeJS.ProcessEnv; info: (id: string) => FakeInfo } => {
      const script = join(h, 'fake-agent.mjs');
      writeFileSync(script, FAKE_AGENT);
      return {
        script,
        env: { PATH: process.env.PATH, FAKE_ROOT: workerRoot(h), CORTEX_API_KEY: 'other', CORTEX_SETUP_CMD: 'npm ci' },
        info: (id) => {
          const got = JSON.parse(readFileSync(join(workerRoot(h), id, 'info.json'), 'utf8')) as FakeInfo;
          strays.push(got.pid);
          return got;
        },
      };
    };

    it('ls and status without an agent print the numbered list and what to do with it', async () => {
      const { log } = quiet();
      const h = freshHome();
      expect(await main(['ls'], { homeDir: h, env: {} })).toBe(0);
      expect(String(log.mock.calls.at(-1)?.[0])).toMatch(/no agents on this machine yet/);
      saveAgent(h, 'acme');
      logOnly(h, 'mini');
      for (const cmd of ['ls', 'status']) {
        expect(await main([cmd], { homeDir: h, env: {} })).toBe(0);
        const lines = String(log.mock.calls.at(-1)?.[0]).split('\n');
        expect(lines[0]).toMatch(/^#\s+AGENT\s+STATE/);
        expect(lines[1]).toMatch(/^1\s+acme\s+stopped\s+-\s+claude\s+\/src\/acme$/);
        expect(lines[2]).toMatch(/^2\s+mini\s+stopped/);
        expect(lines).toContain('cw logs <#|name> -f    follow its log (Ctrl+C to quit)');
      }
      expect(await main(['status', '2'], { homeDir: h, env: {} })).toBe(0);
      expect(String(log.mock.calls.at(-1)?.[0])).toMatch(/^agent id:\s+mini$/m);
    });

    it('logs takes the number from the list, and asks which agent when there are several', async () => {
      const { err } = quiet();
      const h = freshHome();
      logOnly(h, 'acme', 'acme line\n');
      logOnly(h, 'mini', 'mini line\n');
      const out = stdout();
      expect(await main(['logs', '2'], { homeDir: h, env: {} })).toBe(0);
      expect(out.join('')).toContain('mini line');
      expect(out.join('')).not.toContain('acme line');

      expect(await main(['logs'], { homeDir: h, env: {}, hostname: 'box', cwd: '/x/repo' })).toBe(1);
      const asked = String(err.mock.calls.at(-1)?.[0]);
      expect(asked).toMatch(/^2\s+mini/m);
      expect(asked).toContain('which agent? cw logs <#|name>');

      expect(await main(['logs', '3'], { homeDir: h, env: {} })).toBe(1);
      expect(String(err.mock.calls.at(-1)?.[0])).toMatch(/no agent number 3/);
    });

    it('logs without an agent takes the only one', async () => {
      quiet();
      const h = freshHome();
      logOnly(h, 'solo', 'solo line\n');
      const out = stdout();
      expect(await main(['logs'], { homeDir: h, env: {}, hostname: 'box', cwd: '/x/repo' })).toBe(0);
      expect(out.join('')).toContain('solo line');
    });

    it('restart runs a stopped agent again with its saved settings and key, and a running one after stopping it', async () => {
      const { log, err } = quiet();
      const h = freshHome();
      const fake = fakeAgent(h);
      saveAgent(h, 'acme', { apiKey: 'k-sekrit', capabilities: ['web'], env: { CORTEX_SETUP_CMD: 'pnpm install' } });
      const opts = { homeDir: h, env: fake.env, scriptPath: fake.script };

      expect(await main(['restart', '1'], opts)).toBe(0);
      expect(err.mock.calls).toEqual([]);
      const first = fake.info('acme');
      expect(first).toEqual({
        pid: first.pid,
        argv: [
          'start',
          '--agent-id', 'acme',
          '--repo', '/src/acme',
          '--hub', 'https://hub.example',
          '--engines', 'claude',
          '--engine-timeout', '90',
          '--capabilities', 'web',
        ],
        apiKey: 'k-sekrit',
        setup: 'pnpm install',
      });
      expect(log.mock.calls.at(-1)).toEqual([`acme started in the background (pid ${first.pid})`]);

      expect(await main(['restart', 'acme'], opts)).toBe(0);
      expect(log.mock.calls.flat()).toContainEqual(expect.stringMatching(/^stopping acme; a running task gets up to/));
      const second = fake.info('acme');
      expect(second.pid).not.toBe(first.pid);
      expect(isAlive(first.pid)).toBe(false);
    });

    it('restart says how to save the settings of an agent that has none', async () => {
      const { err } = quiet();
      const h = freshHome();
      logOnly(h, 'mini');
      expect(await main(['restart', 'mini'], { homeDir: h, env: {}, scriptPath: join(h, 'none.mjs') })).toBe(1);
      expect(String(err.mock.calls.at(-1)?.[0])).toMatch(/mini has no saved start settings yet: start it once with cw start mini -d/);
    });

    it('restart --all skips the agents without settings, and stop --all stops every running one', async () => {
      const { log } = quiet();
      const h = freshHome();
      const fake = fakeAgent(h);
      saveAgent(h, 'acme');
      saveAgent(h, 'beta');
      logOnly(h, 'mini');
      const opts = { homeDir: h, env: fake.env, scriptPath: fake.script };

      expect(await main(['restart', '--all'], opts)).toBe(0);
      const pids = [fake.info('acme').pid, fake.info('beta').pid];
      const said = log.mock.calls.flat().map(String);
      expect(said).toContainEqual(expect.stringMatching(/^skipping mini: no saved start settings yet/));
      expect(said).toContain(`acme started in the background (pid ${pids[0]})`);
      expect(said).toContain(`beta started in the background (pid ${pids[1]})`);

      expect(await main(['stop', '--all'], opts)).toBe(0);
      expect(log.mock.calls.flat().map(String).slice(-2)).toEqual(['acme stopped', 'beta stopped']);
      for (const pid of pids) expect(isAlive(pid)).toBe(false);
      expect(await main(['stop', '--all'], opts)).toBe(0);
      expect(log.mock.calls.at(-1)).toEqual(['no agent is running']);
    });
  });
});
