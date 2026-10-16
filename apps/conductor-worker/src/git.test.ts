import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BranchInUseError,
  branchCheckedOutAt,
  commitAll,
  compareUrl,
  createGh,
  git,
  openPullRequest,
  originUrl,
  prepareWorktree,
  pushBranch,
  removeWorktree,
  sanitizeRemoteUrl,
} from './git.js';
import type { GhRun } from './git.js';
import {
  FIXTURE_GIT_IDENTITY,
  createGitFixture,
  isolateGitConfig,
} from './test-utils/git-fixture.js';
import type { GitFixture } from './test-utils/git-fixture.js';

let fx: GitFixture;
let configDir: string;
let restoreConfig: () => void;

function setup(identity: { name: string; email: string } | null): void {
  configDir = mkdtempSync(path.join(os.tmpdir(), 'cortex-git-config-'));
  restoreConfig = isolateGitConfig(configDir, identity);
  fx = createGitFixture();
}

beforeEach(() => setup(FIXTURE_GIT_IDENTITY));

afterEach(() => {
  fx.cleanup();
  restoreConfig();
  rmSync(configDir, { recursive: true, force: true });
});

const real = (p: string): string => realpathSync.native(p);
const wt = (name: string): string => path.join(fx.scratch, name);

describe('sanitizeRemoteUrl', () => {
  it('strips userinfo from https and keeps ssh', () => {
    expect(sanitizeRemoteUrl('https://user:secret@github.com/o/r.git')).toBe('https://github.com/o/r.git');
    expect(sanitizeRemoteUrl('https://token@github.com/o/r.git')).toBe('https://github.com/o/r.git');
    expect(sanitizeRemoteUrl('git@github.com:o/r.git')).toBe('git@github.com:o/r.git');
    expect(sanitizeRemoteUrl('https://github.com/o/r.git')).toBe('https://github.com/o/r.git');
  });

  it('strips userinfo with a regex when the URL does not parse', () => {
    expect(sanitizeRemoteUrl('https://user:pa ss@exa mple.com/o/r')).not.toContain('pa ss');
    expect(sanitizeRemoteUrl('https://user:pa ss@exa mple.com/o/r')).not.toContain('user');
  });
});

describe('originUrl', () => {
  it('returns the sanitised origin, or null without one', async () => {
    expect(await originUrl(fx.repo)).toBe(fx.origin);
    fx.run(fx.repo, ['remote', 'set-url', 'origin', 'https://u:tok@example.com/o/r.git']);
    expect(await originUrl(fx.repo)).toBe('https://example.com/o/r.git');
    fx.run(fx.repo, ['remote', 'remove', 'origin']);
    expect(await originUrl(fx.repo)).toBeNull();
  });
});

