import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Shared by the git, orchestrator and runner tests. Must not import vitest.

export interface GitFixture {
  /** Temp root holding everything below; removed by `cleanup`. */
  root: string;
  /** Bare origin with `main` holding README.md. */
  origin: string;
  /** Clone of origin with `main` checked out. */
  repo: string;
  /** Directory for worktrees and extra clones. */
  scratch: string;
  /** Runs git synchronously in `cwd` and returns trimmed stdout; throws on failure. */
  run: (cwd: string, args: string[], input?: string) => string;
  cleanup: () => void;
}

const FIXTURE_IDENTITY = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid'];

function sh(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd,
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

export function createGitFixture(): GitFixture {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'cortex-git-fixture-')));
  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'repo');
  const scratch = path.join(root, 'scratch');
  mkdirSync(scratch);
  const run = (cwd: string, args: string[], input?: string): string => sh(cwd, args, input);

  sh(root, ['-c', 'init.defaultBranch=main', 'init', '--bare', origin]);
  const seed = path.join(root, 'seed');
  sh(root, ['-c', 'init.defaultBranch=main', 'init', seed]);
  writeFileSync(path.join(seed, 'README.md'), '# fixture\n');
  sh(seed, ['add', 'README.md']);
  sh(seed, [...FIXTURE_IDENTITY, 'commit', '-m', 'init']);
  sh(seed, ['push', origin, 'main']);
  rmSync(seed, { recursive: true, force: true });
  sh(root, ['-c', 'init.defaultBranch=main', 'clone', origin, repo]);

  return {
    root,
    origin,
    repo,
    scratch,
    run,
    cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 3 }),
  };
}

/**
 * Points git at a throwaway global config so the developer's hooksPath, gpgsign and
 * defaultBranch never leak into a test. Returns a function that restores the previous env.
 */
export function isolateGitConfig(
  dir: string,
  identity: { name: string; email: string } | null,
): () => void {
  const file = path.join(dir, 'gitconfig-global');
  const body =
    identity === null ? '' : `[user]\n\tname = ${identity.name}\n\temail = ${identity.email}\n`;
  writeFileSync(file, body);
  const keys = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'HOME'] as const;
  const previous = keys.map((k) => process.env[k]);
  process.env.GIT_CONFIG_GLOBAL = file;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  if (process.platform === 'win32') {
    // Git for Windows only honours GIT_CONFIG_GLOBAL from 2.32; before that it reads ~/.gitconfig,
    // and on Windows git finds ~ through HOME (node's homedir() does not, so only git sees this).
    writeFileSync(path.join(dir, '.gitconfig'), body);
    process.env.HOME = dir;
  }
  return () => {
    keys.forEach((k, i) => {
      const v = previous[i];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
  };
}

export const FIXTURE_GIT_IDENTITY = { name: 'Fixture', email: 'fixture@example.invalid' };
