import os from 'node:os';
import { resolveCommand } from '../process.js';
import { runCli } from './run.js';
import type { EngineAdapter, RunInput, RunOutput } from './types.js';

const VERSION_TIMEOUT_MS = 15_000;
export const SUMMARY_MAX = 4000;
export const PROGRESS_MAX = 500;
export const RAW_MAX = 2000;
const ERROR_MAX = 300;
const STDERR_TAIL_LINES = 40;

export interface CliAdapterOpts {
  bin?: string;
  models?: string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
}

export function tail(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? t.slice(t.length - max) : t;
}

/** The last `STDERR_TAIL_LINES` lines of stderr: the only place a quota notice is looked for. */
export function stderrTail(stderr: string): string {
  return stderr.trimEnd().split('\n').slice(-STDERR_TAIL_LINES).join('\n');
}

export function tailSummary(stdout: string): string {
  return tail(stdout, SUMMARY_MAX);
}

export function plainProgress(line: string): string | null {
  const t = line.trim();
  return t === '' ? null : t.slice(0, PROGRESS_MAX);
}

export function errorMessage(exitCode: number | null, stderr: string, stdout: string, name: string): string {
  const text = tail(stderr, ERROR_MAX) || tail(stdout, ERROR_MAX);
  return text !== '' ? text : `${name} exited with code ${String(exitCode)}`;
}

/** The shared plumbing of a stdin-prompt CLI adapter: binary lookup, detect, models, run. */
export function cliPlumbing(
  executor: 'claude' | 'codex' | 'gemini',
  opts: CliAdapterOpts,
  buildArgs: EngineAdapter['buildArgs'],
): Pick<EngineAdapter, 'executor' | 'detect' | 'models' | 'defaultModel' | 'buildArgs' | 'run'> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const upper = executor.toUpperCase();
  const resolveBin = (): string | null =>
    opts.bin ?? (env[`CORTEX_${upper}_BIN`] || null) ?? resolveCommand(executor, platform, env);

  const quiet = (): RunInput => ({
    prompt: '',
    cwd: os.tmpdir(),
    model: null,
    effort: null,
    signal: new AbortController().signal,
    timeoutMs: VERSION_TIMEOUT_MS,
    onLine: () => undefined,
  });

  return {
    executor,

    async detect() {
      const bin = resolveBin();
      if (bin === null) return { found: false };
      const r = await runCli(bin, { args: ['--version'] }, quiet(), { platform, env });
      if (r.exitCode !== 0) return { found: false, path: bin };
      const version = firstLine(r.stdout);
      return version === '' ? { found: true, path: bin } : { found: true, path: bin, version };
    },

    models() {
      if (opts.models) return Promise.resolve(opts.models);
      const ids = (env[`CORTEX_${upper}_MODELS`] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');
      return Promise.resolve(ids.length > 0 ? ids : ['*']);
    },

    defaultModel() {
      return null;
    },

    buildArgs,

    run(input: RunInput): Promise<RunOutput> {
      const built = buildArgs({ prompt: input.prompt, model: input.model, effort: input.effort }, platform);
      return runCli(resolveBin() ?? executor, built, input, { platform, env });
    },
  };
}
