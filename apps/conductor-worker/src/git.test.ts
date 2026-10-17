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
  createGitRunner,
  git,
  isLockContention,
  openPullRequest,
  originUrl,
  parseBranchInUse,
  prepareWorktree,
  pushBranch,
  removeWorktree,
  retryOnLock,
  sanitizeRemoteUrl,
  scrubCredentials,
} from './git.js';
import type { GhRun, RunResult } from './git.js';
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

function commitFile(cwd: string, file: string, text: string): string {
  writeFileSync(path.join(cwd, file), text);
  fx.run(cwd, ['add', file]);
  fx.run(cwd, ['commit', '-m', file]);
  return fx.run(cwd, ['rev-parse', 'HEAD']);
}

/** Pushes a commit on `branch` from another clone, as another machine would; returns its sha. */
function pushFromElsewhere(branch: string, file: string): string {
  const other = path.join(fx.scratch, `elsewhere-${file}`);
  fx.run(fx.scratch, ['clone', fx.origin, other]);
  fx.run(other, ['checkout', '-B', branch]);
  const sha = commitFile(other, file, 'theirs');
  fx.run(other, ['push', 'origin', branch]);
  return sha;
}

describe('sanitizeRemoteUrl', () => {
  it('strips userinfo from https and keeps ssh', () => {
    expect(sanitizeRemoteUrl('https://user:secret@github.com/o/r.git')).toBe('https://github.com/o/r.git');
    expect(sanitizeRemoteUrl('https://token@github.com/o/r.git')).toBe('https://github.com/o/r.git');
    expect(sanitizeRemoteUrl('git@github.com:o/r.git')).toBe('git@github.com:o/r.git');
    expect(sanitizeRemoteUrl('https://github.com/o/r.git')).toBe('https://github.com/o/r.git');
    expect(sanitizeRemoteUrl('https://x-access-token:ghp_abc@github.com/o/r.git')).toBe(
      'https://github.com/o/r.git',
    );
  });

  it('keeps the user of non-http schemes and drops only the password', () => {
    expect(sanitizeRemoteUrl('ssh://git@github.com/o/r.git')).toBe('ssh://git@github.com/o/r.git');
    expect(sanitizeRemoteUrl('ssh://u:p@h/o/r.git')).toBe('ssh://u@h/o/r.git');
  });

  it('strips userinfo with a regex when the URL does not parse', () => {
    expect(sanitizeRemoteUrl('https://user:pa ss@exa mple.com/o/r')).not.toContain('pa ss');
    expect(sanitizeRemoteUrl('https://user:pa ss@exa mple.com/o/r')).not.toContain('user');
  });
});

describe('scrubCredentials', () => {
  it('scrubs every URL inside free text', () => {
    const text = 'fatal: unable to access https://u:tok1@host/a.git\nthen ssh://git:pw2@h/b.git and git@h:c.git';
    expect(scrubCredentials(text)).toBe(
      'fatal: unable to access https://host/a.git\nthen ssh://git@h/b.git and git@h:c.git',
    );
  });
});

