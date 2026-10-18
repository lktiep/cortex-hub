import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Executor } from '@cortex/shared-types';
import { createAdapters } from '../engines/index.js';
import { defaultInstallDeps, planInstall, runInstall } from '../env/install.js';
import type { InstallDeps, InstallStep } from '../env/install.js';
import { defaultProbeDeps, engineProblems, probeNeeds } from '../env/probe.js';
import type { Found, ProbeDeps, Problem } from '../env/probe.js';
import { defaultRehearseDeps, rehearse, trialFingerprint } from '../env/rehearse.js';
import type { Rehearsal, TrialStep } from '../env/rehearse.js';
import { git } from '../git.js';
import { inferNeeds } from '../env/requirements.js';
import type { Needs } from '../env/requirements.js';

export interface CheckOptions {
  repo: string;
  /** The engines the worker may use. */
  engines: Executor[];
  homeDir: string;
  /** Install what is missing without asking. */
  yes: boolean;
  /** Skip the trial run when it passed before and nothing it rests on has changed. */
  ifChanged: boolean;
}

export interface CheckDeps {
  platform: NodeJS.Platform;
  probe: ProbeDeps;
  install: InstallDeps;
  /** Which of `wanted` are installed here, looked up afresh on each call. */
  availableEngines: (wanted: Executor[]) => Promise<Executor[]>;
  rehearse: (repo: string, onStep: (name: TrialStep['name'], command: string) => void) => Promise<Rehearsal>;
  /** What a trial's result rests on; null when it cannot tell. */
  fingerprint: (repo: string) => Promise<string | null>;
  /** A yes or no; null when nobody can answer (no terminal). */
  ask: (question: string) => Promise<boolean | null>;
  out: (line: string) => void;
  signal?: AbortSignal;
}

interface Survey {
  found: Found[];
  engines: Executor[];
  problems: Problem[];
  notes: string[];
}

/** Ctrl+C. */
const INTERRUPTED = 130;

async function survey(opts: CheckOptions, needs: Needs, deps: CheckDeps): Promise<Survey> {
  const probe = await probeNeeds(opts.repo, needs, deps.probe);
  const engines = await deps.availableEngines(opts.engines);
  const problems = [...probe.problems, ...engineProblems(opts.engines, engines, deps.platform)];
  // what blocks tasks first, then the warnings
  problems.sort((a, b) => Number(b.required) - Number(a.required));
  return { found: probe.found, engines, problems, notes: [...needs.notes, ...probe.notes] };
}

function surveyLines(s: Survey): string[] {
  const lines: string[] = [];
  const have = s.found.map((f) => (f.version === null ? f.tool : `${f.tool} ${f.version}`));
  if (s.engines.length > 0) have.push(`engines: ${s.engines.join(', ')}`);
  if (have.length > 0) lines.push(`✓ ${have.join(', ')}`);
  for (const p of s.problems) {
    lines.push(`${p.required ? '✗' : '!'} ${p.tool} — ${p.detail}`);
    const [first = '', ...rest] = p.fix.split('\n');
    lines.push(`    fix: ${first}`);
    for (const l of rest) lines.push(`         ${l}`);
  }
  for (const n of s.notes) lines.push(`note: ${n}`);
  return lines;
}

const stepText = (s: InstallStep): string => ('argv' in s ? s.argv.join(' ') : `add python3 commands in ${s.shimDir}`);

function trialLines(r: Rehearsal): string[] {
  const lines: string[] = [];
  if (r.error !== undefined) lines.push(`✗ ${r.error}`);
  for (const s of r.steps) {
    const why = s.timedOut ? ' (timed out)' : s.exitCode === 0 ? '' : ` (exit code ${s.exitCode})`;
    lines.push(`${s.exitCode === 0 ? '✓' : '✗'} ${s.name}: ${s.command}${why}`);
    if (s.exitCode !== 0 && s.tail !== '') for (const l of s.tail.split('\n')) lines.push(`      ${l}`);
  }
  for (const n of r.notes) lines.push(`note: ${n}`);
  return lines;
}

/** Where the fingerprint of `repo`'s last passing trial is kept. */
export function stampFile(homeDir: string, repo: string): string {
  let real = repo;
  try {
    real = realpathSync(repo);
  } catch {
    // a repo that is gone gets its own name
  }
  const id = createHash('sha256').update(real).digest('hex').slice(0, 16);
  return path.join(homeDir, '.cortex', 'check', `${id}.json`);
}

