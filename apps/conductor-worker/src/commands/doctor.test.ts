import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Executor } from '@cortex/shared-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { Classification, EngineAdapter, RunInput } from '../engines/types.js';
import type { GhRun } from '../git.js';
import { workerPaths } from '../paths.js';
import { writeState } from '../state.js';
import { WORKER_VERSION } from '../version.js';
import { formatChecks, runDoctor } from './doctor.js';
import type { Check, DoctorContext } from './doctor.js';

const KEY = 'sk-doctor-secret-123';
let tmp: string;
let repo: string;
let home: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'doctor-'));
  repo = path.join(tmp, 'repo');
  home = path.join(tmp, 'home');
  mkdirSync(repo);
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'https://user:pw@git.example/acme/app.git'], { cwd: repo });
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function adapter(
  executor: Executor,
  o: { found?: boolean; classify?: Classification; run?: ReturnType<typeof vi.fn> } = {},
): EngineAdapter {
  const found = o.found ?? true;
  return {
    executor,
    detect: async () => (found ? { found, path: `/bin/${executor}`, version: '1.2.3' } : { found }),
    models: async () => [],
    defaultModel: () => 'm-default',
    buildArgs: () => ({ args: [] }),
    run:
      (o.run as EngineAdapter['run'] | undefined) ??
      (async () => ({ exitCode: 0, stdout: 'OK', stderr: '', timedOut: false, aborted: false })),
    classify: () => o.classify ?? { kind: 'ok' },
    progress: () => ({ line: () => [], errLine: () => [], end: () => [] }),
    summary: () => '',
  };
}

const okGh: GhRun = async () => ({ code: 0, stdout: 'Logged in', stderr: '' });
const okFetch = (version: string = WORKER_VERSION): typeof fetch =>
  (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/health')) return new Response('ok', { status: 200 });
    if (url.endsWith('/conductor/worker.version')) return new Response(version, { status: 200 });
    return new Response('', { status: 404 });
  }) as typeof fetch;

function ctx(over: Partial<DoctorContext> = {}): DoctorContext {
  return {
    nodeVersion: 'v22.1.0',
    repo,
    homeDir: home,
    env: {},
    flags: { hub: 'https://h.example', apiKey: KEY, agentId: 'agent-1' },
    engines: ['claude'],
    probe: false,
    fetchImpl: okFetch(),
    gh: okGh,
    adapters: [adapter('claude')],
    wsConnect: async () => 'open',
    ...over,
  };
}

const byName = (checks: Check[], name: string): Check => {
  const c = checks.find((x) => x.name === name);
  if (c === undefined) throw new Error(`no check ${name} in ${checks.map((x) => x.name).join(', ')}`);
  return c;
};

