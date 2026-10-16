import { cliPlumbing, errorMessage, plainProgress, tailSummary } from './common.js';
import type { CliAdapterOpts } from './common.js';
import type { Classification, EngineAdapter } from './types.js';

const QUOTA = /usage limit|429|rate limit/i;
const RAW_MAX = 2000;

export function createCodexAdapter(opts: CliAdapterOpts = {}): EngineAdapter {
  const buildArgs: EngineAdapter['buildArgs'] = (i) => {
    const args = ['exec', '--full-auto'];
    if (i.model !== null) args.push('-m', i.model);
    if (i.effort !== null) args.push('-c', `model_reasoning_effort=${i.effort}`);
    args.push('-');
    return { args, stdin: i.prompt };
  };

  return {
    ...cliPlumbing('codex', opts, buildArgs),

    classify(exitCode, stdout, stderr): Classification {
      if (exitCode === 0) return { kind: 'ok' };
      const text = [stderr, stdout].filter((t) => t.trim() !== '').join('\n');
      if (QUOTA.test(text)) return { kind: 'quota', raw: text.slice(0, RAW_MAX) };
      return { kind: 'error', message: errorMessage(exitCode, stderr, stdout, 'codex') };
    },

    progressText: plainProgress,
    summary: tailSummary,
  };
}
