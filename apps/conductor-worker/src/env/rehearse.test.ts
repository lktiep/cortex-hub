import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { git } from '../git.js';
import { runShell } from '../process.js';
import { createGitFixture, FIXTURE_GIT_IDENTITY, isolateGitConfig } from '../test-utils/git-fixture.js';
import type { GitFixture } from '../test-utils/git-fixture.js';
import { rehearse, trialFingerprint } from './rehearse.js';
import type { RehearseDeps } from './rehearse.js';

let fx: GitFixture;
let restoreGit: () => void;

beforeEach(() => {
  fx = createGitFixture();
  restoreGit = isolateGitConfig(fx.root, FIXTURE_GIT_IDENTITY);
});

afterEach(() => {
  restoreGit();
  fx.cleanup();
});

/** Commits `files` on main and pushes them, so origin/main has them. */
function publish(files: Record<string, string | object>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(fx.repo, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    fx.run(fx.repo, ['add', rel]);
  }
  fx.run(fx.repo, ['commit', '-m', 'files']);
  fx.run(fx.repo, ['push', 'origin', 'main']);
}

const deps = (over: Partial<RehearseDeps> = {}): RehearseDeps => ({
  git,
  runShell,
  env: { ...process.env, CORTEX_SETUP_CMD: '', CORTEX_TEST_CMD: '' },
  timeoutMs: 30_000,
  tmpRoot: fx.scratch,
  ...over,
});

const worktrees = (): string[] => fx.run(fx.repo, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree '));

describe.skipIf(process.platform === 'win32')('rehearse', () => {
  it('runs setup, then test, on origin/HEAD, and leaves nothing behind', async () => {
    fx.run(fx.repo, ['commit', '--allow-empty', '-m', 'local only']);
    const r = await rehearse(
      fx.repo,
      deps({ env: { ...process.env, CORTEX_SETUP_CMD: 'echo set up > made.txt', CORTEX_TEST_CMD: 'cat made.txt && git log -1 --format=%s' } }),
    );
    expect(r).toMatchObject({ ref: 'origin/main', ok: true, notes: [] });
    expect(r.steps).toEqual([
      { name: 'setup', command: 'echo set up > made.txt', exitCode: 0, timedOut: false, tail: '' },
      { name: 'test', command: 'cat made.txt && git log -1 --format=%s', exitCode: 0, timedOut: false, tail: 'set up\ninit' },
    ]);
    expect(worktrees()).toHaveLength(1);
    expect(readdirSync(fx.scratch)).toEqual([]);
  });

  it('says when each step starts', async () => {
    const started: string[] = [];
    await rehearse(
      fx.repo,
      deps({ env: { ...process.env, CORTEX_SETUP_CMD: 'true', CORTEX_TEST_CMD: 'true' }, onStep: (n, c) => started.push(`${n}: ${c}`) }),
    );
    expect(started).toEqual(['setup: true', 'test: true']);
  });

  it('reads the commands from the profile on that branch', async () => {
    publish({ '.cortex/project-profile.json': { worker: { setupCommand: 'echo from profile', testCommand: 'exit 3' } } });
    const r = await rehearse(fx.repo, deps());
    expect(r.ok).toBe(false);
    expect(r.steps.map((s) => [s.name, s.exitCode, s.tail])).toEqual([
      ['setup', 0, 'from profile'],
      ['test', 3, ''],
    ]);
  });

  it('skips the test when setup fails', async () => {
    const r = await rehearse(fx.repo, deps({ env: { ...process.env, CORTEX_SETUP_CMD: 'echo no network; exit 7', CORTEX_TEST_CMD: 'echo never' } }));
    expect(r.ok).toBe(false);
    expect(r.steps).toEqual([expect.objectContaining({ name: 'setup', exitCode: 7, tail: 'no network' })]);
  });

  it('says so when there is nothing to try', async () => {
    const r = await rehearse(fx.repo, deps());
    expect(r).toMatchObject({ ok: true, steps: [], notes: ['no setup or test command to try'] });
    expect(worktrees()).toHaveLength(1);
  });

  it('falls back to HEAD without origin/HEAD', async () => {
    fx.run(fx.repo, ['remote', 'set-head', 'origin', '--delete']);
    const r = await rehearse(fx.repo, deps({ env: { ...process.env, CORTEX_TEST_CMD: 'true' } }));
    expect(r).toMatchObject({ ref: 'HEAD', ok: true });
    expect(r.notes[0]).toMatch(/origin\/HEAD is not set/);
  });

  it('reports a timeout and still cleans up', async () => {
    const r = await rehearse(fx.repo, deps({ timeoutMs: 300, env: { ...process.env, CORTEX_TEST_CMD: 'sleep 5' } }));
    expect(r.ok).toBe(false);
    expect(r.steps[0]).toMatchObject({ name: 'test', timedOut: true, exitCode: 124 });
    expect(worktrees()).toHaveLength(1);
    expect(existsSync(fx.scratch) && readdirSync(fx.scratch)).toEqual([]);
  });

  it('scrubs credentials from the output', async () => {
    const r = await rehearse(fx.repo, deps({ env: { ...process.env, CORTEX_TEST_CMD: 'echo https://u:k-sekrit@example.invalid/x.git; exit 1' } }));
    expect(r.steps[0]?.tail).not.toContain('k-sekrit');
  });

  it('is an error, not a crash, outside a git repository', async () => {
    const r = await rehearse(fx.scratch, deps({ tmpRoot: fx.root }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^could not make a trial worktree/);
  });
});

describe.skipIf(process.platform === 'win32')('trialFingerprint', () => {
  const env = { CORTEX_SETUP_CMD: '', CORTEX_TEST_CMD: '' };

  it('changes with the files that say what the project needs, and with this machine\'s commands', async () => {
    const first = await trialFingerprint(fx.repo, git, env);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    publish({ 'src/app.ts': 'export {};\n' });
    expect(await trialFingerprint(fx.repo, git, env)).toBe(first);
    publish({ 'pnpm-lock.yaml': 'lockfileVersion: 9.0\n' });
    const second = await trialFingerprint(fx.repo, git, env);
    expect(second).not.toBe(first);
    publish({ '.husky/pre-push': 'docker run x\n' });
    expect(await trialFingerprint(fx.repo, git, env)).not.toBe(second);
    expect(await trialFingerprint(fx.repo, git, { ...env, CORTEX_TEST_CMD: 'make test' })).not.toBe(second);
  });

  it('reads the branch tasks start from, not the checkout', async () => {
    const before = await trialFingerprint(fx.repo, git, env);
    writeFileSync(path.join(fx.repo, 'package.json'), '{}');
    fx.run(fx.repo, ['add', 'package.json']);
    fx.run(fx.repo, ['commit', '-m', 'local only']);
    expect(await trialFingerprint(fx.repo, git, env)).toBe(before);
  });

  it('is null outside a git repository', async () => {
    expect(await trialFingerprint(fx.scratch, git, env)).toBeNull();
  });
});
