import { parseResetsIn } from './quota.js';
import { cliPlumbing, errorMessage, plainProgress, tailSummary } from './common.js';
import type { CliAdapterOpts } from './common.js';
import type { Classification, EngineAdapter } from './types.js';

const QUOTA = /RESOURCE_EXHAUSTED|\b429\b/;
const RAW_MAX = 2000;

export function createGeminiAdapter(opts: CliAdapterOpts = {}): EngineAdapter {
  const buildArgs: EngineAdapter['buildArgs'] = (i) => {
    // `-p` forces headless mode; gemini appends its value to the stdin input. The value has
    // no spaces so it passes the win32 shell-safe argument check.
    const args = ['-y'];
    if (i.model !== null) args.push('-m', i.model);
    args.push('-p', 'Proceed.');
    return { args, stdin: i.prompt };
  };

  return {
    ...cliPlumbing('gemini', opts, buildArgs),

    classify(exitCode, stdout, stderr, ctx): Classification {
      if (exitCode === 0) return { kind: 'ok' };
      const text = [stderr, stdout].filter((t) => t.trim() !== '').join('\n');
      if (QUOTA.test(text)) {
        const q: Classification = { kind: 'quota', raw: text.slice(0, RAW_MAX) };
        const resetAt = parseResetsIn(text, ctx?.now ?? new Date());
        if (resetAt !== undefined) q.resetAt = resetAt;
        return q;
      }
      return { kind: 'error', message: errorMessage(exitCode, stderr, stdout, 'gemini') };
    },

    progressText: plainProgress,
    summary: tailSummary,
  };
}
