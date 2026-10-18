import type { Executor } from '@cortex/shared-types';

export type Classification =
  | { kind: 'ok' }
  | { kind: 'quota'; resetAt?: string; modelScope?: string; raw: string }
  | { kind: 'error'; message: string };

export interface RunInput {
  prompt: string;
  cwd: string;
  model: string | null;
  effort: string | null;
  signal: AbortSignal;
  timeoutMs: number;
  onLine: (line: string) => void;
  /** Each stderr line as it comes, when given. */
  onErrLine?: (line: string) => void;
  /**
   * Called once the engine has started, with the process group it leads. POSIX only: on
   * Windows the engine leads no group, and a failed spawn has none.
   */
  onGroup?: (pgid: number) => void;
}

export interface RunOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

/**
 * One readable piece of an engine's output. `result` (a tool's output) and `log` (a stderr
 * line) only go to the transcript on the worker's machine; the rest also goes to the hub.
 */
export interface ProgressItem {
  kind: 'text' | 'thinking' | 'tool' | 'error' | 'info' | 'result' | 'log';
  text: string;
}

/** Reads one run's output into progress items. One per run: it may hold a partial line. */
export interface ProgressReader {
  line(raw: string): ProgressItem[];
  errLine(raw: string): ProgressItem[];
  /** What it still holds once the engine has exited. */
  end(): ProgressItem[];
}

export interface EngineAdapter {
  readonly executor: Executor;
  detect(): Promise<{ found: boolean; path?: string; version?: string }>;
  /** Model ids this engine accepts; may contain '*'. */
  models(): Promise<string[]>;
  defaultModel(): string | null;
  buildArgs(
    i: { prompt: string; model: string | null; effort: string | null },
    platform: NodeJS.Platform,
  ): { args: string[]; stdin?: string };
  run(input: RunInput): Promise<RunOutput>;
  classify(
    exitCode: number | null,
    stdout: string,
    stderr: string,
    ctx?: { model: string | null; now?: Date },
  ): Classification;
  /** A reader for one run's output. */
  progress(): ProgressReader;
  /** Final answer, at most 4 000 chars. */
  summary(stdout: string): string;
  /**
   * How a prompt counts against PROMPT_LIMIT when it is not just its length: agy takes the
   * prompt in argv, which Windows quotes and escapes on the command line.
   */
  promptLength?(prompt: string): number;
  /**
   * True when a shell command would be refused and would end the run (headless agy outside
   * auto mode), so the prompt tells the engine to use its file tools only.
   */
  refusesCommands?(): boolean;
  /** Why a run that exited cleanly was cut short (agy: a permission it could not ask for), else null. */
  stoppedEarly?(stdout: string, stderr: string): string | null;
}
