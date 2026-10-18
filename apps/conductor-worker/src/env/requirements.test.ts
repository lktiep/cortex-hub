import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inferNeeds, parseVersion, projectCommands, readWorkerProfile, satisfies, scanHooks } from './requirements.js';
import type { Requirement } from './requirements.js';

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'cortex-needs-'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function put(rel: string, content: string | object): void {
  const file = path.join(repo, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
}

const tools = (reqs: Requirement[]): string[] => reqs.map((r) => r.tool);
const req = (reqs: Requirement[], tool: string, required = true): Requirement | undefined =>
  reqs.find((r) => r.tool === tool && r.required === required);

describe('satisfies', () => {
  it.each([
    ['22.3.0', '>=20', true],
    ['18.19.1', '>=20', false],
    ['20.0.0', '>= 20', true],
    ['9.12.0', '9.x', true],
    ['10.0.0', '9.x', false],
    ['9.12.0', '^9.1', true],
    ['9.0.5', '^9.1', false],
    ['0.2.9', '^0.2.3', true],
    ['0.3.0', '^0.2.3', false],
    ['3.12.4', '~3.12', true],
    ['3.13.0', '~3.12', false],
    ['20.11.1', '>=18 <21', true],
    ['22.1.0', '>=18 <21', false],
    ['22.1.0', '^18 || ^22', true],
    ['20.1.0', '^18 || ^22', false],
    ['1.5.0', '1.2 - 2', true],
    ['2.9.9', '1.2 - 2', true],
    ['3.0.0', '1.2 - 2', false],
    ['20.1.0', '20', true],
    ['20.1.0', '>20', false],
    ['21.0.0', '>20', true],
    ['20.9.0', '<=20', true],
    ['5.0.0', '*', true],
    ['5.0.0', '', true],
    ['v22.3.0', '=22.3.0', true],
    ['22.3.1-rc.1', '22.3.1', true],
  ])('%s in %s is %s', (version, range, want) => {
    expect(satisfies(version, range)).toBe(want);
  });

  it('returns null for what it cannot read', () => {
    expect(satisfies('22.0.0', 'lts/iron')).toBeNull();
    expect(satisfies('no version here', '>=20')).toBeNull();
  });
});

describe('parseVersion', () => {
  it('finds the version in what tools print', () => {
    expect(parseVersion('v22.3.0')).toBe('22.3.0');
    expect(parseVersion('Python 3.12.1')).toBe('3.12.1');
    expect(parseVersion('Docker version 27.3.1, build ce12230')).toBe('27.3.1');
    expect(parseVersion('git version 2.47.1')).toBe('2.47.1');
    expect(parseVersion('gh version 2.62')).toBe('2.62.0');
    expect(parseVersion('Python was not found; run without arguments to install from the Microsoft Store')).toBeNull();
  });
});

describe('readWorkerProfile', () => {
  it('reads the worker section', () => {
    put('.cortex/project-profile.json', {
      schema_version: '2.0',
      worker: { setupCommand: ' pnpm i ', testCommand: 'pnpm test', requires: ['docker', 'python3', 'docker'] },
    });
    expect(readWorkerProfile(repo)).toEqual({
      profile: { setupCommand: 'pnpm i', testCommand: 'pnpm test', requires: ['docker', 'python3'] },
      notes: [],
    });
  });

  it('is empty without a profile or a worker section', () => {
    expect(readWorkerProfile(repo)).toEqual({ profile: {}, notes: [] });
    put('.cortex/project-profile.json', { schema_version: '2.0' });
    expect(readWorkerProfile(repo)).toEqual({ profile: {}, notes: [] });
  });

  it('names what it leaves out', () => {
    put('.cortex/project-profile.json', '{ not json');
    expect(readWorkerProfile(repo).notes[0]).toMatch(/not valid JSON/);
    put('.cortex/project-profile.json', { worker: { setupCommand: 3, requires: ['docker', 'rm -rf /'] } });
    const r = readWorkerProfile(repo);
    expect(r.profile).toEqual({});
    expect(r.notes.join('\n')).toMatch(/setupCommand must be a string/);
    expect(r.notes.join('\n')).toMatch(/requires must be a list of command names/);
  });
});

describe('inferNeeds', () => {
  it('needs git and, as a warning, gh for any repo; nothing to set up without package.json', () => {
    const n = inferNeeds(repo);
    expect(tools(n.requirements)).toEqual(['git', 'gh']);
    expect(req(n.requirements, 'gh', false)).toBeDefined();
    expect(n.setupCommand).toBeNull();
    expect(n.testCommand).toBeNull();
  });

  it('reads node, pnpm and the install from package.json and the lockfile', () => {
    put('package.json', { packageManager: 'pnpm@9.12.0+sha512.abc', engines: { node: '>=22' } });
    put('pnpm-lock.yaml', 'lockfileVersion: 9.0\n');
    const n = inferNeeds(repo);
    expect(req(n.requirements, 'node')).toMatchObject({ range: '>=22', why: 'package.json engines.node is >=22' });
    expect(req(n.requirements, 'pnpm')).toMatchObject({ range: '9.x', installVersion: '9.12.0' });
    expect(n.setupCommand).toBe('pnpm install --frozen-lockfile');
  });

  it('falls back to Node 20 and the lockfile alone', () => {
    put('package.json', { name: 'x' });
    put('yarn.lock', '');
    const n = inferNeeds(repo);
    expect(req(n.requirements, 'node')?.range).toBe('>=20');
    expect(req(n.requirements, 'yarn')).toMatchObject({ why: 'the project has yarn.lock' });
    expect(n.setupCommand).toBe('yarn install --frozen-lockfile');
  });

  it('uses npm ci for package-lock.json, and no install without a lockfile', () => {
    put('package.json', { name: 'x' });
    expect(inferNeeds(repo)).toMatchObject({ setupCommand: null, notes: [expect.stringMatching(/^no lockfile, so no install runs/)] });
    put('package-lock.json', '{}');
    const n = inferNeeds(repo);
    expect(n.setupCommand).toBe('npm ci');
    expect(tools(n.requirements)).not.toContain('npm');
  });

  it('warns, not requires, about the .nvmrc version', () => {
    put('package.json', { name: 'x' });
    put('.nvmrc', 'v22.11.0\n');
    expect(req(inferNeeds(repo).requirements, 'node', false)).toMatchObject({ range: '22.x', why: '.nvmrc asks for Node v22.11.0' });
  });

  it('takes the setup and test commands from the profile; "" turns the install off', () => {
    put('package.json', { name: 'x' });
    put('pnpm-lock.yaml', '');
    put('.cortex/project-profile.json', { worker: { setupCommand: 'make deps', testCommand: 'make test' } });
    expect(inferNeeds(repo)).toMatchObject({ setupCommand: 'make deps', testCommand: 'make test' });
    put('.cortex/project-profile.json', { worker: { setupCommand: '' } });
    expect(inferNeeds(repo).setupCommand).toBeNull();
  });

  it('finds docker and python3 behind the hooks, through package.json scripts and the files they run', () => {
    put('package.json', {
      scripts: { verify: 'pnpm run lint && node scripts/verify.mjs', lint: 'python3 tools/lint.py' },
    });
    put('.lefthook.yml', 'pre-push:\n  commands:\n    verify:\n      run: pnpm verify\n');
    put('scripts/verify.mjs', "import { execSync } from 'node:child_process';\nexecSync('docker compose up -d db');\n");
    const n = inferNeeds(repo);
    expect(req(n.requirements, 'docker')).toMatchObject({ why: 'the git hooks run it (scripts/verify.mjs)' });
    expect(req(n.requirements, 'python3')).toMatchObject({ why: 'the git hooks run it (package.json script "lint")' });
  });

  it('reads husky and .githooks, not husky plumbing, and a mention is not a call', () => {
    put('.husky/pre-commit', 'echo "remember to start docker"\n');
    put('.husky/_/husky.sh', 'docker run x\n');
    expect(scanHooks(repo, null).size).toBe(0);
    put('.githooks/pre-push', '#!/bin/sh\ndocker run --rm lint\n');
    expect(scanHooks(repo, null).get('docker')).toBe('.githooks/pre-push');
  });

  it('never follows a file outside the repo', () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), 'cortex-outside-'));
    try {
      writeFileSync(path.join(outside, 'x.sh'), 'docker run x\n');
      put('.githooks/pre-push', `sh ../${path.basename(outside)}/x.sh\n`);
      expect(scanHooks(repo, null).size).toBe(0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('lets worker.requires replace the scan, and notes what the hooks mention', () => {
    put('.githooks/pre-push', 'docker run --rm lint\n');
    put('.cortex/project-profile.json', { worker: { requires: ['python3', 'make'] } });
    const n = inferNeeds(repo);
    expect(tools(n.requirements)).toEqual(['git', 'gh', 'python3', 'make']);
    expect(n.notes).toEqual(['.githooks/pre-push mentions docker, but worker.requires does not list it']);
    put('.cortex/project-profile.json', { worker: { requires: [] } });
    expect(tools(inferNeeds(repo).requirements)).toEqual(['git', 'gh']);
  });
});

describe('projectCommands', () => {
  it('prefers the commands set on this machine, then the project ones', () => {
    put('package.json', { name: 'x' });
    put('pnpm-lock.yaml', '');
    put('.cortex/project-profile.json', { worker: { testCommand: 'pnpm test' } });
    expect(projectCommands(repo, {})).toEqual({ setup: 'pnpm install --frozen-lockfile', test: 'pnpm test' });
    expect(projectCommands(repo, { CORTEX_SETUP_CMD: 'make deps', CORTEX_TEST_CMD: ' ' })).toEqual({ setup: 'make deps', test: 'pnpm test' });
  });
});
