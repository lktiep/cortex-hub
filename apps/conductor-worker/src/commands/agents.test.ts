import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { workerPaths, workerRoot } from '../paths.js';
import {
  REMEMBERED_ENV,
  formatAgentTable,
  listAgents,
  readStartConfig,
  rememberedEnv,
  resolveAgentRef,
  restartArgv,
  restartEnv,
  saveStartConfig,
} from './agents.js';
import type { StartConfig } from './agents.js';

const posixOnly = it.skipIf(process.platform === 'win32');
const KEY = 'k-sekrit';

const cfg = (over: Partial<StartConfig> = {}): StartConfig => ({
  agentId: 'acme-app',
  repo: '/src/app',
  hub: 'https://hub.example',
  apiKey: KEY,
  engines: ['agy', 'claude'],
  capabilities: [],
  engineTimeoutMin: 90,
  env: {},
  ...over,
});

describe('start settings', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'cw-agents-')));
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  posixOnly('are saved readable by the owner only, and read back as saved', () => {
    const file = join(home, 'a', 'start.json');
    const saved = cfg({ capabilities: ['web'], env: { CORTEX_SETUP_CMD: 'pnpm install' } });
    saveStartConfig(file, saved);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readStartConfig(file)).toEqual(saved);
  });

  it('keep no key when none was given to the worker itself', () => {
    const file = join(home, 'b', 'start.json');
    const { apiKey: _key, ...rest } = cfg();
    saveStartConfig(file, rest);
    expect(readFileSync(file, 'utf8')).not.toContain(KEY);
    expect(readStartConfig(file)).toEqual(rest);
  });

  it('read as null when missing, corrupt or malformed', () => {
    const dir = join(home, 'c');
    mkdirSync(dir, { recursive: true });
    expect(readStartConfig(join(dir, 'none.json'))).toBeNull();
    for (const [name, body] of [
      ['corrupt', '{"agentId": "a", '],
      ['array', '[]'],
      ['no-repo', JSON.stringify({ ...cfg(), repo: undefined })],
      ['bad-engine', JSON.stringify(cfg({ engines: ['cursor' as 'agy'] }))],
      ['no-engines', JSON.stringify(cfg({ engines: [] }))],
      ['bad-timeout', JSON.stringify(cfg({ engineTimeoutMin: -1 }))],
    ] as const) {
      const file = join(dir, `${name}.json`);
      writeFileSync(file, body);
      expect(readStartConfig(file), name).toBeNull();
    }
  });

  it('remember only the listed variables that are set', () => {
    expect(REMEMBERED_ENV).toContain('CORTEX_SETUP_CMD');
    expect(
      rememberedEnv({ CORTEX_SETUP_CMD: 'pnpm install', CORTEX_AGY_MODE: '', CORTEX_API_KEY: KEY, PATH: '/bin' }),
    ).toEqual({ CORTEX_SETUP_CMD: 'pnpm install' });
  });
});

describe('restart', () => {
  it('passes the saved settings as flags, the key never among them', () => {
    expect(restartArgv(cfg({ capabilities: ['web', 'gpu'], engineTimeoutMin: 30 }))).toEqual([
      '--agent-id', 'acme-app',
      '--repo', '/src/app',
      '--hub', 'https://hub.example',
      '--engines', 'agy,claude',
      '--engine-timeout', '30',
      '--capabilities', 'web,gpu',
    ]);
    expect(restartArgv(cfg())).not.toContain('--capabilities');
    expect(restartArgv(cfg()).join(' ')).not.toContain(KEY);
  });

  it('runs with the saved variables and key, not the ones of the shell restarting it', () => {
    const env = restartEnv(
      {
        PATH: '/bin',
        CORTEX_SETUP_CMD: 'npm ci',
        CORTEX_TEST_CMD: 'npm test',
        CORTEX_API_KEY: 'other',
        CORTEX_AGENT_ID: 'other',
        CORTEX_HUB_URL: 'https://other.example',
      },
      cfg({ env: { CORTEX_SETUP_CMD: 'pnpm install' } }),
    );
    expect(env).toEqual({ PATH: '/bin', CORTEX_SETUP_CMD: 'pnpm install', CORTEX_API_KEY: KEY });
  });

  it('leaves the key out when none was saved, so the MCP config supplies it again', () => {
    const { apiKey: _key, ...rest } = cfg();
    expect(restartEnv({ CORTEX_API_KEY: 'other' }, rest)).toEqual({});
  });
});

describe('listAgents', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'cw-list-')));
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  const make = (id: string, files: Record<string, string>): void => {
    const p = workerPaths(id, home);
    mkdirSync(p.home, { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(p.home, name), body);
  };

  it('is empty without a worker folder', () => {
    expect(listAgents(join(home, 'nowhere'))).toEqual([]);
  });

  it('numbers the agent folders by name and reads what each one is doing', () => {
    make('mini-b', { 'worker.log': 'x\n' });
    make('acme-app', {
      'start.json': JSON.stringify(cfg()),
      'state.json': JSON.stringify({ activeTaskId: 'task-1' }),
    });
    make('studio', { 'worker.pid': `${process.pid}\n` });
    mkdirSync(join(workerRoot(home), 'empty'));
    writeFileSync(join(workerRoot(home), 'cortex-worker.mjs'), '#!/usr/bin/env node\n');

    const agents = listAgents(home);
    expect(agents.map((a) => [a.no, a.id])).toEqual([
      [1, 'acme-app'],
      [2, 'mini-b'],
      [3, 'studio'],
    ]);
    expect(agents[0]).toMatchObject({ pid: null, activeTaskId: 'task-1', config: cfg() });
    expect(agents[1]).toMatchObject({ pid: null, activeTaskId: null, config: null });
    expect(agents[2]?.pid).toBe(process.pid);
    expect(agents[2]?.paths).toEqual(workerPaths('studio', home));
  });

  it('prints a numbered table without the key', () => {
    const table = formatAgentTable(listAgents(home));
    const lines = table.split('\n');
    expect(lines[0]).toMatch(/^#\s+AGENT\s+STATE\s+TASK\s+ENGINES\s+REPO$/);
    expect(lines[1]).toMatch(/^1\s+acme-app\s+stopped\s+task-1\s+agy,claude\s+\/src\/app$/);
    expect(lines[2]).toMatch(/^2\s+mini-b\s+stopped\s+-\s+-\s+-$/);
    expect(lines[3]).toMatch(new RegExp(`^3\\s+studio\\s+running \\(pid ${process.pid}\\)\\s+-`));
    expect(table).not.toContain(KEY);
  });

  it('says how to start one when there is none', () => {
    expect(formatAgentTable([])).toMatch(/no agents on this machine yet.*cw start <name>/);
  });

  it('takes a number from the list, or a name', () => {
    const agents = listAgents(home);
    expect(resolveAgentRef('2', agents)).toBe('mini-b');
    expect(resolveAgentRef('Studio', agents)).toBe('studio');
    expect(resolveAgentRef('new-one', agents)).toBe('new-one');
    expect(resolveAgentRef('4', agents)).toEqual({ error: expect.stringMatching(/no agent number 4.*cw ls/) });
    expect(resolveAgentRef('0', agents)).toEqual({ error: expect.stringMatching(/no agent number 0/) });
  });

  it('prefers an agent called by the number itself', () => {
    make('2', { 'worker.log': '' });
    expect(resolveAgentRef('2', listAgents(home))).toBe('2');
  });
});