describe('prepareWorktree', () => {
  it('creates the branch from origin/<baseBranch> when the task branch is new', async () => {
    const dir = wt('a');
    const r = await prepareWorktree(fx.repo, dir, 'task/a', 'main');
    expect(r).toEqual({ from: 'base' });
    expect(readFileSync(path.join(dir, 'README.md'), 'utf8')).toContain('fixture');
    expect(fx.run(dir, ['branch', '--show-current'])).toBe('task/a');
  });

  it('starts from origin/<branch> when it exists', async () => {
    const other = path.join(fx.scratch, 'other');
    fx.run(fx.scratch, ['clone', fx.origin, other]);
    fx.run(other, ['checkout', '-b', 'task/b']);
    writeFileSync(path.join(other, 'pushed.txt'), 'x');
    fx.run(other, ['add', 'pushed.txt']);
    fx.run(other, ['commit', '-m', 'pushed']);
    fx.run(other, ['push', 'origin', 'task/b']);

    const dir = wt('b');
    const r = await prepareWorktree(fx.repo, dir, 'task/b', 'main');
    expect(r).toEqual({ from: 'branch' });
    expect(existsSync(path.join(dir, 'pushed.txt'))).toBe(true);
  });

  it('reuses an existing worktree for the same task', async () => {
    const dir = wt('c');
    await prepareWorktree(fx.repo, dir, 'task/c', 'main');
    writeFileSync(path.join(dir, 'wip.txt'), 'keep me');
    const r = await prepareWorktree(fx.repo, dir, 'task/c', 'main');
    expect(r).toEqual({ from: 'existing' });
    expect(readFileSync(path.join(dir, 'wip.txt'), 'utf8')).toBe('keep me');
  });

  it('throws BranchInUseError when the branch is checked out elsewhere', async () => {
    const err = await prepareWorktree(fx.repo, wt('d'), 'main', 'main').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BranchInUseError);
    const e = err as BranchInUseError;
    expect(e.branch).toBe('main');
    expect(real(e.path)).toBe(real(fx.repo));
  });

  it('fails clearly when the base branch is missing', async () => {
    await expect(prepareWorktree(fx.repo, wt('e'), 'task/e', 'nope')).rejects.toThrow(
      'base branch nope not found on origin',
    );
  });

  it('throws with the stderr tail when fetch fails', async () => {
    fx.run(fx.repo, ['remote', 'set-url', 'origin', path.join(fx.root, 'missing.git')]);
    await expect(prepareWorktree(fx.repo, wt('f'), 'task/f', 'main')).rejects.toThrow(/fetch/i);
  });

  it('throws when dir is registered on a different branch', async () => {
    const dir = wt('g');
    await prepareWorktree(fx.repo, dir, 'task/g1', 'main');
    await expect(prepareWorktree(fx.repo, dir, 'task/g2', 'main')).rejects.toThrow(
      `worktree ${dir} holds task/g1, expected task/g2`,
    );
  });

  it('replaces an orphan directory', async () => {
    const dir = wt('h');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'junk.txt'), 'stale');
    const r = await prepareWorktree(fx.repo, dir, 'task/h', 'main');
    expect(r).toEqual({ from: 'base' });
    expect(existsSync(path.join(dir, 'junk.txt'))).toBe(false);
    expect(fx.run(dir, ['branch', '--show-current'])).toBe('task/h');
  });
});

describe('branchCheckedOutAt', () => {
  it("returns the user's checkout path and ignores the worker's own worktree", async () => {
    const dir = wt('i');
    await prepareWorktree(fx.repo, dir, 'task/i', 'main');
    const user = await branchCheckedOutAt(fx.repo, 'main', dir);
    expect(user).not.toBeNull();
    expect(real(user as string)).toBe(real(fx.repo));
    expect(await branchCheckedOutAt(fx.repo, 'task/i', dir)).toBeNull();
    expect(await branchCheckedOutAt(fx.repo, 'task/i', wt('elsewhere'))).not.toBeNull();
  });
});