describe('parseBranchInUse', () => {
  it('reads both git wordings', () => {
    expect(parseBranchInUse("fatal: 'task/x' is already used by worktree at '/p/q'")).toBe('/p/q');
    expect(parseBranchInUse("fatal: 'task/x' is already checked out at '/p/q'")).toBe('/p/q');
    expect(parseBranchInUse('fatal: something else')).toBeNull();
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

  it('starts a clean kept worktree again when origin/<branch> is not in its history', async () => {
    const dir = wt('moved');
    await prepareWorktree(fx.repo, dir, 'task/moved', 'main');
    // the commit an earlier attempt could not push; another machine has pushed the branch since
    commitFile(dir, 'local.txt', 'mine');
    const theirs = pushFromElsewhere('task/moved', 'theirs.txt');
    expect(await prepareWorktree(fx.repo, dir, 'task/moved', 'main')).toEqual({ from: 'branch' });
    expect(fx.run(dir, ['rev-parse', 'HEAD'])).toBe(theirs);
    expect(existsSync(path.join(dir, 'theirs.txt'))).toBe(true);
    expect(existsSync(path.join(dir, 'local.txt'))).toBe(false);
  });

  it('refuses a dirty kept worktree that origin/<branch> has moved past, naming the branch and the path', async () => {
    const dir = wt('moved-dirty');
    await prepareWorktree(fx.repo, dir, 'task/moved-dirty', 'main');
    pushFromElsewhere('task/moved-dirty', 'theirs.txt');
    writeFileSync(path.join(dir, 'wip.txt'), 'uncommitted');
    await expect(prepareWorktree(fx.repo, dir, 'task/moved-dirty', 'main')).rejects.toThrow(
      `the worktree ${dir} has uncommitted changes, and origin/task/moved-dirty has commits it lacks`,
    );
    expect(readFileSync(path.join(dir, 'wip.txt'), 'utf8')).toBe('uncommitted');
  });

  it('reuses a kept worktree, dirty or not, whose history holds origin/<branch>', async () => {
    const dir = wt('ahead');
    await prepareWorktree(fx.repo, dir, 'task/ahead', 'main');
    commitFile(dir, 'pushed.txt', 'pushed');
    fx.run(dir, ['push', 'origin', 'task/ahead']);
    const local = commitFile(dir, 'local.txt', 'not pushed yet');
    writeFileSync(path.join(dir, 'wip.txt'), 'uncommitted');
    expect(await prepareWorktree(fx.repo, dir, 'task/ahead', 'main')).toEqual({ from: 'existing' });
    expect(fx.run(dir, ['rev-parse', 'HEAD'])).toBe(local);
    expect(readFileSync(path.join(dir, 'wip.txt'), 'utf8')).toBe('uncommitted');
  });

  it('clears the stale registration of its own path when the directory is gone', async () => {
    const dir = wt('gone');
    await prepareWorktree(fx.repo, dir, 'task/gone', 'main');
    rmSync(dir, { recursive: true, force: true });
    expect(await prepareWorktree(fx.repo, dir, 'task/gone', 'main')).toEqual({ from: 'base' });
    expect(fx.run(dir, ['branch', '--show-current'])).toBe('task/gone');

    // a stale registration on another branch is cleared the same way
    rmSync(dir, { recursive: true, force: true });
    expect(await prepareWorktree(fx.repo, dir, 'task/gone-2', 'main')).toEqual({ from: 'base' });
    expect(fx.run(dir, ['branch', '--show-current'])).toBe('task/gone-2');
  });

  it("leaves the user's own stale worktree registrations alone", async () => {
    const theirs = path.join(fx.scratch, 'on-an-unmounted-volume');
    fx.run(fx.repo, ['worktree', 'add', '-b', 'feature/usb', theirs]);
    rmSync(theirs, { recursive: true, force: true });
    await prepareWorktree(fx.repo, wt('n'), 'task/n', 'main');
    expect(fx.run(fx.repo, ['worktree', 'list', '--porcelain'])).toContain(`worktree ${theirs}\n`);
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

  it("writes no tracking to the clone's config, so a worker sharing the clone cannot collide on it", async () => {
    pushFromElsewhere('task/t2', 't2.txt');
    // another worker in the same clone holding .git/config
    writeFileSync(path.join(fx.repo, '.git', 'config.lock'), '');
    await prepareWorktree(fx.repo, wt('t1'), 'task/t1', 'main');
    await prepareWorktree(fx.repo, wt('t2'), 'task/t2', 'main');
    rmSync(path.join(fx.repo, '.git', 'config.lock'));
    for (const b of ['task/t1', 'task/t2']) {
      expect((await git(['config', '--get', `branch.${b}.merge`], { cwd: fx.repo })).code).toBe(1);
    }
  });

  it('waits out a ref lock held by another git process in the same clone', async () => {
    const sha = pushFromElsewhere('main', 'moved.txt');
    // a fetch by the other worker holds origin/main for a moment
    const lock = path.join(fx.repo, '.git', 'refs', 'remotes', 'origin', 'main.lock');
    mkdirSync(path.dirname(lock), { recursive: true });
    writeFileSync(lock, '');
    const release = setTimeout(() => rmSync(lock, { force: true }), 300);
    try {
      const dir = wt('locked');
      await prepareWorktree(fx.repo, dir, 'task/locked', 'main');
      expect(fx.run(dir, ['rev-parse', 'HEAD'])).toBe(sha);
    } finally {
      clearTimeout(release);
      rmSync(lock, { force: true });
    }
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

  it('does not leak credentials from a failing fetch', async () => {
    fx.run(fx.repo, ['remote', 'set-url', 'origin', 'https://u:tok123@127.0.0.1:9/o/r.git']);
    const err = await prepareWorktree(fx.repo, wt('leak'), 'task/leak', 'main').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain('tok123');
  });

  it('refuses to replace the parent of the repo', async () => {
    await expect(prepareWorktree(fx.repo, fx.root, 'task/p1', 'main')).rejects.toThrow(
      `refusing to replace ${fx.root}`,
    );
    expect(existsSync(path.join(fx.repo, '.git'))).toBe(true);
    expect(existsSync(path.join(fx.root, 'origin.git'))).toBe(true);
  });

  it('refuses a directory inside the repo', async () => {
    const inside = path.join(fx.repo, 'sub');
    mkdirSync(inside);
    await expect(prepareWorktree(fx.repo, inside, 'task/p2', 'main')).rejects.toThrow('refusing to replace');
    expect(existsSync(inside)).toBe(true);
  });

  it('refuses a directory holding its own repository', async () => {
    const other = wt('own-repo');
    mkdirSync(other);
    fx.run(other, ['init']);
    writeFileSync(path.join(other, 'keep.txt'), 'precious');
    await expect(prepareWorktree(fx.repo, other, 'task/p3', 'main')).rejects.toThrow('refusing to replace');
    expect(readFileSync(path.join(other, 'keep.txt'), 'utf8')).toBe('precious');
    expect(existsSync(path.join(other, '.git'))).toBe(true);
  });

  it('still replaces an orphan with a .git pointer file', async () => {
    const dir = wt('stale');
    mkdirSync(dir);
    writeFileSync(path.join(dir, '.git'), 'gitdir: /nowhere/.git/worktrees/stale\n');
    writeFileSync(path.join(dir, 'junk.txt'), 'stale');
    expect(await prepareWorktree(fx.repo, dir, 'task/p4', 'main')).toEqual({ from: 'base' });
    expect(existsSync(path.join(dir, 'junk.txt'))).toBe(false);
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

  it('pushes a new branch without writing an upstream to the shared config', async () => {
    const dir = wt('q');
    await prepareWorktree(fx.repo, dir, 'task/q', 'main');
    writeFileSync(path.join(dir, 'q.txt'), 'q');
    const sha = await commitAll(dir, 'q', { name: 'W', email: 'w@example.invalid' });
    await pushBranch(dir, 'task/q');
    expect(fx.run(fx.origin, ['rev-parse', 'task/q'])).toBe(sha);
    expect((await git(['config', '--get', 'branch.task/q.remote'], { cwd: fx.repo })).code).toBe(1);
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

describe('retryOnLock', () => {
  const locked = (stderr: string): RunResult => ({ code: 128, stdout: '', stderr });
  const ok: RunResult = { code: 0, stdout: 'done', stderr: '' };
  const noSleep = async (): Promise<void> => undefined;

  it.each([
    "error: cannot lock ref 'refs/remotes/origin/main': is at 1a2b but expected 3c4d",
    'error: could not lock config file .git/config: File exists',
    "fatal: Unable to create '/r/.git/refs/heads/x.lock': File exists.",
    'Another git process seems to be running in this repository',
  ])('recognises lock contention: %s', (stderr) => {
    expect(isLockContention(locked(stderr))).toBe(true);
  });

  it('runs again after a lock failure, cleaning up first, and returns the success', async () => {
    const results = [locked('error: could not lock config file .git/config: File exists'), ok];
    const calls: string[] = [];
    const r = await retryOnLock(
      async () => {
        calls.push('attempt');
        return results.shift()!;
      },
      { beforeRetry: async () => void calls.push('cleanup'), sleep: noSleep },
    );
    expect(r).toBe(ok);
    expect(calls).toEqual(['attempt', 'cleanup', 'attempt']);
  });

  it('returns any other failure at once', async () => {
    let n = 0;
    const failed: RunResult = { code: 128, stdout: '', stderr: 'fatal: invalid reference: origin/nope' };
    const r = await retryOnLock(async () => (n++, failed), { sleep: noSleep });
    expect(r).toBe(failed);
    expect(n).toBe(1);
  });

  it('gives up after the last pause and returns the lock failure', async () => {
    let n = 0;
    const slept: number[] = [];
    const busy = locked('Another git process seems to be running in this repository');
    const r = await retryOnLock(async () => (n++, busy), {
      delaysMs: [100, 200],
      sleep: async (ms) => void slept.push(ms),
    });
    expect(r).toBe(busy);
    expect(n).toBe(3);
    // jittered by at most a quarter either way
    expect(slept[0]).toBeGreaterThanOrEqual(75);
    expect(slept[0]).toBeLessThanOrEqual(125);
    expect(slept[1]).toBeGreaterThanOrEqual(150);
    expect(slept[1]).toBeLessThanOrEqual(250);
  });
});

describe('runners', () => {
  it('git resolves with the exit code instead of rejecting', async () => {
    const r = await git(['rev-parse', '--verify', 'nope'], { cwd: fx.repo });
    expect(r.code).not.toBe(0);
  });

  it.skipIf(process.platform === 'win32')('git children get the unattended env, merged at call time', async () => {
    process.env.CORTEX_TEST_MARK = 'late-marker';
    try {
      const r = await git(['-c', 'alias.e=!env', 'e'], { cwd: fx.repo });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('GIT_TERMINAL_PROMPT=0');
      expect(r.stdout).toContain('GCM_INTERACTIVE=never');
      expect(r.stdout).toContain('CORTEX_TEST_MARK=late-marker');
    } finally {
      delete process.env.CORTEX_TEST_MARK;
    }
  });

  it.skipIf(process.platform === 'win32')('a child over the ceiling resolves 124 and its group is gone', async () => {
    const run = createGitRunner({ bin: process.execPath, ceilingMs: 200 });
    const r = await run(['-e', 'console.log(process.pid); setTimeout(() => {}, 60000)'], { cwd: fx.root });
    expect(r.code).toBe(124);
    const pid = Number(r.stdout.trim());
    expect(pid).toBeGreaterThan(0);
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      try {
        process.kill(-pid, 0);
        await new Promise((res) => setTimeout(res, 50));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
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