describe('runDoctor', () => {
  it('reports every check in order', async () => {
    const checks = await runDoctor(ctx());
    expect(checks.map((c) => c.name)).toEqual([
      'node',
      'git',
      'gh',
      'engine claude',
      'engines',
      'hub config',
      'hub health',
      'worker version',
      'handshake',
      'origin',
      'project mapping',
      'engine MCP configs',
    ]);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(byName(checks, 'engine claude').detail).toContain('1.2.3');
    expect(byName(checks, 'origin').detail).toBe('https://git.example/acme/app.git');
    expect(byName(checks, 'project mapping').detail).toContain('unknown until first start');
    expect(byName(checks, 'hub config').detail).toContain('--hub');
  });

  it('shows the project id once the worker has registered', async () => {
    writeState(workerPaths('agent-1', home).stateFile, {
      activeTaskId: null,
      unconfirmed: null,
      lastRegistered: { projectId: 'proj-9', hubVersion: '1', at: 'now' },
      engineGroup: null,
      notReady: null,
    });
    expect(byName(await runDoctor(ctx()), 'project mapping').detail).toContain('proj-9');
  });

  it('marks a missing engine with its install command', async () => {
    const checks = await runDoctor(ctx({ adapters: [adapter('claude', { found: false })] }));
    const c = byName(checks, 'engine claude');
    expect(c).toMatchObject({ ok: false, required: false, fix: 'npm install -g @anthropic-ai/claude-code' });
    expect(byName(checks, 'engines')).toMatchObject({ ok: false, required: true });
  });

  it('passes engines when one of several is found', async () => {
    const checks = await runDoctor(
      ctx({ engines: ['claude', 'codex'], adapters: [adapter('claude', { found: false }), adapter('codex')] }),
    );
    expect(byName(checks, 'engines').ok).toBe(true);
  });

  it('reports a 401 handshake as an invalid key', async () => {
    const checks = await runDoctor(ctx({ wsConnect: async () => 401 }));
    expect(byName(checks, 'handshake')).toMatchObject({ ok: false, required: true });
    expect(byName(checks, 'handshake').detail).toMatch(/rejected|invalid/i);
  });

  it('keeps the url and key out of a handshake error', async () => {
    const checks = await runDoctor(
      ctx({ wsConnect: async (url) => `boom ${url} ${KEY}` }),
    );
    const out = JSON.stringify(checks);
    expect(out).not.toContain(KEY);
    expect(out).not.toContain('apiKey=');
  });

  it('connects with a random doctor agent id, not the worker id', async () => {
    const urls: string[] = [];
    await runDoctor(
      ctx({
        wsConnect: async (url) => {
          urls.push(url);
          return 'open';
        },
      }),
    );
    const q = new URL(urls[0] ?? '').searchParams;
    expect(q.get('agentId')).toMatch(/^doctor-[0-9a-f]{6}$/);
    expect(q.get('apiKey')).toBe(KEY);
  });

  it('never sends worker.register', async () => {
    const messages: string[] = [];
    let opened = 0;
    let closeCode = 0;
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    wss.on('connection', (ws, req) => {
      opened++;
      expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
      ws.send('{"type":"welcome"}');
      ws.on('message', (d) => messages.push(String(d)));
      ws.on('close', (code) => {
        closeCode = code;
      });
    });
    try {
      await new Promise<void>((r) => wss.once('listening', () => r()));
      const port = (wss.address() as AddressInfo).port;
      const checks = await runDoctor(
        ctx({ wsConnect: undefined, env: { CORTEX_HUB_URL: `http://127.0.0.1:${port}` }, flags: { apiKey: KEY, agentId: 'a' } }),
      );
      expect(byName(checks, 'handshake').ok).toBe(true);
      await vi.waitFor(() => expect(closeCode).toBe(1000));
      expect(opened).toBe(1);
      expect(messages).toEqual([]);
    } finally {
      await new Promise<void>((r) => wss.close(() => r()));
    }
  });

  async function withServer<T>(
    onConn: (ws: WebSocket) => void,
    body: (hubUrl: string) => Promise<T>,
  ): Promise<T> {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    wss.on('connection', onConn);
    await new Promise<void>((r) => wss.once('listening', () => r()));
    try {
      return await body(`http://127.0.0.1:${(wss.address() as AddressInfo).port}`);
    } finally {
      await new Promise<void>((r) => wss.close(() => r()));
    }
  }
  const real = (hubUrl: string): Partial<DoctorContext> => ({
    wsConnect: undefined,
    env: { CORTEX_HUB_URL: hubUrl },
    flags: { apiKey: KEY, agentId: 'a' },
  });

  it('a close before the welcome fails the handshake with its code', async () => {
    await withServer(
      (ws) => ws.close(4003, 'forbidden'),
      async (hubUrl) => {
        const checks = await runDoctor(ctx(real(hubUrl)));
        const h = byName(checks, 'handshake');
        expect(h.ok).toBe(false);
        expect(h.detail).toContain('closed 4003');
        expect(JSON.stringify(checks)).not.toContain(KEY);
      },
    );
  });

  it('a welcome passes the handshake; doctor closes with 1000 and sends nothing', async () => {
    const messages: string[] = [];
    let closeCode = 0;
    await withServer(
      (ws) => {
        ws.on('message', (d) => messages.push(String(d)));
        ws.on('close', (c) => {
          closeCode = c;
        });
        ws.send('{"type":"welcome"}');
      },
      async (hubUrl) => {
        expect(byName(await runDoctor(ctx(real(hubUrl))), 'handshake').ok).toBe(true);
        await vi.waitFor(() => expect(closeCode).toBe(1000));
        expect(messages).toEqual([]);
      },
    );
  });

  it('another first message fails the handshake without echoing it', async () => {
    await withServer(
      (ws) => ws.send(`{"type":"nope","secret":"${KEY}"}`),
      async (hubUrl) => {
        const checks = await runDoctor(ctx(real(hubUrl)));
        expect(byName(checks, 'handshake').detail).toContain('unexpected first message');
        expect(JSON.stringify(checks)).not.toContain(KEY);
      },
    );
  });

  it('keeps the key out of a close reason', async () => {
    await withServer(
      (ws) => ws.close(4003, `bad ${KEY}`),
      async (hubUrl) => {
        const checks = await runDoctor(ctx(real(hubUrl)));
        expect(byName(checks, 'handshake').ok).toBe(false);
        expect(JSON.stringify(checks)).not.toContain(KEY);
        expect(formatChecks(checks)).not.toContain(KEY);
      },
    );
  });

  it('warns when an engine MCP config points at another hub', async () => {
    mkdirSync(path.join(home, '.gemini', 'antigravity'), { recursive: true });
    writeFileSync(
      path.join(home, '.gemini', 'antigravity', 'mcp_config.json'),
      JSON.stringify({ mcpServers: { 'cortex-hub': { serverUrl: 'https://old.example/mcp', headers: { Authorization: `Bearer ${KEY}` } } } }),
    );
    const checks = await runDoctor(ctx({ engines: ['agy'], adapters: [adapter('agy')] }));
    const c = byName(checks, 'engine MCP configs');
    expect(c).toMatchObject({ ok: false, required: false });
    expect(c.detail).toContain("agy's MCP points at https://old.example");
    expect(c.detail).toContain('tasks it runs will report to that hub');
    expect(c.fix).toContain('mcp_config.json');
    expect(JSON.stringify(checks)).not.toContain(KEY);
    expect(formatChecks(checks)).not.toContain(KEY);
  });

  it('checks the Antigravity 2.x MCP config in ~/.gemini/config', async () => {
    mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
    writeFileSync(
      path.join(home, '.gemini', 'config', 'mcp_config.json'),
      JSON.stringify({ mcpServers: { 'cortex-hub': { serverUrl: 'https://old.example/mcp' } } }),
    );
    const c = byName(await runDoctor(ctx({ engines: ['agy'], adapters: [adapter('agy')] })), 'engine MCP configs');
    expect(c.detail).toContain("agy's MCP points at https://old.example");
    expect(c.fix).toContain(path.join('.gemini', 'config', 'mcp_config.json'));
  });

  it('accepts an MCP config that points at the same hub', async () => {
    writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { 'cortex-hub': { url: 'https://h.example/mcp' } } }),
    );
    expect(byName(await runDoctor(ctx()), 'engine MCP configs').ok).toBe(true);
  });

  it('version mismatch suggests update', async () => {
    const checks = await runDoctor(ctx({ fetchImpl: okFetch('9.9.9') }));
    const c = byName(checks, 'worker version');
    expect(c).toMatchObject({ ok: false, required: false, fix: 'cortex-worker update' });
    expect(c.detail).toContain('9.9.9');
  });

  it('exit semantics: a required failure is visible, a gh failure is not required', async () => {
    const ghFail: GhRun = async () => ({ code: 1, stdout: '', stderr: 'not logged in' });
    const onlyGh = await runDoctor(ctx({ gh: ghFail }));
    expect(onlyGh.filter((c) => !c.ok && c.required)).toEqual([]);
    expect(byName(onlyGh, 'gh')).toMatchObject({ ok: false, required: false });

    const badHealth = await runDoctor(ctx({ fetchImpl: (async () => new Response('', { status: 503 })) as typeof fetch }));
    expect(byName(badHealth, 'hub health')).toMatchObject({ ok: false, required: true });
  });

  it('skips checks that depend on a missing hub config, keeping order', async () => {
    const fetchImpl = vi.fn(okFetch());
    const wsConnect = vi.fn(async () => 'open' as const);
    const checks = await runDoctor(ctx({ flags: { agentId: 'a' }, fetchImpl, wsConnect }));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(wsConnect).not.toHaveBeenCalled();
    expect(byName(checks, 'hub config')).toMatchObject({ ok: false, required: true });
    for (const n of ['hub health', 'worker version', 'handshake']) {
      expect(byName(checks, n).ok).toBe(false);
      expect(byName(checks, n).detail).toMatch(/^skipped — /);
    }
    expect(byName(checks, 'hub health').required).toBe(true);
    expect(byName(checks, 'worker version').required).toBe(false);
  });

  it('fails the origin check and skips the project mapping without an origin', async () => {
    execFileSync('git', ['remote', 'remove', 'origin'], { cwd: repo });
    const checks = await runDoctor(ctx());
    expect(byName(checks, 'origin')).toMatchObject({ ok: false, required: true });
    expect(byName(checks, 'project mapping').detail).toMatch(/^skipped — /);
  });

  it('fails node below 20', async () => {
    expect(byName(await runDoctor(ctx({ nodeVersion: 'v18.19.0' })), 'node')).toMatchObject({ ok: false, required: true });
  });

  it('does not run a probe unless --probe', async () => {
    const run = vi.fn(async (_input: RunInput) => ({ exitCode: 0, stdout: 'OK', stderr: '', timedOut: false, aborted: false }));
    await runDoctor(ctx({ adapters: [adapter('claude', { run })] }));
    expect(run).not.toHaveBeenCalled();
    await runDoctor(ctx({ adapters: [adapter('claude', { run })], probe: true }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      prompt: 'Reply with OK',
      cwd: repo,
      model: 'm-default',
      effort: null,
      timeoutMs: 120_000,
    });
  });

  it('a probe that hits quota or an error makes the engine unusable', async () => {
    const quota = await runDoctor(
      ctx({ probe: true, adapters: [adapter('claude', { classify: { kind: 'quota', resetAt: '2026-10-17T10:00:00Z', raw: 'x' } })] }),
    );
    expect(byName(quota, 'engine claude').ok).toBe(false);
    expect(byName(quota, 'engine claude').detail).toContain('2026-10-17T10:00:00Z');
    expect(byName(quota, 'engines').ok).toBe(false);

    const err = await runDoctor(
      ctx({ probe: true, adapters: [adapter('claude', { classify: { kind: 'error', message: `not logged in ${KEY}` } })] }),
    );
    expect(byName(err, 'engine claude').detail).toContain('not logged in');
    expect(JSON.stringify(err)).not.toContain(KEY);
    expect(byName(err, 'engines').ok).toBe(false);
  });

  it('a timed-out probe is unusable whatever classify says', async () => {
    const run = vi.fn(async (_input: RunInput) => ({ exitCode: 0, stdout: 'OK', stderr: '', timedOut: true, aborted: false }));
    const checks = await runDoctor(ctx({ probe: true, adapters: [adapter('claude', { run })] }));
    expect(byName(checks, 'engine claude')).toMatchObject({ ok: false });
    expect(byName(checks, 'engine claude').detail).toContain('probe timed out after 120 s');
    expect(byName(checks, 'engines').ok).toBe(false);
  });

  it('does not probe an engine that was not found', async () => {
    const run = vi.fn(async (_input: RunInput) => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, aborted: false }));
    await runDoctor(ctx({ probe: true, adapters: [adapter('claude', { found: false, run })] }));
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps the engine order when the first one is slower', async () => {
    const slow = adapter('claude');
    const slowDetect = slow.detect;
    slow.detect = async () => {
      await new Promise((r) => setTimeout(r, 50));
      return slowDetect();
    };
    const checks = await runDoctor(ctx({ engines: ['claude', 'codex'], adapters: [slow, adapter('codex')] }));
    expect(checks.map((c) => c.name).filter((n) => /^engine \w+$/.test(n) && n !== 'engines')).toEqual(['engine claude', 'engine codex']);
  });

  it('a throwing probe is reported, not thrown', async () => {
    const run = vi.fn(async () => {
      throw new Error('spawn failed');
    });
    const checks = await runDoctor(ctx({ probe: true, adapters: [adapter('claude', { run })] }));
    expect(byName(checks, 'engine claude')).toMatchObject({ ok: false });
  });
});

describe('formatChecks', () => {
  it('prints a tick or cross, and the fix on its own line', () => {
    expect(
      formatChecks([
        { name: 'a', ok: true, required: true, detail: 'fine' },
        { name: 'b', ok: false, required: true, detail: 'bad', fix: 'do x' },
      ]),
    ).toBe('✓ a — fine\n✗ b — bad\n    fix: do x');
  });
});
