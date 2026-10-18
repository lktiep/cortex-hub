import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProbeDeps, RunOut } from './probe.js';
import { machineProblems } from './readiness.js';

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'cw-ready-'));
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ packageManager: 'pnpm@9.12.0' }));
  writeFileSync(path.join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  writeFileSync(path.join(repo, '.lefthook.yml'), 'pre-push:\n  commands:\n    db:\n      run: docker compose up -d\n');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

const ok = (output: string): RunOut => ({ code: 0, output });

function machine(bins: Record<string, string>, outputs: Record<string, RunOut>): ProbeDeps {
  return {
    platform: 'darwin',
    resolve: (name) => bins[name] ?? null,
    run: (cmd, args) => Promise.resolve(outputs[`${cmd} ${args.join(' ')}`] ?? { code: 1, output: '' }),
    findPython: () => Promise.resolve(null),
  };
}

const ALL = { git: '/bin/git', gh: '/bin/gh', node: '/bin/node', pnpm: '/bin/pnpm', docker: '/bin/docker' };
const VERSIONS: Record<string, RunOut> = {
  '/bin/git --version': ok('git version 2.47.1'),
  '/bin/gh --version': ok('gh version 2.60.0'),
  '/bin/gh auth status': ok(''),
  '/bin/node --version': ok('v22.3.0'),
  '/bin/pnpm --version': ok('9.12.0'),
  '/bin/docker --version': ok('Docker version 27.3.1'),
  '/bin/docker info --format {{.ServerVersion}}': ok('27.3.1'),
};

describe('machineProblems', () => {
  it('is empty when the machine has what the project needs', async () => {
    expect(await machineProblems(repo, machine(ALL, VERSIONS))).toEqual([]);
  });

  it('lists only what stops a task, one line each', async () => {
    const { pnpm: _pnpm, gh: _gh, ...rest } = ALL;
    const outputs = { ...VERSIONS, '/bin/docker info --format {{.ServerVersion}}': { code: 1, output: 'Cannot connect to the Docker daemon' } };
    expect(await machineProblems(repo, machine(rest, outputs))).toEqual([
      'pnpm: not found; package.json packageManager is pnpm@9.12.0',
      'docker: installed, but the Docker engine is not running (Cannot connect to the Docker daemon)',
    ]);
  });
});