function readStamp(file: string): string | null {
  try {
    const v: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const fp = typeof v === 'object' && v !== null ? (v as Record<string, unknown>)['fingerprint'] : undefined;
    return typeof fp === 'string' ? fp : null;
  } catch {
    return null;
  }
}

/** Only a cache: failing to keep it costs a trial run next time. */
function writeStamp(file: string, fingerprint: string | null): void {
  try {
    if (fingerprint === null) {
      rmSync(file, { force: true });
      return;
    }
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ fingerprint, at: new Date().toISOString() })}\n`);
    renameSync(tmp, file);
  } catch {
    // see above
  }
}

/**
 * Says what this machine lacks for the worker to do `repo`'s tasks, offers once to install what
 * it can, then runs the project's setup and test commands in a throwaway worktree. 0 = ready.
 */
export async function runCheck(opts: CheckOptions, deps: CheckDeps): Promise<number> {
  const { out } = deps;
  const aborted = (): boolean => deps.signal?.aborted === true;
  const needs = inferNeeds(opts.repo);
  out(`cw check: ${opts.repo}`);
  out('');
  let s = await survey(opts, needs, deps);
  for (const l of surveyLines(s)) out(l);

  const steps = planInstall(s.problems, deps.platform, opts.homeDir);
  if (steps.length > 0) {
    out('');
    out(`cw check can do ${steps.length === 1 ? 'this' : 'these'} for you:`);
    for (const step of steps) out(`  ${stepText(step)}`);
    const go = opts.yes ? true : await deps.ask(`Go ahead? [Y/n] `);
    if (aborted()) return INTERRUPTED;
    if (go === null) {
      out('no terminal to ask in; to have them done: cw check --yes');
    } else if (!go) {
      out('nothing installed');
    } else {
      const results = await runInstall(steps, deps.install, out);
      if (aborted()) return INTERRUPTED;
      out('');
      for (const r of results) {
        out(r.ok ? `✓ ${r.what}${r.detail === undefined ? '' : `: ${r.detail}`}` : `✗ ${r.what}: ${r.detail ?? 'failed'}`);
      }
      s = await survey(opts, needs, deps);
      out('');
      out('now:');
      for (const l of surveyLines(s)) out(l);
      const done = new Set(results.filter((r) => r.ok).map((r) => r.tool));
      const unseen = s.problems.filter((p) => p.kind === 'missing' && done.has(p.tool)).map((p) => p.tool);
      if (unseen.length > 0) {
        out(`${unseen.join(', ')} installed, but this terminal does not see ${unseen.length === 1 ? 'it' : 'them'} yet: open a new terminal and run cw check again`);
      }
    }
  }
  if (s.problems.length === 0) out('nothing is missing');

  const blocking = s.problems.filter((p) => p.required).length;
  if (blocking > 0) {
    out('');
    out('the trial run waits until the ✗ items are fixed');
    out(`not ready: ${blocking === 1 ? '1 thing' : `${blocking} things`} to fix, then run cw check again`);
    return 1;
  }

  const stamp = stampFile(opts.homeDir, opts.repo);
  const fingerprint = await deps.fingerprint(opts.repo);
  out('');
  if (opts.ifChanged && fingerprint !== null && readStamp(stamp) === fingerprint) {
    out('trial run: skipped, it passed before and nothing it rests on has changed (cw check runs it again)');
    out(`ready: this machine can take tasks for ${opts.repo}`);
    return 0;
  }
  out('trial run: the setup and test commands, as a task runs them, in a temporary worktree');
  const trial = await deps.rehearse(opts.repo, (name, command) => out(`  … ${name}: ${command}`));
  if (aborted()) {
    out('interrupted; the temporary worktree is removed');
    return INTERRUPTED;
  }
  for (const l of trialLines(trial)) out(l);
  writeStamp(stamp, trial.ok ? fingerprint : null);
  if (!trial.ok) {
    out(`not ready: the trial run${trial.ref === null ? '' : ` on ${trial.ref}`} failed, and tasks would fail the same way`);
    return 1;
  }
  out(`ready: this machine can take tasks for ${opts.repo}`);
  return 0;
}

/**
 * Asks on this terminal; an empty answer is a yes. null when there is no terminal to ask in.
 * Ctrl+C at the prompt aborts `ac`, as it would anywhere else in cw check.
 */
export function terminalAsk(
  ac: AbortController,
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): CheckDeps['ask'] {
  return (question) => {
    if (input.isTTY !== true) return Promise.resolve(null);
    return new Promise((resolve) => {
      const rl = createInterface({ input, output });
      let answered = false;
      const answer = (yes: boolean): void => {
        if (answered) return;
        answered = true;
        rl.close();
        resolve(yes);
      };
      rl.on('SIGINT', () => {
        output.write('\n');
        ac.abort();
        answer(false);
      });
      // Ctrl+D
      rl.on('close', () => answer(false));
      rl.question(question, (a) => answer(/^(y|yes)?$/i.test(a.trim())));
    });
  };
}

/**
 * The real thing: probes, installs and the trial all run with `env`, the hub key already out of
 * it. On Windows an install's PATH change is read back from the registry into `env`.
 */
export function defaultCheckDeps(o: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  ask: CheckDeps['ask'];
  out: CheckDeps['out'];
}): CheckDeps {
  const probe = defaultProbeDeps(o.platform, o.env);
  const install: InstallDeps = {
    ...defaultInstallDeps(o.platform, probe.resolve, probe.findPython, o.env),
    signal: o.signal,
  };
  if (o.platform === 'win32') install.refreshPath = () => refreshWindowsPath(o.env, (scope) => readRegistryPath(scope, o.env));
  return {
    platform: o.platform,
    probe,
    install,
    availableEngines: async (wanted) => {
      const found = await Promise.all(
        createAdapters(wanted, o.env).map(async (a) => {
          try {
            return (await a.detect()).found ? a.executor : null;
          } catch {
            return null;
          }
        }),
      );
      return found.filter((e): e is Executor => e !== null);
    },
    rehearse: (repo, onStep) => rehearse(repo, defaultRehearseDeps(o.env, { signal: o.signal, onStep })),
    fingerprint: (repo) => trialFingerprint(repo, git, o.env),
    ask: o.ask,
    out: o.out,
    signal: o.signal,
  };
}

/** HKLM and HKCU hold the PATH a new terminal starts with. */
const REG_KEYS = {
  machine: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  user: 'HKCU\\Environment',
} as const;

const envKey = (env: NodeJS.ProcessEnv, name: string): string | undefined =>
  Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());

/** The Path value in what `reg query <key> /v Path` prints. */
export function parseRegPath(output: string): string | null {
  return /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/im.exec(output)?.[1] ?? null;
}

/** Reads the machine or user Path from the registry; null when it cannot. */
export function readRegistryPath(scope: keyof typeof REG_KEYS, env: NodeJS.ProcessEnv): string | null {
  const root = env[envKey(env, 'SystemRoot') ?? 'SystemRoot'] ?? 'C:\\Windows';
  try {
    const output = execFileSync(path.win32.join(root, 'System32', 'reg.exe'), ['query', REG_KEYS[scope], '/v', 'Path'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseRegPath(output);
  } catch {
    return null;
  }
}

/**
 * Adds to `env`'s PATH, in place, the folders an installer put in the registry since this
 * terminal started, as a new terminal would see them. What is already on PATH stays first.
 */
export function refreshWindowsPath(env: NodeJS.ProcessEnv, read: (scope: keyof typeof REG_KEYS) => string | null): void {
  const key = envKey(env, 'Path') ?? 'Path';
  const expand = (s: string): string =>
    s.replace(/%([^%]+)%/g, (whole, name: string) => {
      const k = envKey(env, name);
      return k === undefined ? whole : (env[k] ?? whole);
    });
  const norm = (dir: string): string => dir.toLowerCase().replace(/[\\/]+$/, '');
  const current = (env[key] ?? '').split(';').filter((d) => d.trim() !== '');
  const seen = new Set(current.map(norm));
  const added: string[] = [];
  for (const raw of [read('machine'), read('user')]) {
    for (const part of (raw ?? '').split(';')) {
      const dir = expand(part.trim());
      if (dir === '' || seen.has(norm(dir))) continue;
      seen.add(norm(dir));
      added.push(dir);
    }
  }
  if (added.length > 0) env[key] = [...current, ...added].join(';');
}
