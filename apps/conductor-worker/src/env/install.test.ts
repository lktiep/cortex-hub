import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installArgv, installHint, planInstall, runInstall, SHIM_MARK } from './install.js';
import type { InstallDeps } from './install.js';
import type { Problem } from './probe.js';

const missing = (tool: string, extra: Partial<Problem> = {}): Problem => ({
  tool,
  kind: 'missing',
  required: true,
  detail: 'not found',
  fix: '',
  ...extra,
});

describe('installArgv and installHint', () => {
  it('uses winget on Windows, brew on a Mac, npm for package managers and engines', () => {
    expect(installArgv('git', 'win32')).toEqual(['winget', 'install', '-e', '--id', 'Git.Git', '--accept-source-agreements', '--accept-package-agreements']);
    expect(installArgv('docker', 'darwin')).toEqual(['brew', 'install', '--cask', 'docker']);
    expect(installArgv('pnpm', 'linux', '9.12.0')).toEqual(['npm', 'install', '-g', 'pnpm@9.12.0']);
    expect(installArgv('yarn', 'win32')).toEqual(['npm', 'install', '-g', 'yarn']);
    expect(installArgv('codex', 'darwin')).toEqual(['npm', 'install', '-g', '@openai/codex']);
    expect(installArgv('git', 'linux')).toBeNull();
    expect(installArgv('agy', 'darwin')).toBeNull();
  });

  it('falls back to a link or a plain sentence', () => {
    expect(installHint('docker', 'linux')).toBe('https://docs.docker.com/engine/install/');
    expect(installHint('make', 'win32')).toBe('install make and put it on PATH');
  });
});

describe('planInstall', () => {
  it('installs system packages first, then npm ones; leaves hints alone', () => {
    const steps = planInstall(
      [
        missing('pnpm', { version: '9.12.0' }),
        missing('git'),
        { ...missing('node'), kind: 'version' },
        { ...missing('docker'), kind: 'not-running' },
        { ...missing('gh'), kind: 'not-logged-in', required: false },
        { ...missing('yarn'), kind: 'version', version: '4.5.0' },
        missing('claude'),
        missing('engine'),
      ],
      'darwin',
      '/home/u',
    );
    expect(steps).toEqual([
      { tool: 'git', argv: ['brew', 'install', 'git'] },
      { tool: 'pnpm', argv: ['npm', 'install', '-g', 'pnpm@9.12.0'] },
      { tool: 'yarn', argv: ['npm', 'install', '-g', 'yarn@4.5.0'] },
      { tool: 'claude', argv: ['npm', 'install', '-g', '@anthropic-ai/claude-code'] },
    ]);
  });

  it('on Windows, installs Python only when there is none, and always adds python3 last', () => {
    const shim = { tool: 'python3', shimDir: path.join('/home/u', '.local', 'bin') };
    expect(planInstall([missing('python3', { realPython: 'C:\\Py\\python.exe' }), missing('gh')], 'win32', '/home/u')).toEqual([
      { tool: 'gh', argv: expect.arrayContaining(['GitHub.cli']) as string[] },
      shim,
    ]);
    expect(planInstall([missing('python3')], 'win32', '/home/u')).toEqual([
      { tool: 'python3', argv: expect.arrayContaining(['Python.Python.3.12']) as string[] },
      shim,
    ]);
  });
});