describe('commitAll', () => {
  const fallback = { name: 'Worker', email: 'worker@example.invalid' };

  it('returns null on a clean tree', async () => {
    expect(await commitAll(fx.repo, 'msg', fallback)).toBeNull();
  });

  it('commits everything and returns the new HEAD', async () => {
    writeFileSync(path.join(fx.repo, 'n.txt'), 'new');
    const message = 'feat: "quoted" $(whoami)\n\nbody';
    const sha = await commitAll(fx.repo, message, fallback);
    expect(sha).toBe(fx.run(fx.repo, ['rev-parse', 'HEAD']));
    expect(fx.run(fx.repo, ['log', '-1', '--format=%B'])).toBe(message);
    expect(fx.run(fx.repo, ['log', '-1', '--format=%ae'])).toBe(FIXTURE_GIT_IDENTITY.email);
  });

  it('uses the fallback identity when none is configured', async () => {
    fx.cleanup();
    restoreConfig();
    rmSync(configDir, { recursive: true, force: true });
    setup(null);
    writeFileSync(path.join(fx.repo, 'n.txt'), 'new');
    await commitAll(fx.repo, 'msg', fallback);
    expect(fx.run(fx.repo, ['log', '-1', '--format=%an <%ae>'])).toBe('Worker <worker@example.invalid>');
  });

  it.skipIf(process.platform === 'win32')("runs the repo's pre-commit hook and surfaces its failure", async () => {
    const hook = path.join(fx.repo, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\necho "lint exploded" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    writeFileSync(path.join(fx.repo, 'n.txt'), 'new');
    await expect(commitAll(fx.repo, 'msg', fallback)).rejects.toThrow('lint exploded');
  });
});

describe('pushBranch', () => {
  it('never forces and reports a rejected push', async () => {
    const dir = wt('p');
    await prepareWorktree(fx.repo, dir, 'task/p', 'main');
    writeFileSync(path.join(dir, 'mine.txt'), 'mine');
    await commitAll(dir, 'mine', { name: 'W', email: 'w@example.invalid' });

    const other = path.join(fx.scratch, 'other');
    fx.run(fx.scratch, ['clone', fx.origin, other]);
    fx.run(other, ['checkout', '-b', 'task/p']);
    writeFileSync(path.join(other, 'theirs.txt'), 'theirs');
    fx.run(other, ['add', 'theirs.txt']);
    fx.run(other, ['commit', '-m', 'theirs']);
    const theirs = fx.run(other, ['rev-parse', 'HEAD']);
    fx.run(other, ['push', 'origin', 'task/p']);

    await expect(pushBranch(dir, 'task/p')).rejects.toThrow(/rejected|non-fast-forward|fetch first/);
    expect(fx.run(fx.origin, ['rev-parse', 'task/p'])).toBe(theirs);
  });

  it('pushes a new branch and sets upstream', async () => {
    const dir = wt('q');
    await prepareWorktree(fx.repo, dir, 'task/q', 'main');
    writeFileSync(path.join(dir, 'q.txt'), 'q');
    const sha = await commitAll(dir, 'q', { name: 'W', email: 'w@example.invalid' });
    await pushBranch(dir, 'task/q');
    expect(fx.run(fx.origin, ['rev-parse', 'task/q'])).toBe(sha);
  });
});

describe('compareUrl', () => {
  it('handles github https, github ssh, gitlab, and unknown hosts', () => {
    const gh = 'https://github.com/o/r/compare/main...feat/x?expand=1';
    expect(compareUrl('https://github.com/o/r.git', 'main', 'feat/x')).toBe(gh);
    expect(compareUrl('https://u:t@github.com/o/r', 'main', 'feat/x')).toBe(gh);
    expect(compareUrl('git@github.com:o/r.git', 'main', 'feat/x')).toBe(gh);
    expect(compareUrl('ssh://git@github.com/o/r.git', 'main', 'feat/x')).toBe(gh);
    expect(compareUrl('https://gitlab.example.com/g/sub/r.git', 'main', 'feat/x y')).toBe(
      'https://gitlab.example.com/g/sub/r/-/merge_requests/new?merge_request[source_branch]=feat%2Fx%20y',
    );
    expect(compareUrl('git@gitlab.com:g/r.git', 'main', 'b')).toBe(
      'https://gitlab.com/g/r/-/merge_requests/new?merge_request[source_branch]=b',
    );
    expect(compareUrl('https://bitbucket.org/o/r.git', 'main', 'b')).toBeUndefined();
    expect(compareUrl('/local/path/origin.git', 'main', 'b')).toBeUndefined();
  });
});

describe('openPullRequest', () => {
  const pr = {
    branch: 'task/x',
    baseBranch: 'main',
    title: 'T',
    body: 'Body "q"',
    remote: 'https://github.com/o/r.git',
  };
  const compare = 'https://github.com/o/r/compare/main...task/x?expand=1';
  type Call = { args: string[]; cwd: string; input?: string };

  function fakeGh(handler: (args: string[]) => { code: number; stdout?: string; stderr?: string }): {
    gh: GhRun;
    calls: Call[];
  } {
    const calls: Call[] = [];
    const gh: GhRun = async (args, opts) => {
      calls.push({ args, ...opts });
      const r = handler(args);
      return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };
    return { gh, calls };
  }

  it('uses gh when authenticated', async () => {
    const { gh, calls } = fakeGh((a) =>
      a[0] === 'auth' ? { code: 0 } : { code: 0, stdout: 'Creating pull request\nhttps://github.com/o/r/pull/7\n' },
    );
    expect(await openPullRequest('/wt', pr, gh)).toEqual({ prUrl: 'https://github.com/o/r/pull/7' });
    expect(calls[0]?.args).toEqual(['auth', 'status']);
    expect(calls[1]?.args).toEqual([
      'pr', 'create', '--base', 'main', '--head', 'task/x', '--title', 'T', '--body-file', '-',
    ]);
    expect(calls[1]?.input).toBe('Body "q"');
    expect(calls[1]?.cwd).toBe('/wt');
  });

  it('returns the existing PR url when gh reports one already exists', async () => {
    const { gh, calls } = fakeGh((a) => {
      if (a[0] === 'auth') return { code: 0 };
      if (a[1] === 'create') return { code: 1, stderr: 'a pull request for branch "task/x" already exists:\nhttps://github.com/o/r/pull/3' };
      return { code: 0, stdout: 'https://github.com/o/r/pull/3\n' };
    });
    expect(await openPullRequest('/wt', pr, gh)).toEqual({ prUrl: 'https://github.com/o/r/pull/3' });
    expect(calls[2]?.args).toEqual(['pr', 'view', 'task/x', '--json', 'url', '-q', '.url']);
  });

  it('falls back to the compare URL when gh auth status fails', async () => {
    const { gh, calls } = fakeGh(() => ({ code: 1 }));
    expect(await openPullRequest('/wt', pr, gh)).toEqual({ compareUrl: compare });
    expect(calls).toHaveLength(1);
  });

  it('falls back to the compare URL when gh is missing or create fails', async () => {
    expect(await openPullRequest('/wt', pr, fakeGh(() => ({ code: 127 })).gh)).toEqual({ compareUrl: compare });
    const failing = fakeGh((a) => (a[0] === 'auth' ? { code: 0 } : { code: 1, stderr: 'boom' }));
    expect(await openPullRequest('/wt', pr, failing.gh)).toEqual({ compareUrl: compare });
  });

  it('returns an empty result for an unknown host without gh', async () => {
    const { gh } = fakeGh(() => ({ code: 127 }));
    expect(await openPullRequest('/wt', { ...pr, remote: '/some/path' }, gh)).toEqual({});
  });
});

describe('removeWorktree', () => {
  it('keeps the branch', async () => {
    const dir = wt('r');
    await prepareWorktree(fx.repo, dir, 'task/r', 'main');
    writeFileSync(path.join(dir, 'dirty.txt'), 'x');
    await removeWorktree(fx.repo, dir);
    expect(existsSync(dir)).toBe(false);
    expect(fx.run(fx.repo, ['branch', '--list', 'task/r'])).toContain('task/r');
  });
});

describe('runners', () => {
  it('git resolves with the exit code instead of rejecting', async () => {
    const r = await git(['rev-parse', '--verify', 'nope'], { cwd: fx.repo });
    expect(r.code).not.toBe(0);
  });

  it('git never prompts and merges env at call time', async () => {
    process.env.CORTEX_TEST_MARK = 'late';
    try {
      const r = await git(['config', '--get', 'user.name'], { cwd: fx.repo });
      expect(r.stdout.trim()).toBe(FIXTURE_GIT_IDENTITY.name);
    } finally {
      delete process.env.CORTEX_TEST_MARK;
    }
  });

  it('a missing gh binary resolves with code 127', async () => {
    const r = await createGh('cortex-no-such-binary')(['auth', 'status'], { cwd: fx.repo });
    expect(r.code).toBe(127);
  });

  it('a missing cwd resolves with code 127 instead of throwing', async () => {
    const r = await git(['status'], { cwd: path.join(fx.root, 'nope') });
    expect(r.code).toBe(127);
  });
});
