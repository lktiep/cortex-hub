import { readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Executor } from '@cortex/shared-types';
import { runCli } from '../engines/run.js';
import { installHint as engineInstallHint } from '../engines/install.js';
import { resolveCommand } from '../process.js';
import { installHint } from './install.js';
import { parseVersion, satisfies } from './requirements.js';
import type { Needs, Requirement } from './requirements.js';

export type ProblemKind = 'missing' | 'version' | 'not-running' | 'not-logged-in';

/** One thing this machine lacks for the project. */
export interface Problem {
  tool: string;
  kind: ProblemKind;
  /** false: a warning; tasks can still run. */
  required: boolean;
  /** What is wrong and why the project needs it. */
  detail: string;
  /** What to run or do about it; may span lines. */
  fix: string;
  /** The version to install, when the project pins one (pnpm@9.12.0). */
  version?: string;
  /** Windows: a real python.exe that only lacks a python3 command. */
  realPython?: string;
}

export interface Found {
  tool: string;
  path: string;
  version: string | null;
}

export interface Probe {
  found: Found[];
  problems: Problem[];
  notes: string[];
}

export interface RunOut {
  code: number | null;
  output: string;
}

export interface ProbeDeps {
  platform: NodeJS.Platform;
  resolve: (name: string) => string | null;
  /** Runs `cmd` without a shell; never rejects. */
  run: (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<RunOut>;
  /** Windows: a python.exe that is Python 3 and not the Store alias. */
  findPython: () => Promise<string | null>;
}

const VERSION_TIMEOUT_MS = 15_000;
const DOCKER_TIMEOUT_MS = 20_000;
/** Tools known to answer `--version`; anything else from worker.requires is only looked up. */
const VERSIONED = new Set(['git', 'gh', 'node', 'npm', 'pnpm', 'yarn', 'bun', 'docker']);
const PM_TOOLS = new Set(['pnpm', 'yarn', 'bun']);
const ALIASES_HINT =
  'turn off the python.exe and python3.exe App execution aliases (Settings → Apps → Advanced app settings → App execution aliases)';

const isStoreAlias = (p: string): boolean => /[\\/]WindowsApps[\\/]/i.test(p);
const firstLine = (s: string): string =>
  (s.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '').slice(0, 200);
const isPython3 = (r: RunOut): boolean => r.code === 0 && /\bPython 3\./.test(r.output);

export function defaultProbeDeps(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): ProbeDeps {
  const resolve = (name: string): string | null =>
    (name === 'gh' && env['CORTEX_GH_BIN']) || resolveCommand(name, platform, env);
  const run: ProbeDeps['run'] = async (cmd, args, opts) => {
    const r = await runCli(
      cmd,
      { args },
      {
        prompt: '',
        cwd: opts.cwd,
        model: null,
        effort: null,
        signal: new AbortController().signal,
        timeoutMs: opts.timeoutMs,
        onLine: () => undefined,
      },
      { platform, env },
    );
    return { code: r.timedOut ? null : r.exitCode, output: `${r.stdout}\n${r.stderr}`.trim() };
  };
  return { platform, resolve, run, findPython: () => findWindowsPython({ resolve, run, env }) };
}

function subdirs(dir: string | undefined): string[] {
  if (dir === undefined || dir === '') return [];
  try {
    return readdirSync(dir).filter((n) => statSync(path.join(dir, n)).isDirectory());
  } catch {
    return [];
  }
}

/**
 * A Python 3 on Windows that is not the Store alias: `python` on PATH, the `py` launcher's, or
 * the newest under %LOCALAPPDATA%\Programs\Python and %ProgramFiles%, where winget puts it.
 */
export async function findWindowsPython(deps: Pick<ProbeDeps, 'resolve' | 'run'> & { env: NodeJS.ProcessEnv }): Promise<string | null> {
  const opts = { cwd: os.tmpdir(), timeoutMs: VERSION_TIMEOUT_MS };
  const candidates: string[] = [];
  const python = deps.resolve('python');
  if (python !== null && !isStoreAlias(python)) candidates.push(python);
  const py = deps.resolve('py');
  if (py !== null) {
    const r = await deps.run(py, ['-3', '-c', 'import sys; print(sys.executable)'], opts);
    if (r.code === 0 && firstLine(r.output) !== '') candidates.push(firstLine(r.output));
  }
  const local = deps.env['LOCALAPPDATA'];
  for (const base of [local === undefined ? undefined : path.join(local, 'Programs', 'Python'), deps.env['ProgramFiles']]) {
    const dirs = subdirs(base)
      .filter((n) => /^Python3\d+$/i.test(n))
      .sort((a, b) => Number(b.slice(7)) - Number(a.slice(7)));
    for (const d of dirs) candidates.push(path.join(base ?? '', d, 'python.exe'));
  }
  for (const c of [...new Set(candidates)]) {
    if (isStoreAlias(c)) continue;
    if (isPython3(await deps.run(c, ['--version'], opts))) return c;
  }
  return null;
}

function versionFix(tool: string, range: string, installVersion: string | undefined, platform: NodeJS.Platform): string {
  if (PM_TOOLS.has(tool) && installVersion !== undefined) return installHint(tool, platform, installVersion);
  if (tool === 'node') return `install Node ${range}: https://nodejs.org/en/download (or with nvm)`;
  return `install ${tool} ${range}`;
}

/** What this machine lacks for `needs`: tools, versions, a stopped Docker, a gh without login. */
export async function probeNeeds(repo: string, needs: Needs, deps: ProbeDeps): Promise<Probe> {
  const found: Found[] = [];
  const problems: Problem[] = [];
  const notes: string[] = [];
  const byTool = new Map<string, Requirement[]>();
  for (const r of needs.requirements) byTool.set(r.tool, [...(byTool.get(r.tool) ?? []), r]);
  const opts = { cwd: repo, timeoutMs: VERSION_TIMEOUT_MS };

  for (const [tool, reqs] of byTool) {
    const main = reqs.find((r) => r.required) ?? reqs[0];
    if (main === undefined) continue;
    const required = main.required;
    const pinned = reqs.find((r) => r.installVersion !== undefined)?.installVersion;
    const missing = (detail: string, extra: Partial<Problem> = {}): void => {
      problems.push({
        tool,
        kind: 'missing',
        required,
        detail: `${detail}; ${main.why}`,
        fix: installHint(tool, deps.platform, pinned),
        ...(pinned === undefined ? {} : { version: pinned }),
        ...extra,
      });
    };

    if (tool === 'python3') {
      const bin = deps.resolve('python3');
      if (bin !== null) {
        const r = await deps.run(bin, ['--version'], opts);
        if (isPython3(r)) {
          found.push({ tool, path: bin, version: parseVersion(r.output) });
          continue;
        }
      }
      const alias = bin !== null && deps.platform === 'win32' && isStoreAlias(bin);
      const detail = bin === null ? 'not found' : alias ? 'only the Microsoft Store alias is here, not Python' : `${bin} is not Python 3`;
      if (deps.platform !== 'win32') {
        missing(detail);
        continue;
      }
      const real = await deps.findPython();
      const steps = [
        real === null ? `${installHint('python3', 'win32')}, then cw check --yes` : `cw check --yes adds a python3 command that runs ${real}`,
        ...(alias ? [ALIASES_HINT] : []),
      ];
      missing(detail, { fix: steps.join('\n'), ...(real === null ? {} : { realPython: real }) });
      continue;
    }

    const bin = deps.resolve(tool);
    if (bin === null) {
      missing('not found');
      continue;
    }
    let version: string | null = null;
    if (VERSIONED.has(tool)) {
      const r = await deps.run(bin, ['--version'], opts);
      if (r.code !== 0) {
        missing(`${bin} --version failed: ${firstLine(r.output) || `exit code ${String(r.code)}`}`);
        continue;
      }
      version = parseVersion(r.output);
    }
    found.push({ tool, path: bin, version });

    for (const r of reqs) {
      if (r.range === undefined) continue;
      const ok = version === null ? null : satisfies(version, r.range);
      if (ok === null) {
        notes.push(`could not check ${tool} ${version ?? '(version unknown)'} against "${r.range}" (${r.why})`);
      } else if (!ok) {
        problems.push({
          tool,
          kind: 'version',
          required: r.required,
          detail: `${version ?? ''} is here, ${r.range} is needed; ${r.why}`,
          fix: versionFix(tool, r.range, r.installVersion, deps.platform),
          ...(r.installVersion === undefined ? {} : { version: r.installVersion }),
        });
      }
    }

    if (tool === 'docker') {
      const r = await deps.run(bin, ['info', '--format', '{{.ServerVersion}}'], { cwd: repo, timeoutMs: DOCKER_TIMEOUT_MS });
      if (r.code !== 0 || parseVersion(r.output) === null) {
        const denied = /permission denied/i.test(r.output);
        const said = r.code === null ? 'docker info timed out' : firstLine(r.output);
        problems.push({
          tool,
          kind: 'not-running',
          required,
          detail: `${denied ? 'installed, but this user may not use it' : 'installed, but the Docker engine is not running'}${said === '' ? '' : ` (${said})`}`,
          fix: denied
            ? 'sudo usermod -aG docker $USER, then log out and back in'
            : deps.platform === 'linux'
              ? 'sudo systemctl start docker'
              : 'open Docker Desktop and wait until it says the engine is running',
        });
      }
    }
    if (tool === 'gh') {
      // only the exit code: the output names the account
      const r = await deps.run(bin, ['auth', 'status'], opts);
      if (r.code !== 0) {
        problems.push({ tool, kind: 'not-logged-in', required, detail: `not logged in; ${main.why}`, fix: 'gh auth login' });
      }
    }
  }
  return { found, problems, notes };
}

/** A problem when none of the engines the worker may use is installed. */
export function engineProblems(wanted: Executor[], available: Executor[], platform: NodeJS.Platform): Problem[] {
  if (available.length > 0 || wanted.length === 0) return [];
  if (wanted.length === 1) {
    const e = wanted[0] as Executor;
    return [{ tool: e, kind: 'missing', required: true, detail: `not found; it does the tasks`, fix: engineInstallHint(e, platform) }];
  }
  return [
    {
      tool: 'engine',
      kind: 'missing',
      required: true,
      detail: `none of ${wanted.join(', ')} is installed; one of them does the tasks`,
      fix: wanted.map((e) => `${e}: ${engineInstallHint(e, platform)}`).join('\n'),
    },
  ];
}
