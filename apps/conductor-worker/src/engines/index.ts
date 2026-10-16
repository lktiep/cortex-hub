import type { EngineInfo, Executor } from '@cortex/shared-types';
import { createAgyAdapter } from './agy.js';
import { createClaudeAdapter } from './claude.js';
import { createCodexAdapter } from './codex.js';
import { createGeminiAdapter } from './gemini.js';
import type { EngineAdapter } from './types.js';

export function createAdapters(names: Executor[], env: NodeJS.ProcessEnv = process.env): EngineAdapter[] {
  return names.map((name) => {
    const opts = { env };
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
  const found = await Promise.all(
    adapters.map(async (a) => {
      try {
        return (await a.detect()).found;
      } catch {
        return false;
      }
    }),
  );
  const available = adapters.filter((_, i) => found[i]);
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
