import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EXECUTORS } from '@cortex/shared-types';
import type { Executor } from '@cortex/shared-types';
import { sanitizeAgentId, workerPaths, workerRoot } from '../paths.js';
import type { WorkerPaths } from '../paths.js';
import { readState } from '../state.js';
import { isAlive, readPid } from './daemon.js';

/** The worker's own variables a restart sets again. The key, agent id and hub travel apart. */
export const REMEMBERED_ENV: readonly string[] = [
  'CORTEX_SETUP_CMD',
  'CORTEX_TEST_CMD',
  'CORTEX_AGY_MODE',
  'CORTEX_AGY_SKIP_PERMISSIONS',
  'CORTEX_AGY_BIN',
  'CORTEX_GH_BIN',
];

/** What `start` ran with, saved so `restart` can run it again. */
export interface StartConfig {
  agentId: string;
  repo: string;
  hub: string;
  /** Only when the key was given to the worker itself (--api-key or CORTEX_API_KEY). */
  apiKey?: string;
  engines: Executor[];
  capabilities: string[];
  engineTimeoutMin: number;
  env: Record<string, string>;
}

export interface AgentInfo {
  /** Its place in `cw ls`, from 1. */
  no: number;
  id: string;
  paths: WorkerPaths;
  /** The live worker's pid; null when it is not running. */
  pid: number | null;
  config: StartConfig | null;
  activeTaskId: string | null;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v !== '';
const isExecutor = (v: unknown): v is Executor => typeof v === 'string' && (EXECUTORS as readonly string[]).includes(v);

/** The set, non-empty `REMEMBERED_ENV` entries of `env`. */
export function rememberedEnv(env: NodeJS.ProcessEnv | Obj): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of REMEMBERED_ENV) {
    const v = env[name];
    if (isText(v)) out[name] = v;
  }
  return out;
}

/** Writes `cfg` readable by the owner only (0600; on Windows the user profile's ACL). */
export function saveStartConfig(file: string, cfg: StartConfig): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // never written
    }
    throw err;
  }
}

/** The saved settings, or null when the file is missing or not what `start` writes. */
export function readStartConfig(file: string): StartConfig | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!isObj(raw) || !isText(raw.agentId) || !isText(raw.repo) || !isText(raw.hub)) return null;
  const { engines, capabilities, engineTimeoutMin } = raw;
  if (!Array.isArray(engines) || engines.length === 0 || !engines.every(isExecutor)) return null;
  if (!Array.isArray(capabilities) || !capabilities.every(isText)) return null;
  if (typeof engineTimeoutMin !== 'number' || !Number.isFinite(engineTimeoutMin) || engineTimeoutMin <= 0) return null;
  const cfg: StartConfig = {
    agentId: raw.agentId,
    repo: raw.repo,
    hub: raw.hub,
    engines,
    capabilities,
    engineTimeoutMin,
    env: isObj(raw.env) ? rememberedEnv(raw.env) : {},
  };
  if (isText(raw.apiKey)) cfg.apiKey = raw.apiKey;
  return cfg;
}

/** The `start` flags that run `cfg` again. The key is never one of them: it goes in the env. */
export function restartArgv(cfg: StartConfig): string[] {
  const argv = [
    '--agent-id', cfg.agentId,
    '--repo', cfg.repo,
    '--hub', cfg.hub,
    '--engines', cfg.engines.join(','),
    '--engine-timeout', String(cfg.engineTimeoutMin),
  ];
  if (cfg.capabilities.length > 0) argv.push('--capabilities', cfg.capabilities.join(','));
  return argv;
}

/** `env` with the saved variables and key in place of the restarting shell's own. */
export function restartEnv(env: NodeJS.ProcessEnv, cfg: StartConfig): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const name of [...REMEMBERED_ENV, 'CORTEX_API_KEY', 'CORTEX_AGENT_ID', 'CORTEX_HUB_URL']) delete out[name];
  Object.assign(out, cfg.env);
  if (cfg.apiKey !== undefined) out['CORTEX_API_KEY'] = cfg.apiKey;
  return out;
}

const AGENT_FILES = ['pidFile', 'logFile', 'stateFile', 'startFile'] as const;

const exists = (file: string): boolean => {
  try {
    statSync(file);
    return true;
  } catch {
    return false;
  }
};

/** The agents on this machine: worker folders with a pid, log, state or start file, numbered by name. */
export function listAgents(homeDir: string): AgentInfo[] {
  let names: string[];
  try {
    names = readdirSync(workerRoot(homeDir), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const agents: AgentInfo[] = [];
  for (const id of names.sort()) {
    const paths = workerPaths(id, homeDir);
    // a folder sanitizeAgentId would not produce is not one the worker made
    if (path.basename(paths.home) !== id || !AGENT_FILES.some((k) => exists(paths[k]))) continue;
    const pid = readPid(paths);
    agents.push({
      no: agents.length + 1,
      id,
      paths,
      pid: pid !== null && isAlive(pid) ? pid : null,
      config: readStartConfig(paths.startFile),
      activeTaskId: readState(paths.stateFile).activeTaskId,
    });
  }
  return agents;
}

/**
 * The agent id `ref` names: an agent folder called exactly that, else its number in `cw ls`,
 * else the name as the worker would store it (which may be a new agent).
 */
export function resolveAgentRef(ref: string, agents: AgentInfo[]): string | { error: string } {
  const id = sanitizeAgentId(ref);
  if (agents.some((a) => a.id === id)) return id;
  if (/^\d+$/.test(ref)) {
    const hit = agents.find((a) => a.no === Number(ref));
    if (hit !== undefined) return hit.id;
    const range = agents.length === 0 ? 'there are none yet' : `pick 1 to ${agents.length}`;
    return { error: `no agent number ${ref} on this machine (${range}); see the list with: cw ls` };
  }
  return id;
}

/** A numbered table of `agents`. It never shows a key. */
export function formatAgentTable(agents: AgentInfo[]): string {
  if (agents.length === 0) {
    return 'no agents on this machine yet; start one with: cw start <name> --repo <path> --hub <url>';
  }
  const header = ['#', 'AGENT', 'STATE', 'TASK', 'ENGINES', 'REPO'];
  const rows = agents.map((a) => [
    String(a.no),
    a.id,
    a.pid === null ? 'stopped' : `running (pid ${a.pid})`,
    a.activeTaskId ?? '-',
    a.config?.engines.join(',') ?? '-',
    a.config?.repo ?? '-',
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]): string =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd();
  return [line(header), ...rows.map(line)].join('\n');
}
