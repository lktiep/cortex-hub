import os from 'node:os';
import { resolveCommand } from '../process.js';
import { runCli } from './run.js';
import type { EngineAdapter, ProgressItem, ProgressReader, RunInput, RunOutput } from './types.js';

const VERSION_TIMEOUT_MS = 15_000;
export const SUMMARY_MAX = 4000;
/** The most of one progress item kept, for the transcript; the hub gets a shorter line. */
export const ITEM_MAX = 8000;
/** The lines of a tool's output the transcript keeps. */
const RESULT_LINES = 20;
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

/** `text` trimmed and cut to ITEM_MAX, as a one-item list; none when it is blank. */
export function item(kind: ProgressItem['kind'], text: string): ProgressItem[] {
  const t = text.trim();
  return t === '' ? [] : [{ kind, text: t.length > ITEM_MAX ? `${t.slice(0, ITEM_MAX)}…` : t }];
}

/** The first RESULT_LINES lines of a tool's output, with a count of the rest. */
export function resultHead(text: string): string {
  const lines = text.trim().split('\n');
  if (lines.length <= RESULT_LINES) return lines.join('\n');
  return `${lines.slice(0, RESULT_LINES).join('\n')}\n(${lines.length - RESULT_LINES} more lines)`;
}

/** For an engine that prints plain text: each line, from either stream, is text. */
export function plainReader(): ProgressReader {
  return {
    line: (raw) => item('text', raw),
    errLine: (raw) => item('text', raw),
    end: () => [],
  };
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
