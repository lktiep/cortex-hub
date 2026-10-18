import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildWin32ShellLine, needsShell } from '../process.js';
import type { Problem } from './probe.js';

/** A command that installs a tool, or the python3 commands Windows lacks. */
export type InstallStep = { tool: string; argv: string[] } | { tool: 'python3'; shimDir: string };

const WINGET_IDS: Record<string, string> = {
  git: 'Git.Git',
  node: 'OpenJS.NodeJS.LTS',
  gh: 'GitHub.cli',
  docker: 'Docker.DockerDesktop',
  python3: 'Python.Python.3.12',
};
const BREW: Record<string, string[]> = {
  git: ['git'],
  node: ['node'],
  gh: ['gh'],
  docker: ['--cask', 'docker'],
  python3: ['python'],
};
const LINUX_HINTS: Record<string, string> = {
  git: 'sudo apt install git (or your distribution’s package manager)',
  node: 'install Node 22 LTS: https://nodejs.org/en/download',
  gh: 'https://github.com/cli/cli#installation',
  docker: 'https://docs.docker.com/engine/install/',
  python3: 'sudo apt install python3 (or your distribution’s package manager)',
};
const NPM_TOOLS = new Set(['pnpm', 'yarn', 'bun']);
/** Engine CLIs that npm installs; agy has its own installer. */
const NPM_ENGINES: Record<string, string> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  gemini: '@google/gemini-cli',
};
const MISSING_INSTALLER: Record<string, string> = {
  winget: 'winget is missing: install "App Installer" from the Microsoft Store',
  brew: 'Homebrew is missing: https://brew.sh',
  npm: 'npm is missing: install Node first, then open a new terminal and run cw check',
};
export const SHIM_MARK = 'written by cw check';

/** The command that installs `tool` here, or null when there is none to run for it. */
export function installArgv(tool: string, platform: NodeJS.Platform, version?: string): string[] | null {
  if (NPM_TOOLS.has(tool)) return ['npm', 'install', '-g', version === undefined ? tool : `${tool}@${version}`];
  const pkg = NPM_ENGINES[tool];
  if (pkg !== undefined) return ['npm', 'install', '-g', pkg];
  const id = WINGET_IDS[tool];
  if (platform === 'win32' && id !== undefined) {
    return ['winget', 'install', '-e', '--id', id, '--accept-source-agreements', '--accept-package-agreements'];
  }
  const formula = BREW[tool];
  if (platform === 'darwin' && formula !== undefined) return ['brew', 'install', ...formula];
  return null;
}

/** What to tell the person to do about a missing `tool`. */
export function installHint(tool: string, platform: NodeJS.Platform, version?: string): string {
  const argv = installArgv(tool, platform, version);
  if (argv !== null) return argv.join(' ');
  if (platform === 'linux' && LINUX_HINTS[tool] !== undefined) return LINUX_HINTS[tool];
  return `install ${tool} and put it on PATH`;
}

/**
 * The steps that fix `problems`: missing tools, and package managers on the wrong version.
 * Node on the wrong version, a stopped Docker or a gh without login stay hints. System packages
 * come first, so npm runs with the Node they bring.
 */
export function planInstall(problems: Problem[], platform: NodeJS.Platform, homeDir: string): InstallStep[] {
  const system: InstallStep[] = [];
  const npm: InstallStep[] = [];
  let shim: InstallStep | null = null;
  for (const p of problems) {
    const fixable = p.kind === 'missing' || (p.kind === 'version' && (NPM_TOOLS.has(p.tool) || p.tool in NPM_ENGINES));
    if (!fixable) continue;
    const argv = installArgv(p.tool, platform, p.version);
    if (p.tool === 'python3' && platform === 'win32') {
      // python.org's Python has no python3 command; a shim next to cw gives it one
      shim = { tool: 'python3', shimDir: path.join(homeDir, '.local', 'bin') };
      if (p.realPython !== undefined) continue;
    }
    if (argv === null) continue;
    (argv[0] === 'npm' ? npm : system).push({ tool: p.tool, argv });
  }
  return [...system, ...npm, ...(shim === null ? [] : [shim])];
}

export interface StepResult {
  tool: string;
  what: string;
  ok: boolean;
  detail?: string;
}

