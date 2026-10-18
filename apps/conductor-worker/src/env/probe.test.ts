import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { engineProblems, findWindowsPython, probeNeeds } from './probe.js';
import type { ProbeDeps, RunOut } from './probe.js';
import type { Needs, Requirement } from './requirements.js';

/** A machine: which commands exist, and what each `cmd args` prints. */
function machine(
  bins: Record<string, string>,
  outputs: Record<string, RunOut>,
  platform: NodeJS.Platform = 'darwin',
  python: string | null = null,
): ProbeDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    platform,
    calls,
    resolve: (name) => bins[name] ?? null,
    run: (cmd, args) => {
      const key = `${cmd} ${args.join(' ')}`;
      calls.push(key);
      return Promise.resolve(outputs[key] ?? { code: 1, output: `no fake for ${key}` });
    },
    findPython: () => Promise.resolve(python),
  };
}

const ok = (output: string): RunOut => ({ code: 0, output });
const needs = (requirements: Requirement[]): Needs => ({ requirements, setupCommand: null, testCommand: null, notes: [] });
const r = (tool: string, extra: Partial<Requirement> = {}): Requirement => ({ tool, why: `needs ${tool}`, required: true, ...extra });

describe('probeNeeds', () => {
  it('finds what is there and in range', async () => {
    const m = machine(
      { git: '/bin/git', node: '/bin/node', pnpm: '/bin/pnpm' },
      { '/bin/git --version': ok('git version 2.47.1'), '/bin/node --version': ok('v22.3.0'), '/bin/pnpm --version': ok('9.12.0') },
    );
    const p = await probeNeeds('/repo', needs([r('git'), r('node', { range: '>=20' }), r('pnpm', { range: '9.x', installVersion: '9.12.0' })]), m);
    expect(p.problems).toEqual([]);
    expect(p.found).toEqual([
      { tool: 'git', path: '/bin/git', version: '2.47.1' },
      { tool: 'node', path: '/bin/node', version: '22.3.0' },
      { tool: 'pnpm', path: '/bin/pnpm', version: '9.12.0' },
    ]);
  });

  it('names a missing tool, why, and the install for this platform', async () => {
    const p = await probeNeeds('/repo', needs([r('docker', { why: 'the git hooks run it (.lefthook.yml)' })]), machine({}, {}, 'win32'));
    expect(p.problems).toEqual([
      {
        tool: 'docker',
        kind: 'missing',
        required: true,
        detail: 'not found; the git hooks run it (.lefthook.yml)',
        fix: 'winget install -e --id Docker.DockerDesktop --accept-source-agreements --accept-package-agreements',
      },
    ]);
  });

  it('reports a version out of range, with the pinned version to install', async () => {
    const m = machine({ pnpm: '/bin/pnpm', node: '/bin/node' }, { '/bin/pnpm --version': ok('8.15.4'), '/bin/node --version': ok('v20.11.0') });
    const p = await probeNeeds(
      '/repo',
      needs([
        r('pnpm', { range: '9.x', installVersion: '9.12.0' }),
        r('node', { range: '>=20' }),
        r('node', { range: '22.x', required: false, why: '.nvmrc asks for Node 22' }),
      ]),
      m,
    );
    expect(p.problems).toEqual([
      expect.objectContaining({ tool: 'pnpm', kind: 'version', required: true, version: '9.12.0', fix: 'npm install -g pnpm@9.12.0' }),
      expect.objectContaining({ tool: 'node', kind: 'version', required: false, detail: '20.11.0 is here, 22.x is needed; .nvmrc asks for Node 22' }),
    ]);
  });

  it('runs --version in the repo, so corepack picks the pinned package manager', async () => {
    const m = machine({ pnpm: '/bin/pnpm' }, { '/bin/pnpm --version': ok('9.12.0') });
    let cwd = '';
    const run = m.run;
    m.run = (cmd, args, opts) => {
      cwd = opts.cwd;
      return run(cmd, args, opts);
    };
    await probeNeeds('/the/repo', needs([r('pnpm')]), m);
    expect(cwd).toBe('/the/repo');
  });

  it('notes a range it cannot read instead of failing', async () => {
    const m = machine({ node: '/bin/node' }, { '/bin/node --version': ok('v22.3.0') });
    const p = await probeNeeds('/repo', needs([r('node', { range: 'lts/iron' })]), m);
    expect(p.problems).toEqual([]);
    expect(p.notes[0]).toMatch(/could not check node 22.3.0 against "lts\/iron"/);
  });

  it('tells a stopped Docker from a missing one', async () => {
    const down = machine(
      { docker: '/bin/docker' },
      {
        '/bin/docker --version': ok('Docker version 27.3.1, build ce12230'),
        '/bin/docker info --format {{.ServerVersion}}': { code: 1, output: 'Cannot connect to the Docker daemon. Is the docker daemon running?' },
      },
      'win32',
    );
    const p = await probeNeeds('/repo', needs([r('docker')]), down);
    expect(p.problems).toEqual([
      expect.objectContaining({ kind: 'not-running', fix: 'open Docker Desktop and wait until it says the engine is running' }),
    ]);
    expect(p.problems[0]?.detail).toMatch(/not running \(Cannot connect/);

    const denied = machine(
      { docker: '/bin/docker' },
      {
        '/bin/docker --version': ok('Docker version 27.3.1'),
        '/bin/docker info --format {{.ServerVersion}}': { code: 1, output: 'permission denied while trying to connect to the Docker daemon socket' },
      },
      'linux',
    );
    expect((await probeNeeds('/repo', needs([r('docker')]), denied)).problems[0]?.fix).toMatch(/usermod -aG docker/);

    const up = machine(
      { docker: '/bin/docker' },
      { '/bin/docker --version': ok('Docker version 27.3.1'), '/bin/docker info --format {{.ServerVersion}}': ok('27.3.1') },
    );
    expect((await probeNeeds('/repo', needs([r('docker')]), up)).problems).toEqual([]);
  });

  it('warns when gh is not logged in, without its output', async () => {
    const m = machine(
      { gh: '/bin/gh' },
      { '/bin/gh --version': ok('gh version 2.62.0'), '/bin/gh auth status': { code: 1, output: 'not logged in as someone' } },
    );
    const p = await probeNeeds('/repo', needs([r('gh', { required: false, why: 'opens the pull requests' })]), m);
    expect(p.problems).toEqual([
      { tool: 'gh', kind: 'not-logged-in', required: false, detail: 'not logged in; opens the pull requests', fix: 'gh auth login' },
    ]);
  });

  it('only looks up a tool it does not know how to version', async () => {
    const m = machine({ make: '/bin/make' }, {});
    const p = await probeNeeds('/repo', needs([r('make')]), m);
    expect(p.problems).toEqual([]);
    expect(m.calls).toEqual([]);
  });

  describe('python3', () => {
    it('accepts a python3 that is Python 3', async () => {
      const m = machine({ python3: '/bin/python3' }, { '/bin/python3 --version': ok('Python 3.12.1') });
      expect((await probeNeeds('/repo', needs([r('python3')]), m)).found).toEqual([{ tool: 'python3', path: '/bin/python3', version: '3.12.1' }]);
    });

    it('sees through the Windows Store alias to a real Python it can point a python3 at', async () => {
      const stub = 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\python3.exe';
      const real = 'C:\\Python312\\python.exe';
      const m = machine(
        { python3: stub },
        { [`${stub} --version`]: { code: 9009, output: 'Python was not found; run without arguments to install from the Microsoft Store' } },
        'win32',
        real,
      );
      const [p] = (await probeNeeds('/repo', needs([r('python3')]), m)).problems;
      expect(p).toMatchObject({ tool: 'python3', kind: 'missing', realPython: real });
      expect(p?.detail).toMatch(/^only the Microsoft Store alias is here/);
      expect(p?.fix).toContain(`adds a python3 command that runs ${real}`);
      expect(p?.fix).toContain('App execution aliases');
    });

    it('installs Python on Windows when there is none', async () => {
      const [p] = (await probeNeeds('/repo', needs([r('python3')]), machine({}, {}, 'win32', null))).problems;
      expect(p?.realPython).toBeUndefined();
      expect(p?.fix).toMatch(/^winget install -e --id Python\.Python\.3\.12 .*, then cw check --yes$/);
    });

    it('uses brew on a Mac', async () => {
      const [p] = (await probeNeeds('/repo', needs([r('python3')]), machine({}, {}))).problems;
      expect(p?.fix).toBe('brew install python');
    });
  });
});

describe('engineProblems', () => {
  it('is quiet when an engine is there', () => {
    expect(engineProblems(['claude', 'agy'], ['agy'], 'darwin')).toEqual([]);
  });

  it('names the one engine wanted and how to install it', () => {
    expect(engineProblems(['claude'], [], 'linux')).toEqual([
      expect.objectContaining({ tool: 'claude', required: true, fix: 'npm install -g @anthropic-ai/claude-code' }),
    ]);
  });

  it('lists every choice when several were allowed', () => {
    const [p] = engineProblems(['claude', 'codex'], [], 'linux');
    expect(p?.tool).toBe('engine');
    expect(p?.fix.split('\n')).toEqual(['claude: npm install -g @anthropic-ai/claude-code', 'codex: npm install -g @openai/codex']);
  });
});

describe('findWindowsPython', () => {
  let dir = '';
  afterEach(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  it('skips the Store alias and finds the newest install where winget puts it', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'cortex-py-'));
    for (const v of ['Python311', 'Python313', 'Launcher']) {
      mkdirSync(path.join(dir, 'Programs', 'Python', v), { recursive: true });
      writeFileSync(path.join(dir, 'Programs', 'Python', v, 'python.exe'), '');
    }
    const newest = path.join(dir, 'Programs', 'Python', 'Python313', 'python.exe');
    const seen: string[] = [];
    const found = await findWindowsPython({
      env: { LOCALAPPDATA: dir },
      resolve: (n) => (n === 'python' ? 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe' : null),
      run: (cmd) => {
        seen.push(cmd);
        return Promise.resolve(ok('Python 3.13.0'));
      },
    });
    expect(found).toBe(newest);
    expect(seen).toEqual([newest]);
  });

  it('asks the py launcher', async () => {
    const found = await findWindowsPython({
      env: {},
      resolve: (n) => (n === 'py' ? 'C:\\Windows\\py.exe' : null),
      run: (cmd, args) =>
        Promise.resolve(cmd === 'C:\\Windows\\py.exe' && args[0] === '-3' ? ok('C:\\Py\\python.exe\r\n') : ok('Python 3.12.0')),
    });
    expect(found).toBe('C:\\Py\\python.exe');
  });

  it('is null when nothing answers as Python 3', async () => {
    expect(await findWindowsPython({ env: {}, resolve: () => 'C:\\Python27\\python.exe', run: () => Promise.resolve(ok('Python 2.7.18')) })).toBeNull();
  });
});
