import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { exitCodeOf, killTree, lastLines, resolveCommand, spawnTracked } from './process.js';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
/**
 * `timeoutMs` replaces the ceiling, for a command that runs the repository's own hooks: a
 * pre-push verify can take longer than any network wait. `env` adds variables for the command
 * and the hooks it runs.
 */
export type GitRun = (
  args: string[],
  opts: { cwd: string; input?: string; timeoutMs?: number; env?: Record<string, string> },
) => Promise<RunResult>;
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
  opts: { cwd: string; input?: string; timeoutMs?: number; env?: Record<string, string> },
  ceilingMs: number,
): Promise<RunResult> {
  return (async (): Promise<RunResult> => {
    let tracked;
    try {
      tracked = spawnTracked(bin, args, {
        cwd: opts.cwd,
        // read at call time so a test (or the user) changing process.env is honoured; a
        // caller's env never turns the prompts back on
        env: { ...process.env, ...opts.env, ...extraEnv },
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
    }, opts.timeoutMs ?? ceilingMs);
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

/** Internal factory; `ceilingMs` and `bin` exist so the ceiling can be tested. */
export function createGitRunner(o: { bin?: string; ceilingMs?: number } = {}): GitRun {
  return (args, opts) =>
    runChild(
      o.bin ?? 'git',
      { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      args,
      opts,
      o.ceilingMs ?? CEILING_MS,
    );
}

export const git: GitRun = createGitRunner();

/** Another git process holds one of the clone's locks: two workers sharing one clone. */
const LOCK_CONTENTION =
  /cannot lock ref|could not lock config file|Unable to create '[^']*\.lock'|unable to update local ref|is at [0-9a-f]+ but expected|Another git process seems to be running/i;
/** Pauses before each retry: six attempts over about 8 s. */
const LOCK_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000];

export function isLockContention(r: RunResult): boolean {
  return r.code !== 0 && LOCK_CONTENTION.test(`${r.stderr}\n${r.stdout}`);
}

/**
 * Runs `attempt` again after a pause while it fails on a lock another git process holds, as
 * when two workers share one clone and one fetches while the other adds a worktree.
 * `beforeRetry` undoes what a failed attempt left behind. Any other failure returns at once.
 */
export async function retryOnLock(
  attempt: () => Promise<RunResult>,
  o: {
    beforeRetry?: () => Promise<void>;
    delaysMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<RunResult> {
  const delays = o.delaysMs ?? LOCK_RETRY_DELAYS_MS;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let r = await attempt();
  for (const delay of delays) {
    if (!isLockContention(r)) return r;
    // jitter, so two waiting workers do not retry in step
    await sleep(Math.round(delay * (0.75 + Math.random() / 2)));
    await o.beforeRetry?.();
    r = await attempt();
  }
  return r;
}

export function createGh(bin: string = process.env.CORTEX_GH_BIN ?? 'gh'): GhRun {
  return (args, opts) =>
    runChild(resolveCommand(bin) ?? bin, { GH_PROMPT_DISABLED: '1' }, args, opts, CEILING_MS);
}

// --- URLs ---

/** http(s) loses all userinfo; any other scheme loses only the password and keeps the user. */
function stripUserinfo(scheme: string, userinfo: string, original: string): string {
  if (/^https?$/i.test(scheme)) return `${scheme}://`;
  const colon = userinfo.indexOf(':');
  return colon < 0 ? original : `${scheme}://${userinfo.slice(0, colon)}@`;
}

export function sanitizeRemoteUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*):\/\/([^/]*)@/i, (m, scheme: string, userinfo: string) =>
    stripUserinfo(scheme, userinfo, m),
  );
}

/** Applies the sanitising rules to every URL inside free text (git and gh output). */
export function scrubCredentials(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*):\/\/([^\s/]*)@/gi, (m, scheme: string, userinfo: string) =>
    stripUserinfo(scheme, userinfo, m),
  );
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

/** The end of what git printed. Both streams: hooks print their reasons on stdout. */
function tail(r: RunResult, lines = 20): string {
  return scrubCredentials(lastLines(`${r.stdout}\n${r.stderr}`.trim(), lines));
}

/** `what` failed: said plainly when it was the time limit that stopped it. */
function failed(what: string, r: RunResult, timeoutMs: number): string {
  const after = timeoutMs >= 60_000 ? `${String(Math.round(timeoutMs / 60_000))} min` : `${String(Math.round(timeoutMs / 1000))} s`;
  const limit = r.code === TIMEOUT_CODE ? ` (stopped after ${after})` : '';
  return `${what} failed${limit}: ${tail(r, 40)}`;
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

/** Path from git's "branch is already used by / checked out at" error, else null. */
export function parseBranchInUse(stderr: string): string | null {
  const m =
    /is already used by worktree at '([^']+)'/.exec(stderr) ??
    /is already checked out at '([^']+)'/.exec(stderr);
  return m?.[1] ?? null;
}

function isSameOrUnder(child: string, parent: string): boolean {
  if (child === parent) return true;
  const prefix = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(prefix);
}

function holdsOwnRepository(dir: string): boolean {
  try {
    return lstatSync(path.join(dir, '.git')).isDirectory();
  } catch {
    return false; // missing, or a stale pointer file: both are fine to replace
  }
}

function assertSafeToReplace(repo: string, dir: string): void {
  const d = canonical(dir);
  const r = canonical(repo);
  if (isSameOrUnder(r, d) || isSameOrUnder(d, r) || holdsOwnRepository(dir)) {
    throw new Error(`refusing to replace ${dir}`);
  }
}

