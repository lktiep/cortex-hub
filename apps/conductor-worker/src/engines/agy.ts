import os from 'node:os';
import { resolveCommand } from '../process.js';
import { win32QuotedLength } from '../prompt.js';
import { agyModelScope, parseResetsIn } from './quota.js';
import { ITEM_MAX, item } from './common.js';
import { runCli } from './run.js';
import type { Classification, EngineAdapter, ProgressItem, ProgressReader, RunInput, RunOutput } from './types.js';

const MODEL_ID = /^[a-z0-9][a-z0-9.-]*-(low|medium|high)$|^[a-z0-9][a-z0-9.-]*$/;
const MODELS_TIMEOUT_MS = 60_000;
const VERSION_TIMEOUT_MS = 15_000;
const SUMMARY_MAX = 4000;
const RAW_MAX = 2000;
const QUOTA_EXIT_CODE = 3;

interface AgyResult {
  status?: unknown;
  response?: unknown;
  error?: unknown;
  /** Permissions headless agy refused, `{ action, display_name }`; a refusal ends the run. */
  denied_actions?: unknown;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The final result of a run: the last `result` event of a stream-json transcript, or the
 * single object printed by `--output-format json`. Unparseable lines are skipped.
 */
function findResult(stdout: string): AgyResult | undefined {
  let found: AgyResult | undefined;
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    const obj = parseJson(line);
    if (!isRecord(obj)) continue;
    if (obj.event === 'result' && isRecord(obj.result)) found = obj.result;
    else if (obj.event === undefined && typeof obj.status === 'string') found = obj;
  }
  if (found) return found;
  const whole = parseJson(stdout.trim());
  return isRecord(whole) && typeof whole.status === 'string' ? whole : undefined;
}

/** A tool step's name and what it works on: the command line, the file, or its first string. */
function toolLabel(step: Record<string, unknown>): string {
  const name = typeof step.tool_name === 'string' ? step.tool_name : 'tool';
  const params = isRecord(step.tool_info) && isRecord(step.tool_info.parameters) ? step.tool_info.parameters : {};
  const pick = [params.CommandLine, params.AbsolutePath, ...Object.values(params)].find(
    (v): v is string => typeof v === 'string' && v.trim() !== '',
  );
  return pick === undefined ? name : `${name}: ${pick}`;
}

/**
 * A reader for one run. agy streams a response as fragments (`text_delta`) of numbered steps,
 * so it joins each step's fragments and hands on whole lines, the rest when the step is done.
 * A tool step is named once, when it starts, and again if it fails.
 */
function agyReader(): ProgressReader {
  const pending = new Map<number, string>();
  const named = new Set<number>();
  const flush = (index: number): ProgressItem[] => {
    const rest = pending.get(index) ?? '';
    pending.delete(index);
    return item('text', rest);
  };
  return {
    line(raw) {
      const obj = parseJson(raw.trim());
      if (!isRecord(obj)) return [];
      if (obj.event === 'init') {
        const model = isRecord(obj.init) ? obj.init.model : undefined;
        return item('info', typeof model === 'string' ? `agy started (${model})` : 'agy started');
      }
      if (obj.event === 'result') {
        const result = isRecord(obj.result) ? obj.result : {};
        return result.status === 'ERROR' && typeof result.error === 'string' ? item('error', result.error) : [];
      }
      if (obj.event !== 'step_update' || !isRecord(obj.step_update)) return [];
      const step = obj.step_update;
      const index = typeof step.step_index === 'number' ? step.step_index : -1;
      if (step.step_type === 'tool') {
        const label = toolLabel(step);
        if (step.state === 'ERROR') {
          named.add(index);
          const error = isRecord(step.tool_info) && isRecord(step.tool_info.error) ? step.tool_info.error : {};
          return item('error', typeof error.message === 'string' ? `${label} failed: ${error.message}` : `${label} failed`);
        }
        if (named.has(index)) return [];
        named.add(index);
        return item('tool', label);
      }
      const out: ProgressItem[] = [];
      if (typeof step.text_delta === 'string') {
        const lines = ((pending.get(index) ?? '') + step.text_delta).split('\n');
        const rest = lines.pop() ?? '';
        for (const line of lines) out.push(...item('text', line));
        pending.set(index, rest);
        if (rest.length >= ITEM_MAX) out.push(...flush(index));
      }
      if (step.state === 'DONE' || step.state === 'ERROR') out.push(...flush(index));
      return out;
    },
    errLine: (raw) => item('log', raw),
    end() {
      return [...pending.keys()].flatMap(flush);
    },
  };
}

function findAgyError(stderr: string): Record<string, unknown> | undefined {
  for (const raw of stderr.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('AGY_ERROR:')) continue;
    const obj = parseJson(line.slice('AGY_ERROR:'.length).trim());
    if (isRecord(obj)) return obj;
  }
  return undefined;
}

/** The refused permissions, by display name, without repeats. */
function deniedActions(result: AgyResult | undefined): string[] {
  if (!Array.isArray(result?.denied_actions)) return [];
  const names: string[] = [];
  for (const d of result.denied_actions) {
    if (!isRecord(d)) continue;
    const name = typeof d.display_name === 'string' && d.display_name !== '' ? d.display_name : d.action;
    if (typeof name === 'string' && name !== '' && !names.includes(name)) names.push(name);
  }
  return names;
}

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
}

function parseModels(stdout: string): string[] {
  const ids: string[] = [];
  for (const raw of stdout.split('\n')) {
    const token = raw.replace(/^\s*[-*•]?\s*/, '').split(/\s+/)[0] ?? '';
    if (token !== '' && MODEL_ID.test(token) && !ids.includes(token)) ids.push(token);
  }
  return ids;
}