describe('runInstall', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'cortex-install-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function deps(over: Partial<InstallDeps> = {}): InstallDeps & { ran: string[] } {
    const ran: string[] = [];
    return {
      ran,
      platform: 'darwin',
      resolve: (n) => (n === 'brew' || n === 'npm' ? `/fake/${n}` : null),
      spawnInherit: (cmd, args) => {
        ran.push([cmd, ...args].join(' '));
        return Promise.resolve(args.includes('broken') ? 1 : 0);
      },
      findPython: () => Promise.resolve(null),
      ...over,
    };
  }

  it('runs each step, goes on past a failure, and names a missing installer', async () => {
    const d = deps();
    const lines: string[] = [];
    const results = await runInstall(
      [
        { tool: 'gh', argv: ['winget', 'install', 'gh'] },
        { tool: 'broken', argv: ['brew', 'install', 'broken'] },
        { tool: 'pnpm', argv: ['npm', 'install', '-g', 'pnpm'] },
      ],
      d,
      (l) => lines.push(l),
    );
    expect(d.ran).toEqual(['/fake/brew install broken', '/fake/npm install -g pnpm']);
    expect(results).toEqual([
      { tool: 'gh', what: 'winget install gh', ok: false, detail: 'winget is missing: install "App Installer" from the Microsoft Store' },
      { tool: 'broken', what: 'brew install broken', ok: false, detail: 'exit code 1' },
      { tool: 'pnpm', what: 'npm install -g pnpm', ok: true },
    ]);
    expect(lines).toEqual(['→ brew install broken', '→ npm install -g pnpm']);
  });

  it('refreshes PATH after each install that worked, so npm is found after Node', async () => {
    let refreshed = 0;
    let npmThere = false;
    const d = deps({
      platform: 'win32',
      resolve: (n) => (n === 'winget' || (n === 'npm' && npmThere) ? `C:\\fake\\${n}.exe` : null),
      refreshPath: () => {
        refreshed += 1;
        npmThere = true;
      },
    });
    const results = await runInstall(
      [
        { tool: 'node', argv: ['winget', 'install', 'node'] },
        { tool: 'pnpm', argv: ['npm', 'install', '-g', 'pnpm'] },
      ],
      d,
      () => undefined,
    );
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect(refreshed).toBe(2);
  });

  it('stops before the next step once aborted', async () => {
    const ac = new AbortController();
    const d = deps({
      signal: ac.signal,
      spawnInherit: (cmd, args) => {
        d.ran.push([cmd, ...args].join(' '));
        ac.abort();
        return Promise.resolve(130);
      },
    });
    const results = await runInstall(
      [
        { tool: 'git', argv: ['brew', 'install', 'git'] },
        { tool: 'pnpm', argv: ['npm', 'install', '-g', 'pnpm'] },
      ],
      d,
      () => undefined,
    );
    expect(d.ran).toEqual(['/fake/brew install git']);
    expect(results).toEqual([{ tool: 'git', what: 'brew install git', ok: false, detail: 'exit code 130' }]);
  });

  it.skipIf(process.platform === 'win32')('writes python3 commands for cmd and sh that run the real Python', async () => {
    const python = 'C:\\Py 3\\python.exe';
    const [res] = await runInstall([{ tool: 'python3', shimDir: dir }], deps({ findPython: () => Promise.resolve(python) }), () => undefined);
    expect(res).toMatchObject({ ok: true, detail: `they run ${python}` });
    expect(readFileSync(path.join(dir, 'python3.cmd'), 'utf8')).toBe(`@rem ${SHIM_MARK}\r\n@"${python}" %*\r\n`);
    expect(readFileSync(path.join(dir, 'python3'), 'utf8')).toBe(`#!/bin/sh\n# ${SHIM_MARK}\nexec "C:/Py 3/python.exe" "$@"\n`);
  });

  it('leaves a python3 it did not write alone', async () => {
    writeFileSync(path.join(dir, 'python3'), '#!/bin/sh\nexec /opt/py/bin/python3 "$@"\n');
    chmodSync(path.join(dir, 'python3'), 0o755);
    const [res] = await runInstall([{ tool: 'python3', shimDir: dir }], deps({ findPython: () => Promise.resolve('C:\\Py\\python.exe') }), () => undefined);
    expect(res).toMatchObject({ ok: false });
    expect(res?.detail).toMatch(/did not write .* left alone/);
    expect(readFileSync(path.join(dir, 'python3'), 'utf8')).toContain('/opt/py/bin/python3');
  });

  it('says when there is no Python to point at', async () => {
    const [res] = await runInstall([{ tool: 'python3', shimDir: dir }], deps(), () => undefined);
    expect(res).toMatchObject({ ok: false, detail: 'no Python 3 found to point them at' });
  });
});
