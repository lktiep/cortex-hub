import { defaultProbeDeps, probeNeeds } from './probe.js';
import type { ProbeDeps } from './probe.js';
import { inferNeeds } from './requirements.js';

/**
 * What this machine lacks that would make `repo`'s tasks fail, one line each; empty when it
 * lacks nothing. Only the ✗ items of `cw check`: a warning does not stop a task.
 */
export async function machineProblems(repo: string, deps: ProbeDeps): Promise<string[]> {
  const probe = await probeNeeds(repo, inferNeeds(repo), deps);
  return probe.problems.filter((p) => p.required).map((p) => `${p.tool}: ${p.detail}`);
}

/** The check the worker runs before each task; `env` is the one tasks run with. */
export function defaultReadiness(repo: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): () => Promise<string[]> {
  const deps = defaultProbeDeps(platform, env);
  return () => machineProblems(repo, deps);
}
