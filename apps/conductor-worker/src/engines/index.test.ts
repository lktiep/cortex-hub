import { describe, expect, it } from 'vitest';
import { createAdapters, describeEngines } from './index.js';
import type { EngineAdapter } from './types.js';

function fake(executor: EngineAdapter['executor'], found: boolean, models: () => Promise<string[]>): EngineAdapter {
  return {
    executor,
    detect: () => Promise.resolve(found ? { found: true } : { found: false }),
    models,
    defaultModel: () => null,
  } as unknown as EngineAdapter;
}

describe('describeEngines', () => {
  it('keeps detected adapters in requested order and picks the first as default', async () => {
    const a = fake('gemini', true, () => Promise.resolve(['g']));
    const b = fake('claude', false, () => Promise.resolve(['c']));
    const c = fake('codex', true, () => Promise.resolve(['*']));
    const r = await describeEngines([a, b, c]);
    expect(r.available).toEqual([a, c]);
    expect(r.engines).toEqual([
      { executor: 'gemini', models: ['g'], defaultModel: null },
      { executor: 'codex', models: ['*'], defaultModel: null },
    ]);
    expect(r.defaultExecutor).toBe('gemini');
  });
  it("reports ['*'] when models() throws", async () => {
    const a = fake('agy', true, () => Promise.reject(new Error('boom')));
    expect((await describeEngines([a])).engines[0]?.models).toEqual(['*']);
  });
  it('treats a rejecting or throwing detect() as not found and keeps order', async () => {
    const bad = { ...fake('claude', true, () => Promise.resolve([])), detect: () => Promise.reject(new Error('x')) };
    const thrower = {
      ...fake('codex', true, () => Promise.resolve([])),
      detect: (): never => {
        throw new Error('sync');
      },
    };
    const ok1 = fake('gemini', true, () => Promise.resolve(['g']));
    const ok2 = fake('agy', true, () => Promise.resolve(['a']));
    const r = await describeEngines([ok1, bad, thrower, ok2]);
    expect(r.engines.map((e) => e.executor)).toEqual(['gemini', 'agy']);
  });
  it('reports no default when nothing is found', async () => {
    const r = await describeEngines([fake('claude', false, () => Promise.resolve([]))]);
    expect(r).toEqual({ available: [], engines: [], defaultExecutor: null });
  });
});

describe('createAdapters', () => {
  it('creates one adapter per name, including agy, in order', () => {
    const r = createAdapters(['gemini', 'agy', 'claude', 'codex'], {});
    expect(r.map((a) => a.executor)).toEqual(['gemini', 'agy', 'claude', 'codex']);
  });
  it('honours CORTEX_<X>_BIN for all four executors', async () => {
    for (const name of ['claude', 'codex', 'gemini', 'agy'] as const) {
      const bin = `/nonexistent/dir/${name}-custom`;
      const [a] = createAdapters([name], { [`CORTEX_${name.toUpperCase()}_BIN`]: bin });
      expect(await a!.detect()).toEqual({ found: false, path: bin });
    }
  });
});