export function createAgyAdapter(
  opts: {
    bin?: string;
    mode?: string;
    printTimeout?: string;
    /** `--dangerously-skip-permissions`; CORTEX_AGY_SKIP_PERMISSIONS=1 when unset. Opt-in only. */
    skipPermissions?: boolean;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
  } = {},
): EngineAdapter {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const resolveBin = (): string | null =>
    opts.bin ?? (env.CORTEX_AGY_BIN || null) ?? resolveCommand('agy', platform, env);
  // accept-edits on every platform: Windows has no auto mode, and an account without it falls
  // back to the default mode, where headless agy is refused even its file edits
  const mode = (): string => opts.mode ?? (env.CORTEX_AGY_MODE || undefined) ?? 'accept-edits';
  const skipPermissions = (): boolean => opts.skipPermissions ?? env.CORTEX_AGY_SKIP_PERMISSIONS === '1';

  const buildArgs: EngineAdapter['buildArgs'] = (i) => {
    const args = ['-p', i.prompt, '--output-format', 'stream-json', '--mode', mode()];
    if (skipPermissions()) args.push('--dangerously-skip-permissions');
    if (i.model !== null) args.push('--model', i.model);
    if (i.effort !== null) args.push('--effort', i.effort);
    if (opts.printTimeout) args.push('--print-timeout', opts.printTimeout);
    return { args };
  };

  const quiet = (over: Partial<RunInput> = {}): RunInput => ({
    prompt: '',
    cwd: os.tmpdir(),
    model: null,
    effort: null,
    signal: new AbortController().signal,
    timeoutMs: VERSION_TIMEOUT_MS,
    onLine: () => undefined,
    ...over,
  });

  return {
    executor: 'agy',

    promptLength: (prompt) => (platform === 'win32' ? win32QuotedLength(prompt) : prompt.length),

    async detect() {
      const bin = resolveBin();
      if (bin === null) return { found: false };
      const r = await runCli(bin, { args: ['--version'] }, quiet(), { platform, env });
      if (r.exitCode !== 0) return { found: false, path: bin };
      const version = firstLine(r.stdout);
      return version === '' ? { found: true, path: bin } : { found: true, path: bin, version };
    },

    async models() {
      const bin = resolveBin() ?? 'agy';
      const r = await runCli(bin, { args: ['models'] }, quiet({ timeoutMs: MODELS_TIMEOUT_MS }), {
        platform,
        env,
      });
      if (r.exitCode !== 0) {
        const why = r.timedOut ? 'timed out' : firstLine(r.stderr);
        throw new Error(`agy models failed (exit ${String(r.exitCode)})${why === '' ? '' : `: ${why}`}`);
      }
      const ids = parseModels(r.stdout);
      return ids.length > 0 ? ids : ['*'];
    },

    defaultModel() {
      return null;
    },

    buildArgs,

    run(input: RunInput): Promise<RunOutput> {
      const built = buildArgs(
        { prompt: input.prompt, model: input.model, effort: input.effort },
        platform,
      );
      return runCli(resolveBin() ?? 'agy', built, input, { platform, env });
    },

    classify(exitCode, stdout, stderr, ctx): Classification {
      const result = findResult(stdout);
      if (exitCode === 0 && result?.status === 'SUCCESS') return { kind: 'ok' };

      const resultError = typeof result?.error === 'string' ? result.error : '';
      const agyError = findAgyError(stderr);
      const isQuota =
        exitCode === QUOTA_EXIT_CODE ||
        // brief-mandated; can match unrelated text such as "disk quota"
        (result?.status === 'ERROR' && /quota/i.test(resultError)) ||
        agyError?.status === 'RESOURCE_EXHAUSTED' ||
        agyError?.error_code === 429;
      if (isQuota) {
        const full = [stderr.trim(), resultError].filter((t) => t !== '').join('\n');
        const q: Classification = { kind: 'quota', raw: full.slice(0, RAW_MAX) };
        const resetAt = parseResetsIn(full, ctx?.now ?? new Date());
        if (resetAt !== undefined) q.resetAt = resetAt;
        const modelScope = agyModelScope(ctx?.model ?? null);
        if (modelScope !== undefined) q.modelScope = modelScope;
        return q;
      }

      const message =
        firstLine(resultError) ||
        firstLine(stderr) ||
        (exitCode === 0 ? 'agy finished without a SUCCESS result' : `agy exited with code ${String(exitCode)}`);
      return { kind: 'error', message };
    },

    progress: agyReader,

    summary(stdout) {
      const response = findResult(stdout)?.response;
      return typeof response === 'string' ? response.slice(0, SUMMARY_MAX) : '';
    },

    // headless agy cannot ask, so a command outside its allow-list is refused and ends the run;
    // only auto mode (not on Windows, not on every account) or skipping permissions lets it run one
    refusesCommands() {
      return mode() !== 'auto' && !skipPermissions();
    },

    stoppedEarly(stdout, stderr) {
      const denied = deniedActions(findResult(stdout));
      if (denied.length === 0) return null;
      const noAuto = /--mode auto is not available/i.test(stderr)
        ? ' This account has no auto mode, so agy ran in its default mode, which refuses edits too: set CORTEX_AGY_MODE=accept-edits.'
        : '';
      return (
        `agy stopped early: it was refused ${denied.join(', ')}, which headless agy cannot ask for, and that ended its run.${noAuto} ` +
        "Allow what it needs under permissions.allow in agy's settings.json, or start the worker with CORTEX_AGY_SKIP_PERMISSIONS=1."
      );
    },
  };
}