async function remoteRefExists(repo: string, branch: string): Promise<boolean> {
  const r = await git(['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { cwd: repo });
  return r.code === 0;
}

/** True when `origin/<branch>` exists and is not in the history of the worktree's HEAD. */
async function missesRemoteWork(repo: string, dir: string, branch: string): Promise<boolean> {
  if (!(await remoteRefExists(repo, branch))) return false;
  const r = await git(['merge-base', '--is-ancestor', `origin/${branch}`, 'HEAD'], { cwd: dir });
  if (r.code === 0) return false;
  if (r.code === 1) return true;
  throw new Error(`could not compare the worktree ${dir} with origin/${branch}: ${tail(r)}`);
}

export async function prepareWorktree(
  repo: string,
  dir: string,
  branch: string,
  baseBranch: string,
): Promise<{ from: 'branch' | 'base' | 'existing' }> {
  const fetch = await retryOnLock(() => git(['fetch', 'origin', '--prune'], { cwd: repo }));
  if (fetch.code !== 0) throw new Error(`git fetch failed: ${tail(fetch)}`);

  // no `git worktree prune`: it would also drop the user's own registrations of missing paths
  const here = canonical(dir);
  const registered = (await listWorktrees(repo)).find((e) => canonical(e.path) === here);
  if (registered !== undefined && !existsSync(dir)) {
    // this path's directory is gone; its stale registration would block the add below
    await removeWorktree(repo, dir);
  } else if (registered !== undefined) {
    if (registered.branch !== branch) {
      throw new Error(`worktree ${dir} holds ${registered.branch ?? 'a detached HEAD'}, expected ${branch}`);
    }
    if (!(await missesRemoteWork(repo, dir, branch))) return { from: 'existing' };
    // another machine pushed the branch since this worktree was kept: start again from it
    const status = await git(['status', '--porcelain'], { cwd: dir });
    if (status.code !== 0) throw new Error(`git status failed in ${dir}: ${tail(status)}`);
    if (status.stdout.trim() !== '') {
      throw new Error(
        `the worktree ${dir} has uncommitted changes, and origin/${branch} has commits it lacks; ` +
          `commit or discard the changes there, or remove the worktree`,
      );
    }
    await removeWorktree(repo, dir);
  }

  const elsewhere = await branchCheckedOutAt(repo, branch, dir);
  if (elsewhere !== null) throw new BranchInUseError(branch, elsewhere);

  let from: 'branch' | 'base';
  if (await remoteRefExists(repo, branch)) from = 'branch';
  else if (await remoteRefExists(repo, baseBranch)) from = 'base';
  else throw new Error(`base branch ${baseBranch} not found on origin`);

  // an orphan: a directory without a registration, such as one a crashed add left behind or
  // whose registration the user pruned; git refuses to add into a non-empty directory
  assertSafeToReplace(repo, dir);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.dirname(dir), { recursive: true });

  const start = `origin/${from === 'branch' ? branch : baseBranch}`;
  // --no-track: tracking would be written to the clone's shared .git/config, which another
  // worker in the same clone may hold locked; the worker pushes and compares by name anyway
  const addArgs = ['worktree', 'add', '--no-track', '-B', branch, dir, start];
  const add = await retryOnLock(() => git(addArgs, { cwd: repo }), {
    beforeRetry: async () => {
      // a failed add can leave its registration and directory behind; the next add refuses both
      const left = (await listWorktrees(repo)).some((e) => canonical(e.path) === here);
      if (left) await git(['worktree', 'remove', '--force', dir], { cwd: repo });
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    },
  });
  if (add.code !== 0) {
    const used = parseBranchInUse(add.stderr);
    if (used !== null) throw new BranchInUseError(branch, used);
    throw new Error(`git worktree add failed: ${tail(add)}`);
  }
  return { from };
}

export async function removeWorktree(repo: string, dir: string): Promise<void> {
  const r = await retryOnLock(() => git(['worktree', 'remove', '--force', dir], { cwd: repo }));
  if (r.code !== 0) throw new Error(`git worktree remove failed: ${tail(r)}`);
}

// --- commit, push, PR ---

/** `hookTimeoutMs` bounds the commit and its hooks; the ceiling by default. */
export async function commitAll(
  dir: string,
  message: string,
  fallbackIdentity: { name: string; email: string },
  hookTimeoutMs = CEILING_MS,
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
  const commit = await git([...identity, 'commit', '-F', '-'], { cwd: dir, input: message, timeoutMs: hookTimeoutMs });
  // hooks print to either stream
  if (commit.code !== 0) throw new Error(failed('git commit', commit, hookTimeoutMs));
  const head = await git(['rev-parse', 'HEAD'], { cwd: dir });
  if (head.code !== 0) throw new Error(`git rev-parse failed: ${tail(head)}`);
  return head.stdout.trim();
}

/**
 * No `-u`: setting the upstream writes the clone's shared .git/config (see prepareWorktree).
 * `hookTimeoutMs` bounds the push and its pre-push hook; the ceiling by default. `env` reaches
 * the hook.
 */
export async function pushBranch(
  dir: string,
  branch: string,
  hookTimeoutMs = CEILING_MS,
  env?: Record<string, string>,
): Promise<void> {
  const r = await retryOnLock(() =>
    git(['push', 'origin', branch], { cwd: dir, timeoutMs: hookTimeoutMs, ...(env !== undefined ? { env } : {}) }),
  );
  if (r.code !== 0) throw new Error(failed('git push', r, hookTimeoutMs));
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
