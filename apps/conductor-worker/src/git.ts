import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { exitCodeOf, killTree, lastLines, resolveCommand, spawnTracked } from './process.js';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type GitRun = (args: string[], opts: { cwd: string; input?: string }) => Promise<RunResult>;
export type GhRun = (args: string[], opts: { cwd: string; input?: string }) => Promise<RunResult>;

const CEILING_MS = 10 * 60 * 1000;
const TIMEOUT_CODE = 124;
const SPAWN_FAILED_CODE = 127;
const OUTPUT_CAP = 1024 * 1024;
const DRAIN_MS = 250;

function runChild(
  bin: string,
  extraEnv: Record<string, string>,
  args: string[],
  opts: { cwd: string; input?: string },
): Promise<RunResult> {
  return (async (): Promise<RunResult> => {
    let tracked;
    try {
      tracked = spawnTracked(bin, args, {
        cwd: opts.cwd,
        // read at call time so a test (or the user) changing process.env is honoured
        env: { ...process.env, ...extraEnv },
        ...(opts.input !== undefined ? { stdin: opts.input } : {}),
      });
    } catch (err) {
      return { code: SPAWN_FAILED_CODE, stdout: '', stderr: (err as Error).message };
    }
    let stdout = '';
    let stderr = '';
    const collect =
      (set: (v: string) => void, get: () => string) =>
      (chunk: string): void => {
        let v = get() + chunk;
        if (v.length > OUTPUT_CAP * 2) v = v.slice(-OUTPUT_CAP);
        set(v);
      };
    tracked.stdout.setEncoding('utf8');
    tracked.stderr.setEncoding('utf8');
    tracked.stdout.on('data', collect((v) => (stdout = v), () => stdout));
    tracked.stderr.on('data', collect((v) => (stderr = v), () => stderr));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void killTree(tracked.pid);
    }, CEILING_MS);
    const { code, signal } = await tracked.exited;
    clearTimeout(timer);

    // let the last chunks arrive, but never wait on a grandchild holding the pipe
    let drainTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(
        [tracked.stdout, tracked.stderr].map(
          (s) => new Promise<void>((r) => (s.readableEnded ? r() : void s.once('close', () => r()))),
        ),
      ),
      new Promise<void>((r) => {
        drainTimer = setTimeout(r, DRAIN_MS);
      }),
    ]);
    clearTimeout(drainTimer);
    tracked.stdout.destroy();
    tracked.stderr.destroy();

    const exit = timedOut ? TIMEOUT_CODE : exitCodeOf(code, signal);
    if (exit === SPAWN_FAILED_CODE && tracked.spawnError !== undefined) {
      stderr += (stderr === '' ? '' : '\n') + tracked.spawnError;
    }
    return { code: exit, stdout, stderr };
  })();
}

export const git: GitRun = (args, opts) =>
  runChild('git', { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, args, opts);

export function createGh(bin: string = process.env.CORTEX_GH_BIN ?? 'gh'): GhRun {
  return (args, opts) =>
    runChild(resolveCommand(bin) ?? bin, { GH_PROMPT_DISABLED: '1' }, args, opts);
}

// --- URLs ---

export function sanitizeRemoteUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      if (u.username === '' && u.password === '') return url;
      u.username = '';
      u.password = '';
      return u.toString();
    } catch {
      // fall through to the regex
    }
  }
  return url.replace(/\/\/[^/]*@/, '//');
}

export async function originUrl(repo: string): Promise<string | null> {
  const r = await git(['remote', 'get-url', 'origin'], { cwd: repo });
  const url = r.stdout.trim();
  return r.code === 0 && url !== '' ? sanitizeRemoteUrl(url) : null;
}

function parseRemote(remote: string): { host: string; path: string } | null {
  const scp = /^[\w.-]+@([^:/\s]+):(?!\/)(.+)$/.exec(remote);
  let host: string;
  let p: string;
  if (scp?.[1] !== undefined && scp[2] !== undefined) {
    host = scp[1];
    p = scp[2];
  } else {
    try {
      const u = new URL(remote);
      if (!['http:', 'https:', 'ssh:', 'git:'].includes(u.protocol)) return null;
      host = u.hostname;
      p = u.pathname;
    } catch {
      return null;
    }
  }
  p = p.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  return host === '' || p === '' ? null : { host: host.toLowerCase(), path: p };
}

export function compareUrl(remote: string, baseBranch: string, branch: string): string | undefined {
  const parsed = parseRemote(sanitizeRemoteUrl(remote));
  if (parsed === null) return undefined;
  if (parsed.host === 'github.com') {
    return `https://github.com/${parsed.path}/compare/${baseBranch}...${branch}?expand=1`;
  }
  if (parsed.host.includes('gitlab')) {
    return `https://${parsed.host}/${parsed.path}/-/merge_requests/new?merge_request[source_branch]=${encodeURIComponent(branch)}`;
  }
  return undefined;
}

// --- worktrees ---

export class BranchInUseError extends Error {
  constructor(
    public branch: string,
    public path: string,
  ) {
    super(`branch ${branch} is already checked out at ${path}`);
    this.name = 'BranchInUseError';
  }
}

/** realpath of an existing path, else the resolved path (macOS /var is /private/var). */
function canonical(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function tail(r: RunResult): string {
  return lastLines((r.stderr.trim() !== '' ? r.stderr : r.stdout).trim(), 20);
}

interface WorktreeEntry {
  path: string;
  /** Short branch name, or null when detached/bare. */
  branch: string | null;
}

async function listWorktrees(repo: string): Promise<WorktreeEntry[]> {
  const r = await git(['worktree', 'list', '--porcelain'], { cwd: repo });
  if (r.code !== 0) throw new Error(`git worktree list failed: ${tail(r)}`);
  const entries: WorktreeEntry[] = [];
  for (const block of r.stdout.split(/\r?\n\r?\n/)) {
    let p: string | undefined;
    let branch: string | null = null;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) p = line.slice('worktree '.length);
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
    if (p !== undefined) entries.push({ path: p, branch });
  }
  return entries;
}