export interface InstallDeps {
  resolve: (name: string) => string | null;
  /** Runs with this terminal's stdin, stdout and stderr; resolves the exit code. */
  spawnInherit: (cmd: string, args: string[]) => Promise<number | null>;
  platform: NodeJS.Platform;
  /** The real python.exe on Windows, looked up again after an install. */
  findPython: () => Promise<string | null>;
  /** Picks up what an install added to PATH, so the next step finds it (npm after Node). */
  refreshPath?: () => void;
  /** Stops before the next step. */
  signal?: AbortSignal;
}

function defaultSpawnInherit(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): InstallDeps['spawnInherit'] {
  return (cmd, args) =>
    new Promise((resolve) => {
      // npm is npm.cmd on Windows: one validated line through the shell, as spawnTracked does
      const shell = needsShell(cmd, platform);
      const child = spawn(shell ? buildWin32ShellLine(cmd, args) : cmd, shell ? [] : args, { stdio: 'inherit', shell, env });
      child.on('error', () => resolve(null));
      child.on('close', (code) => resolve(code));
    });
}

/** `env` is read at each spawn, so a PATH refreshed after one install reaches the next. */
export function defaultInstallDeps(
  platform: NodeJS.Platform,
  resolve: (name: string) => string | null,
  findPython: () => Promise<string | null>,
  env: NodeJS.ProcessEnv,
): InstallDeps {
  return { platform, resolve, spawnInherit: defaultSpawnInherit(platform, env), findPython };
}

/** Writes `file` unless something that is not ours is there. */
function writeShim(file: string, body: string): 'written' | 'kept' | 'foreign' {
  if (existsSync(file)) {
    let old = '';
    try {
      old = readFileSync(file, 'utf8');
    } catch {
      return 'foreign';
    }
    if (!old.includes(SHIM_MARK)) return 'foreign';
    if (old === body) return 'kept';
  }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { mode: 0o755 });
  renameSync(tmp, file);
  return 'written';
}

/** python3.cmd for cmd.exe and PowerShell, and python3 for the sh that git hooks run in. */
function writePythonShims(dir: string, python: string): StepResult {
  const what = `python3 commands in ${dir}`;
  try {
    mkdirSync(dir, { recursive: true });
    const cmd = writeShim(path.join(dir, 'python3.cmd'), `@rem ${SHIM_MARK}\r\n@"${python}" %*\r\n`);
    const sh = writeShim(path.join(dir, 'python3'), `#!/bin/sh\n# ${SHIM_MARK}\nexec "${python.replace(/\\/g, '/')}" "$@"\n`);
    if (cmd === 'foreign' || sh === 'foreign') {
      return { tool: 'python3', what, ok: false, detail: `a python3 that cw check did not write is already in ${dir}; left alone` };
    }
    return { tool: 'python3', what, ok: true, detail: `they run ${python}` };
  } catch (err) {
    return { tool: 'python3', what, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Runs the steps in order; one failing does not stop the rest, an abort does. */
export async function runInstall(steps: InstallStep[], deps: InstallDeps, log: (line: string) => void): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (const step of steps) {
    if (deps.signal?.aborted === true) break;
    if ('shimDir' in step) {
      const python = await deps.findPython();
      results.push(
        python === null
          ? { tool: 'python3', what: 'python3 commands', ok: false, detail: 'no Python 3 found to point them at' }
          : writePythonShims(step.shimDir, python),
      );
      continue;
    }
    const [cmd = '', ...args] = step.argv;
    const what = step.argv.join(' ');
    const bin = deps.resolve(cmd);
    if (bin === null) {
      results.push({ tool: step.tool, what, ok: false, detail: MISSING_INSTALLER[cmd] ?? `${cmd} is not on PATH` });
      continue;
    }
    log(`→ ${what}`);
    let code: number | null;
    try {
      code = await deps.spawnInherit(bin, args);
    } catch (err) {
      results.push({ tool: step.tool, what, ok: false, detail: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (code !== 0) {
      results.push({ tool: step.tool, what, ok: false, detail: `exit code ${String(code)}` });
      continue;
    }
    deps.refreshPath?.();
    results.push({ tool: step.tool, what, ok: true });
  }
  return results;
}
