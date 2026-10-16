import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { envWithoutSecret, isEntrypoint, main, parseCli, resolveAgentId } from './cli.js';
import { workerPaths } from './paths.js';
import { WORKER_VERSION } from './version.js';

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
  it('drops every entry whose value contains the secret, whatever its name', () => {
    const env = {
      PATH: '/bin',
      CORTEX_API_KEY: 'sk-123',
      MY_TOKEN: 'sk-123',
      HEADERS: 'Authorization: Bearer sk-123',
      OTHER: 'sk-12',
      EMPTY: undefined,
    };
    expect(envWithoutSecret(env, 'sk-123')).toEqual({ PATH: '/bin', OTHER: 'sk-12', EMPTY: undefined });
    expect(env.CORTEX_API_KEY).toBe('sk-123');
  });

  it('keeps everything for an empty secret', () => {
    expect(envWithoutSecret({ A: 'x' }, '')).toEqual({ A: 'x' });
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

describe('main', () => {
  const home = mkdtempSync(join(tmpdir(), 'cw-main-'));
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  afterEach(() => vi.restoreAllMocks());

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

  it('doctor is not implemented yet', async () => {
    const { err } = quiet();
    expect(await main(['doctor', '--probe'], { homeDir: home, env: {} })).toBe(1);
    expect(err).toHaveBeenCalledWith('doctor: not implemented yet');
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