export async function branchCheckedOutAt(
  repo: string,
  branch: string,
  ownDir: string,
): Promise<string | null> {
  const own = canonical(ownDir);
  for (const e of await listWorktrees(repo)) {
    if (e.branch === branch && canonical(e.path) !== own) return e.path;
  }
  return null;
}

async function remoteRefExists(repo: string, branch: string): Promise<boolean> {
  const r = await git(['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { cwd: repo });
  return r.code === 0;
}

export async function prepareWorktree(
  repo: string,
  dir: string,
  branch: string,
  baseBranch: string,
): Promise<{ from: 'branch' | 'base' | 'existing' }> {
  const fetch = await git(['fetch', 'origin', '--prune'], { cwd: repo });
  if (fetch.code !== 0) throw new Error(`git fetch failed: ${tail(fetch)}`);
  await git(['worktree', 'prune'], { cwd: repo });

  const here = canonical(dir);
  const registered = (await listWorktrees(repo)).find((e) => canonical(e.path) === here);
  if (registered !== undefined) {
    if (registered.branch === branch) return { from: 'existing' };
    throw new Error(`worktree ${dir} holds ${registered.branch ?? 'a detached HEAD'}, expected ${branch}`);
  }

  const elsewhere = await branchCheckedOutAt(repo, branch, dir);
  if (elsewhere !== null) throw new BranchInUseError(branch, elsewhere);

  let from: 'branch' | 'base';
  if (await remoteRefExists(repo, branch)) from = 'branch';
  else if (await remoteRefExists(repo, baseBranch)) from = 'base';
  else throw new Error(`base branch ${baseBranch} not found on origin`);

  // an orphan left behind after a prune: git refuses to add into a non-empty directory
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.dirname(dir), { recursive: true });

  const start = `origin/${from === 'branch' ? branch : baseBranch}`;
  const add = await git(['worktree', 'add', '-B', branch, dir, start], { cwd: repo });
  if (add.code !== 0) {
    const used =
      /is already used by worktree at '([^']+)'/.exec(add.stderr) ??
      /is already checked out at '([^']+)'/.exec(add.stderr);
    if (used?.[1] !== undefined) throw new BranchInUseError(branch, used[1]);
    throw new Error(`git worktree add failed: ${tail(add)}`);
  }
  return { from };
}

export async function removeWorktree(repo: string, dir: string): Promise<void> {
  const r = await git(['worktree', 'remove', '--force', dir], { cwd: repo });
  if (r.code !== 0) throw new Error(`git worktree remove failed: ${tail(r)}`);
}

// --- commit, push, PR ---

export async function commitAll(
  dir: string,
  message: string,
  fallbackIdentity: { name: string; email: string },
): Promise<string | null> {
  const add = await git(['add', '-A'], { cwd: dir });
  if (add.code !== 0) throw new Error(`git add failed: ${tail(add)}`);
  const status = await git(['status', '--porcelain'], { cwd: dir });
  if (status.code !== 0) throw new Error(`git status failed: ${tail(status)}`);
  if (status.stdout.trim() === '') return null;

  const email = await git(['config', 'user.email'], { cwd: dir });
  const identity =
    email.code !== 0 || email.stdout.trim() === ''
      ? ['-c', `user.name=${fallbackIdentity.name}`, '-c', `user.email=${fallbackIdentity.email}`]
      : [];
  const commit = await git([...identity, 'commit', '-F', '-'], { cwd: dir, input: message });
  if (commit.code !== 0) {
    // hooks print to either stream
    throw new Error(`git commit failed: ${lastLines(`${commit.stdout}\n${commit.stderr}`.trim(), 40)}`);
  }
  const head = await git(['rev-parse', 'HEAD'], { cwd: dir });
  if (head.code !== 0) throw new Error(`git rev-parse failed: ${tail(head)}`);
  return head.stdout.trim();
}

export async function pushBranch(dir: string, branch: string): Promise<void> {
  const r = await git(['push', '-u', 'origin', branch], { cwd: dir });
  if (r.code !== 0) throw new Error(`git push failed: ${tail(r)}`);
}

export async function openPullRequest(
  dir: string,
  p: { branch: string; baseBranch: string; title: string; body: string; remote: string },
  gh: GhRun,
): Promise<{ prUrl?: string; compareUrl?: string }> {
  const fallback = (): { compareUrl?: string } => {
    const url = compareUrl(p.remote, p.baseBranch, p.branch);
    return url === undefined ? {} : { compareUrl: url };
  };
  const urlFrom = (out: string): string | undefined =>
    out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('http'))
      .pop();

  const auth = await gh(['auth', 'status'], { cwd: dir });
  if (auth.code !== 0) return fallback();

  const create = await gh(
    ['pr', 'create', '--base', p.baseBranch, '--head', p.branch, '--title', p.title, '--body-file', '-'],
    { cwd: dir, input: p.body },
  );
  if (create.code === 0) {
    const prUrl = urlFrom(create.stdout);
    return prUrl === undefined ? fallback() : { prUrl };
  }
  if (/already exists/i.test(`${create.stderr}\n${create.stdout}`)) {
    const view = await gh(['pr', 'view', p.branch, '--json', 'url', '-q', '.url'], { cwd: dir });
    const prUrl = view.code === 0 ? urlFrom(view.stdout) : undefined;
    if (prUrl !== undefined) return { prUrl };
  }
  return fallback();
}
