import { PROGRESS_MAX, RAW_MAX, SUMMARY_MAX, cliPlumbing, errorMessage, tail, tailSummary } from './common.js';
import type { CliAdapterOpts } from './common.js';
import type { Classification, EngineAdapter } from './types.js';

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

    progressText(line) {
      const obj = parseLine(line);
      if (obj?.type !== 'assistant' || !isRecord(obj.message)) return null;
      const content = obj.message.content;
      if (!Array.isArray(content)) return null;
      const parts: string[] = [];
      for (const block of content as unknown[]) {
        if (!isRecord(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
          parts.push(block.text.trim());
        } else if (block.type === 'tool_use' && typeof block.name === 'string') {
          parts.push(`[${block.name}]`);
        }
      }
      return parts.length > 0 ? parts.join(' ').slice(0, PROGRESS_MAX) : null;
    },

    summary(stdout) {
      const r = lastResult(stdout)?.result;
      return typeof r === 'string' ? r.slice(0, SUMMARY_MAX) : tailSummary(stdout);
    },
  };
}
