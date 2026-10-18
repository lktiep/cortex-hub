import type { ProgressItem } from './engines/types.js';
import { scrubCredentials } from './git.js';
import { createProgressBatcher } from './progress.js';
import type { ProgressBatcherOptions } from './progress.js';
import type { Transcript } from './transcript.js';

/** Tokens with a recognisable shape: hub keys, GitHub, Anthropic/OpenAI, Slack and AWS keys. */
const TOKENS = [
  /\bsk_ctx_[A-Za-z0-9_-]+/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{8,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
/** `password=…`, `"api_key": "…"`, `token: …`: the value goes. */
const ASSIGNED =
  /\b(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|password|passwd|token)("?\s*[=:]\s*"?)[^\s"'&,;]+/gi;

/** `text` without credentials: URL userinfo, known token shapes, and values assigned to secret-sounding names. */
export function scrubSecrets(text: string): string {
  let out = scrubCredentials(text);
  for (const re of TOKENS) out = out.replace(re, '***');
  return out.replace(BEARER, '$1***').replace(ASSIGNED, '$1$2***');
}

/**
 * Shortens paths for the hub: the worktree's become relative and the home folder becomes `~`,
 * with either slash.
 */
export function pathStripper(worktree: string, home: string): (text: string) => string {
  const spellings = (p: string): string[] =>
    [...new Set([p, p.replace(/\\/g, '/'), p.replace(/\//g, '\\')])].filter((s) => s.length > 1);
  const pairs: Array<[string, string]> = [];
  for (const w of spellings(worktree)) pairs.push([`${w}/`, ''], [`${w}\\`, ''], [w, '.']);
  for (const h of spellings(home)) pairs.push([h, '~']);
  return (text) => pairs.reduce((out, [from, to]) => out.split(from).join(to), text);
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The short line the hub gets for an item, or null for what stays in the transcript. */
export function hubLine(item: ProgressItem): string | null {
  switch (item.kind) {
    case 'text':
      return oneLine(item.text, 300);
    case 'thinking':
      return `(thinking) ${oneLine(item.text, 200)}`;
    case 'tool':
      return `→ ${oneLine(item.text, 300)}`;
    case 'error':
      return `✗ ${oneLine(item.text, 300)}`;
    case 'info':
      return `• ${oneLine(item.text, 300)}`;
    default:
      return null;
  }
}

const MARKERS: Record<ProgressItem['kind'], string> = {
  text: '',
  thinking: '(thinking) ',
  tool: '→ ',
  result: '← ',
  error: '✗ ',
  info: '• ',
  log: 'stderr: ',
};

function clock(at: Date): string {
  return [at.getHours(), at.getMinutes(), at.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

/** An item as the transcript keeps it: the local time, a marker, and its lines indented under the first. */
export function transcriptEntry(item: ProgressItem, at: Date): string {
  const [first = '', ...rest] = item.text.split('\n');
  const stamp = clock(at);
  const indent = ' '.repeat(stamp.length + 1);
  return [`${stamp} ${MARKERS[item.kind]}${first}`, ...rest.map((l) => `${indent}${l}`)].join('\n');
}

export interface Activity {
  /** Something the engine printed. */
  engine(item: ProgressItem): void;
  /** A step of the task around the engine: setup, tests, commit, push. */
  phase(text: string): void;
  /** Sends what is waiting and stops the heartbeat; closes the transcript. */
  stop(): void;
}

export interface ActivityOptions {
  /** Sends a progress message; `idleMs` is set on a heartbeat. */
  send: (message: string, idleMs?: number) => void;
  transcript?: Transcript;
  /** Applied to what the hub gets, after the credentials are scrubbed. */
  strip?: (text: string) => string;
  now?: () => number;
  /** A heartbeat goes out once nothing has been printed for this long, and again each time as long. */
  quietAfterMs?: number;
  checkEveryMs?: number;
  batch?: ProgressBatcherOptions;
}

/**
 * What a task is doing, two ways: every item in full in the local transcript, and short,
 * scrubbed lines to the hub in batches. When the engine prints nothing for a while, a
 * heartbeat names the step it is on.
 */
export function createActivity(opts: ActivityOptions): Activity {
  const now = opts.now ?? Date.now;
  const quietAfterMs = opts.quietAfterMs ?? 60_000;
  const checkEveryMs = opts.checkEveryMs ?? 15_000;
  const strip = opts.strip ?? ((t: string): string => t);
  const batcher = createProgressBatcher((message) => opts.send(message), { now, ...opts.batch });
  let lastActivity = now();
  let lastBeat = -Infinity;
  let step = 'starting';
  let stopped = false;

  const record = (raw: ProgressItem): void => {
    if (stopped) return;
    lastActivity = now();
    const item = { kind: raw.kind, text: scrubSecrets(raw.text) };
    opts.transcript?.write(transcriptEntry(item, new Date(lastActivity)));
    const line = hubLine({ kind: item.kind, text: strip(item.text) });
    if (line !== null) batcher.push(line);
    if (item.kind === 'tool' || item.kind === 'info') step = oneLine(strip(item.text), 160);
  };

  const timer = setInterval(() => {
    const at = now();
    const idle = at - lastActivity;
    if (stopped || idle < quietAfterMs || at - lastBeat < quietAfterMs) return;
    lastBeat = at;
    batcher.flush();
    try {
      opts.send(`still running: ${step}, no output for ${Math.floor(idle / 60_000)} min`, idle);
    } catch {
      // best effort
    }
  }, checkEveryMs);
  timer.unref();

  return {
    engine: record,
    phase(text) {
      record({ kind: 'info', text });
    },
    stop() {
      if (stopped) return;
      clearInterval(timer);
      batcher.stop();
      stopped = true;
      opts.transcript?.close();
    },
  };
}
