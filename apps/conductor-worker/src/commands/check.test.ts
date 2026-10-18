import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Executor } from '@cortex/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Rehearsal } from '../env/rehearse.js';
import { parseRegPath, refreshWindowsPath, runCheck, stampFile } from './check.js';
import type { CheckDeps, CheckOptions } from './check.js';

let repo: string;
let home: string;

beforeEach(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'cw-check-repo-'));
  home = mkdtempSync(path.join(os.tmpdir(), 'cw-check-home-'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function put(rel: string, content: string | object): void {
  const file = path.join(repo, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
}

const VERSIONS: Record<string, string> = {
  git: 'git version 2.47.1',
  gh: 'gh version 2.62.0',
  node: 'v22.3.0',
  pnpm: '9.12.0',
};
/** What the fake brew and npm put on PATH. */
const PACKAGE_TOOL: Record<string, string> = { '@anthropic-ai/claude-code': 'claude', python: 'python3' };

const passed: Rehearsal = {
  ref: 'origin/main',
  steps: [{ name: 'test', command: 'pnpm test', exitCode: 0, timedOut: false, tail: '' }],
  notes: [],
  ok: true,
};

interface World {
  present?: string[];
  answer?: boolean | null;
  /** false: an install works, but this terminal does not see the tool. */
  installSticks?: boolean;
  ghLoggedIn?: boolean;
  trial?: Rehearsal;
  fingerprint?: string | null;
  signal?: AbortSignal;
  onTrial?: () => void;
}

function setup(w: World = {}): { deps: CheckDeps; lines: string[]; ran: string[]; asked: string[]; trials: () => number } {
  const have = new Set(w.present ?? ['git', 'gh', 'claude', 'brew', 'npm']);
  const lines: string[] = [];
  const ran: string[] = [];
  const asked: string[] = [];
  let trials = 0;
  const resolve = (n: string): string | null => (have.has(n) ? `/fake/${n}` : null);
  const deps: CheckDeps = {
    platform: 'darwin',
    probe: {
      platform: 'darwin',
      resolve,
      run: (cmd, args) => {
        const tool = path.basename(cmd);
        if (args[0] === '--version') return Promise.resolve({ code: 0, output: VERSIONS[tool] ?? '1.0.0' });
        if (tool === 'gh') return Promise.resolve({ code: w.ghLoggedIn === false ? 1 : 0, output: '' });
        return Promise.resolve({ code: 0, output: '' });
      },
      findPython: () => Promise.resolve(null),
    },
    install: {
      platform: 'darwin',
      resolve,
      spawnInherit: (cmd, args) => {
        ran.push([path.basename(cmd), ...args].join(' '));
        const pkg = (args[args.length - 1] ?? '').replace(/(?<=.)@[\d.]+$/, '');
        if (w.installSticks !== false) have.add(PACKAGE_TOOL[pkg] ?? pkg);
        return Promise.resolve(0);
      },
      findPython: () => Promise.resolve(null),
    },
    availableEngines: (wanted) => Promise.resolve(wanted.filter((e) => have.has(e))),
    rehearse: (_repo, onStep) => {
      trials += 1;
      onStep('test', 'pnpm test');
      w.onTrial?.();
      return Promise.resolve(w.trial ?? passed);
    },
    fingerprint: () => Promise.resolve(w.fingerprint === undefined ? 'fp-1' : w.fingerprint),
    ask: (q) => {
      asked.push(q);
      return Promise.resolve(w.answer === undefined ? true : w.answer);
    },
    out: (l) => lines.push(l),
    ...(w.signal === undefined ? {} : { signal: w.signal }),
  };
  return { deps, lines, ran, asked, trials: () => trials };
}

const opts = (over: Partial<CheckOptions> = {}): CheckOptions => ({
  repo,
  engines: ['claude'] as Executor[],
  homeDir: home,
  yes: false,
  ifChanged: false,
  ...over,
});

describe('runCheck', () => {
  it('lists what is here, runs the trial, says ready and remembers the pass', async () => {
    const t = setup();
    expect(await runCheck(opts(), t.deps)).toBe(0);
    expect(t.lines).toEqual(
      expect.arrayContaining([
        '✓ git 2.47.1, gh 2.62.0, engines: claude',
        'nothing is missing',
        '  … test: pnpm test',
        '✓ test: pnpm test',
        `ready: this machine can take tasks for ${repo}`,
      ]),
    );
    expect(t.asked).toEqual([]);
    expect(JSON.parse(readFileSync(stampFile(home, repo), 'utf8'))).toMatchObject({ fingerprint: 'fp-1' });
  });

  it('--if-changed skips a trial that passed on the same inputs, and runs one when they changed', async () => {
    await runCheck(opts(), setup().deps);
    const same = setup();
    expect(await runCheck(opts({ ifChanged: true }), same.deps)).toBe(0);
    expect(same.trials()).toBe(0);
    expect(same.lines).toContain('trial run: skipped, it passed before and nothing it rests on has changed (cw check runs it again)');
    const changed = setup({ fingerprint: 'fp-2' });
    await runCheck(opts({ ifChanged: true }), changed.deps);
    expect(changed.trials()).toBe(1);
  });

  it('a failed trial: not ready, the end of its output, and the old pass forgotten', async () => {
    await runCheck(opts(), setup().deps);
    const t = setup({
      trial: {
        ref: 'origin/main',
        steps: [
          { name: 'setup', command: 'pnpm install --frozen-lockfile', exitCode: 0, timedOut: false, tail: 'done' },
          { name: 'test', command: 'pnpm test', exitCode: 1, timedOut: false, tail: 'FAIL a.test.ts\n1 failed' },
        ],
        notes: [],
        ok: false,
      },
    });
    expect(await runCheck(opts(), t.deps)).toBe(1);
    const at = t.lines.indexOf('✗ test: pnpm test (exit code 1)');
    expect(t.lines.slice(at - 1, at + 3)).toEqual([
      '✓ setup: pnpm install --frozen-lockfile',
      '✗ test: pnpm test (exit code 1)',
      '      FAIL a.test.ts',
      '      1 failed',
    ]);
    expect(t.lines.at(-1)).toBe('not ready: the trial run on origin/main failed, and tasks would fail the same way');
    expect(existsSync(stampFile(home, repo))).toBe(false);
  });

  it('says when a step timed out, and when no worktree could be made', async () => {
    const t = setup({
      trial: {
        ref: 'HEAD',
        steps: [{ name: 'test', command: 'pnpm test', exitCode: 124, timedOut: true, tail: '' }],
        notes: ['origin/HEAD is not set, so the trial used the checked-out commit'],
        ok: false,
      },
    });
    await runCheck(opts(), t.deps);
    expect(t.lines).toEqual(expect.arrayContaining(['✗ test: pnpm test (timed out)', 'note: origin/HEAD is not set, so the trial used the checked-out commit']));
    const e = setup({ trial: { ref: 'HEAD', steps: [], notes: [], error: 'could not make a trial worktree: fatal: x', ok: false } });
    expect(await runCheck(opts(), e.deps)).toBe(1);
    expect(e.lines).toContain('✗ could not make a trial worktree: fatal: x');
  });

  it('asks once, installs, looks again and goes on to the trial', async () => {
    put('package.json', { packageManager: 'pnpm@9.12.0' });
    put('pnpm-lock.yaml', '');
    const t = setup({ present: ['gh', 'node', 'claude', 'brew', 'npm'] });
    expect(await runCheck(opts(), t.deps)).toBe(0);
    expect(t.asked).toEqual(['Go ahead? [Y/n] ']);
    expect(t.ran).toEqual(['brew install git', 'npm install -g pnpm@9.12.0']);
    const list = t.lines.indexOf('cw check can do these for you:');
    expect(t.lines.slice(list, list + 3)).toEqual(['cw check can do these for you:', '  brew install git', '  npm install -g pnpm@9.12.0']);
    expect(t.lines).toEqual(expect.arrayContaining(['✓ brew install git', '✓ npm install -g pnpm@9.12.0', 'now:', 'nothing is missing']));
    expect(t.trials()).toBe(1);
  });

  it('--yes installs without asking', async () => {
    const t = setup({ present: ['gh', 'claude', 'brew'] });
    expect(await runCheck(opts({ yes: true }), t.deps)).toBe(0);
    expect(t.asked).toEqual([]);
    expect(t.ran).toEqual(['brew install git']);
  });

  it('without a terminal to ask in, says how, installs nothing and holds the trial', async () => {
    const t = setup({ present: ['gh', 'claude', 'brew'], answer: null });
    expect(await runCheck(opts(), t.deps)).toBe(1);
    expect(t.ran).toEqual([]);
    expect(t.trials()).toBe(0);
    expect(t.lines).toEqual(
      expect.arrayContaining([
        '✗ git — not found; clones the project and pushes the task branches',
        '    fix: brew install git',
        'no terminal to ask in; to have them done: cw check --yes',
        'the trial run waits until the ✗ items are fixed',
        'not ready: 1 thing to fix, then run cw check again',
      ]),
    );
  });

  it('a no installs nothing', async () => {
    const t = setup({ present: ['gh', 'claude', 'brew'], answer: false });
    expect(await runCheck(opts(), t.deps)).toBe(1);
    expect(t.ran).toEqual([]);
    expect(t.lines).toContain('nothing installed');
  });

  it('says to open a new terminal when an install worked but this one does not see it', async () => {
    const t = setup({ present: ['gh', 'claude', 'brew'], installSticks: false });
    expect(await runCheck(opts({ yes: true }), t.deps)).toBe(1);
    expect(t.lines).toContain('git installed, but this terminal does not see it yet: open a new terminal and run cw check again');
  });

  it('a warning does not hold anything up', async () => {
    const t = setup({ ghLoggedIn: false });
    expect(await runCheck(opts(), t.deps)).toBe(0);
    expect(t.lines).toEqual(expect.arrayContaining([expect.stringMatching(/^! gh — not logged in; /), '    fix: gh auth login']));
    expect(t.asked).toEqual([]);
    expect(t.trials()).toBe(1);
  });

  it('lists the problems that block tasks before the warnings', async () => {
    const t = setup({ present: ['git', 'gh', 'brew'], ghLoggedIn: false });
    await runCheck(opts({ engines: ['claude', 'codex'] }), t.deps);
    const marks = t.lines.filter((l) => /^[✗!] /.test(l)).map((l) => l.slice(0, 8));
    expect(marks).toEqual(['✗ engine', '! gh — n']);
    expect(t.lines).toEqual(expect.arrayContaining(['    fix: claude: npm install -g @anthropic-ai/claude-code', '         codex: npm install -g @openai/codex']));
    // which engine to install is the person's call
    expect(t.asked).toEqual([]);
  });

  it('Ctrl+C during the trial ends it with 130', async () => {
    const ac = new AbortController();
    const t = setup({ signal: ac.signal, onTrial: () => ac.abort(), trial: { ...passed, ok: false } });
    expect(await runCheck(opts(), t.deps)).toBe(130);
    expect(t.lines.at(-1)).toBe('interrupted; the temporary worktree is removed');
    expect(existsSync(stampFile(home, repo))).toBe(false);
  });
});

describe('Windows PATH refresh', () => {
  it('reads the Path value reg query prints', () => {
    const output = '\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\.local\\bin;C:\\Tools\r\n\r\n';
    expect(parseRegPath(output)).toBe('%USERPROFILE%\\.local\\bin;C:\\Tools');
    expect(parseRegPath('ERROR: The system was unable to find the specified registry key or value.')).toBeNull();
  });

  it('adds what installers put in the registry after what is already on PATH', () => {
    const env: NodeJS.ProcessEnv = { Path: 'C:\\Users\\u\\venv\\Scripts;C:\\Windows\\system32', USERPROFILE: 'C:\\Users\\u' };
    refreshWindowsPath(env, (scope) =>
      scope === 'machine' ? 'C:\\Windows\\System32\\;C:\\Program Files\\nodejs\\' : '%USERPROFILE%\\.local\\bin;%NOPE%\\bin;',
    );
    expect(env).toEqual({
      Path: 'C:\\Users\\u\\venv\\Scripts;C:\\Windows\\system32;C:\\Program Files\\nodejs\\;C:\\Users\\u\\.local\\bin;%NOPE%\\bin',
      USERPROFILE: 'C:\\Users\\u',
    });
  });

  it('leaves PATH alone when the registry cannot be read', () => {
    const env: NodeJS.ProcessEnv = { PATH: 'C:\\a' };
    refreshWindowsPath(env, () => null);
    expect(env).toEqual({ PATH: 'C:\\a' });
  });
});
