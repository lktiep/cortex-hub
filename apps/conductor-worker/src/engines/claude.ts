import { RAW_MAX, SUMMARY_MAX, cliPlumbing, errorMessage, item, resultHead, tail, tailSummary } from './common.js';
import type { CliAdapterOpts } from './common.js';
import type { Classification, EngineAdapter, ProgressItem } from './types.js';

const RESULT_QUOTA = /usage limit|rate limit|hit your limit/i;
const STDERR_QUOTA = /usage limit|hit your limit/i;
const EPOCH_SUFFIX = /\|(\d{10})(?!\d)/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseLine(line: string): Record<string, unknown> | undefined {
  const t = line.trim();
  if (!t.startsWith('{')) return undefined;
  try {
    const v: unknown = JSON.parse(t);
    return isRecord(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** The last `result` event of a stream-json transcript. */
function lastResult(stdout: string): Record<string, unknown> | undefined {
  let found: Record<string, unknown> | undefined;
  for (const line of stdout.split('\n')) {
    const obj = parseLine(line);
    if (obj?.type === 'result') found = obj;
  }
  return found;
}

/** What a tool call works on, from its input: the command, the file, the pattern. */
function toolTarget(name: string, input: unknown): string {
  if (!isRecord(input)) return '';
  const str = (key: string): string => {
    const v = input[key];
    return typeof v === 'string' ? v : '';
  };
  switch (name) {
    case 'Bash':
      return str('command');
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return str('file_path');
    case 'NotebookEdit':
      return str('notebook_path');
    case 'Grep':
      return [str('pattern'), str('path')].filter((s) => s !== '').join(' in ');
    case 'Glob':
      return str('pattern');
    case 'WebFetch':
      return str('url');
    case 'WebSearch':
      return str('query');
    case 'Task':
    case 'Agent':
      return str('description');
    case 'TodoWrite': {
      const todos: unknown[] = Array.isArray(input.todos) ? input.todos : [];
      const current = todos.find((t) => isRecord(t) && t.status === 'in_progress');
      return isRecord(current) && typeof current.content === 'string' ? current.content : `${todos.length} todos`;
    }
    default:
      return Object.values(input).find((v): v is string => typeof v === 'string' && v.trim() !== '') ?? '';
  }
}

/** The text of a tool_result's content: a string, or a list of text blocks. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (isRecord(b) && typeof b.text === 'string' ? b.text : ''))
    .filter((t) => t !== '')
    .join('\n');
}

/** The progress items of one stream-json line. */
function readLine(raw: string): ProgressItem[] {
  const obj = parseLine(raw);
  if (obj === undefined) return [];
  if (obj.type === 'system' && obj.subtype === 'init') {
    return item('info', typeof obj.model === 'string' ? `claude started (${obj.model})` : 'claude started');
  }
  if (obj.type === 'result') {
    return obj.is_error === true && typeof obj.result === 'string' ? item('error', obj.result) : [];
  }
  if (!isRecord(obj.message) || !Array.isArray(obj.message.content)) return [];
  const out: ProgressItem[] = [];
  for (const block of obj.message.content as unknown[]) {
    if (!isRecord(block)) continue;
    if (obj.type === 'assistant') {
      if (block.type === 'text' && typeof block.text === 'string') out.push(...item('text', block.text));
      else if (block.type === 'thinking' && typeof block.thinking === 'string') out.push(...item('thinking', block.thinking));
      else if (block.type === 'tool_use' && typeof block.name === 'string') {
        const target = toolTarget(block.name, block.input);
        out.push(...item('tool', target === '' ? block.name : `${block.name}: ${target}`));
      }
    } else if (obj.type === 'user' && block.type === 'tool_result') {
      const text = resultText(block.content);
      if (block.is_error === true) out.push(...item('error', text === '' ? 'the tool failed' : text));
      else out.push(...item('result', resultHead(text)));
    }
  }
  return out;
}

export function createClaudeAdapter(opts: CliAdapterOpts = {}): EngineAdapter {
  const buildArgs: EngineAdapter['buildArgs'] = (i) => {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto'];
    if (i.model !== null) args.push('--model', i.model);
    return { args, stdin: i.prompt };
  };

  return {
    ...cliPlumbing('claude', opts, buildArgs),

    classify(exitCode, stdout, stderr): Classification {
      if (exitCode === 0) return { kind: 'ok' };
      const result = lastResult(stdout);
      const resultText = result?.is_error === true && typeof result.result === 'string' ? result.result : '';
      const sources = [resultText, stderr].filter((t) => t.trim() !== '');
      const hit = RESULT_QUOTA.test(resultText) ? resultText : STDERR_QUOTA.test(stderr) ? stderr : undefined;
      if (hit !== undefined) {
        const q: Classification = { kind: 'quota', raw: sources.join('\n').slice(0, RAW_MAX) };
        const epoch = EPOCH_SUFFIX.exec(hit)?.[1];
        if (epoch !== undefined) q.resetAt = new Date(Number(epoch) * 1000).toISOString();
        return q;
      }
      const message =
        typeof result?.result === 'string' && result.is_error === true && result.result.trim() !== ''
          ? tail(result.result, 300)
          : errorMessage(exitCode, stderr, stdout, 'claude');
      return { kind: 'error', message };
    },

    progress() {
      return { line: readLine, errLine: (raw) => item('log', raw), end: () => [] };
    },

    summary(stdout) {
      const r = lastResult(stdout)?.result;
      return typeof r === 'string' ? r.slice(0, SUMMARY_MAX) : tailSummary(stdout);
    },
  };
}
