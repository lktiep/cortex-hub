import type { EngineInfo, Executor } from '@cortex/shared-types';
import { createAgyAdapter } from './agy.js';
import { createClaudeAdapter } from './claude.js';
import { createCodexAdapter } from './codex.js';
import { createGeminiAdapter } from './gemini.js';
import type { EngineAdapter } from './types.js';

export function createAdapters(names: Executor[], env: NodeJS.ProcessEnv = process.env): EngineAdapter[] {
  return names.map((name) => {
    const bin = env[`CORTEX_${name.toUpperCase()}_BIN`] || undefined;
    const opts = bin === undefined ? { env } : { env, bin };
    switch (name) {
      case 'claude':
        return createClaudeAdapter(opts);
      case 'codex':
        return createCodexAdapter(opts);
      case 'gemini':
        return createGeminiAdapter(opts);
      case 'agy':
        return createAgyAdapter(opts);
    }
  });
}

export async function describeEngines(adapters: EngineAdapter[]): Promise<{
  available: EngineAdapter[];
  engines: EngineInfo[];
  defaultExecutor: Executor | null;
}> {
  const available: EngineAdapter[] = [];
  for (const a of adapters) {
    if ((await a.detect()).found) available.push(a);
  }
  const engines: EngineInfo[] = [];
  for (const a of available) {
    let models: string[];
    try {
      models = await a.models();
    } catch {
      models = ['*'];
    }
    engines.push({ executor: a.executor, models, defaultModel: a.defaultModel() });
  }
  return { available, engines, defaultExecutor: available[0]?.executor ?? null };
}
