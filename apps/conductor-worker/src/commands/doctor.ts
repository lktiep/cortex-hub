import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { Executor } from '@cortex/shared-types';
import { WebSocket } from 'ws';
import { detectHubConfig, hubBaseFromUrl, readClaudeJson, readCodexToml, readMcpJson } from '../config.js';
import type { HubConfig, McpEntry } from '../config.js';
import { createAdapters } from '../engines/index.js';
import { installHint } from '../engines/install.js';
import type { EngineAdapter } from '../engines/types.js';
import { createGh, originUrl } from '../git.js';
import type { GhRun } from '../git.js';
import { buildWsUrl } from '../hub-client.js';
import { redact } from '../logger.js';
import { defaultAgentId, workerPaths } from '../paths.js';
import { readState } from '../state.js';
import { WORKER_VERSION } from '../version.js';

export interface Check {
  name: string;
  ok: boolean;
  required: boolean;
  detail: string;
  fix?: string;
}

export interface DoctorContext {
  nodeVersion: string;
  repo: string;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  flags: { hub?: string; apiKey?: string; agentId?: string };
  engines: Executor[];
  probe: boolean;
  fetchImpl?: typeof fetch;
  gh?: GhRun;
  adapters?: EngineAdapter[];
  /** Opens the socket and closes it again without sending anything. 401 = the upgrade was refused. */
  wsConnect?: (url: string, key: string) => Promise<'open' | 401 | string>;
  /** The output of `git --version`, or null when git is missing. */
  gitVersion?: () => Promise<string | null>;
}

const NETWORK_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 120_000;
const MIN_NODE_MAJOR = 20;

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function defaultGitVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['--version'], { timeout: NETWORK_TIMEOUT_MS }, (err, stdout) => {
      resolve(err === null ? stdout.trim() : null);
    });
  });
}

/**
 * Opens the socket and closes it with 1000 at once; it never sends a message, so the hub never
 * sees a registration. The URL carries the key: nothing returned here may contain it.
 */
export function defaultWsConnect(url: string, key: string): Promise<'open' | 401 | string> {
  return new Promise((resolve) => {
    let settled = false;
    let ws: WebSocket | undefined;
    const done = (v: 'open' | 401 | string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(typeof v === 'string' ? v.split(url).join('<hub url>') : v);
    };
    const timer = setTimeout(() => {
      done('timed out after 10 s');
      ws?.terminate();
    }, NETWORK_TIMEOUT_MS);
    try {
      ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` }, handshakeTimeout: NETWORK_TIMEOUT_MS });
    } catch (err) {
      done(messageOf(err));
      return;
    }
    ws.on('open', () => {
      done('open');
      ws?.close(1000);
    });
    ws.on('unexpected-response', (_req, res) => {
      done(res.statusCode === 401 ? 401 : `HTTP ${String(res.statusCode)}`);
      res.resume();
      ws?.terminate();
    });
    ws.on('error', (err) => done(messageOf(err)));
  });
}

const skipped = (why: string): string => `skipped — ${why}`;

async function engineCheck(a: EngineAdapter, ctx: DoctorContext): Promise<Check> {
  const name = `engine ${a.executor}`;
  const missing: Check = {
    name,
    ok: false,
    required: false,
    detail: 'not found',
    fix: installHint(a.executor, process.platform),
  };
  let found: Awaited<ReturnType<EngineAdapter['detect']>>;
  try {
    found = await a.detect();
  } catch (err) {
    return { ...missing, detail: `looking for it failed: ${messageOf(err)}` };
  }
  if (!found.found) return missing;
  const where = `${found.path ?? a.executor}${found.version === undefined ? '' : ` ${found.version}`}`;
  if (!ctx.probe) return { name, ok: true, required: false, detail: `found ${where}` };

  try {
    // cwd is the repo: codex exec refuses to run outside a git repository
    const out = await a.run({
      prompt: 'Reply with OK',
      cwd: ctx.repo,
      model: a.defaultModel(),
      effort: null,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS + 10_000),
      timeoutMs: PROBE_TIMEOUT_MS,
      onLine: () => undefined,
    });
    const c = a.classify(out.exitCode, out.stdout, out.stderr);
    if (c.kind === 'ok') return { name, ok: true, required: false, detail: `found ${where}; probe ok` };
    if (c.kind === 'quota') {
      const reset = c.resetAt === undefined ? '' : `, resets ${c.resetAt}`;
      return { name, ok: false, required: false, detail: `found ${where}; probe: quota exhausted${reset}` };
    }
    return {
      name,
      ok: false,
      required: false,
      detail: `found ${where}; probe failed: ${c.message}`,
      fix: `log in to ${a.executor} (run it once by hand)`,
    };
  } catch (err) {
    return { name, ok: false, required: false, detail: `found ${where}; probe failed: ${messageOf(err)}` };
  }
}

/** Where each engine keeps its cortex-hub MCP entry. */
function mcpEntryFor(executor: Executor, ctx: DoctorContext): { entry: McpEntry | null; file: string } {
  const h = ctx.homeDir;
  switch (executor) {
    case 'claude': {
      const file = path.join(h, '.claude.json');
      return { file, entry: readClaudeJson(file, ctx.repo, ctx.env) };
    }
    case 'codex': {
      const file = path.join(h, '.codex', 'config.toml');
      return { file, entry: readCodexToml(file, ctx.env) };
    }
    case 'agy': {
      const file = path.join(h, '.gemini', 'antigravity', 'mcp_config.json');
      return { file, entry: readMcpJson(file, ctx.env, file) };
    }
    case 'gemini': {
      const file = path.join(h, '.gemini', 'settings.json');
      return { file, entry: readMcpJson(file, ctx.env, file) };
    }
  }
}

function mcpCheck(ctx: DoctorContext, hub: HubConfig | null): Check {
  const name = 'engine MCP configs';
  if (hub === null) return { name, ok: false, required: false, detail: skipped('no hub config') };
  const warnings: string[] = [];
  const files: string[] = [];
  for (const executor of ctx.engines) {
    try {
      const { entry, file } = mcpEntryFor(executor, ctx);
      if (entry === null) continue;
      const other = hubBaseFromUrl(entry.url);
      if (other !== hub.hubBase) {
        warnings.push(`${executor}'s MCP points at ${other} — tasks it runs will report to that hub`);
        files.push(file);
      }
    } catch {
      // an unreadable config is not worth a warning
    }
  }
  if (warnings.length === 0) return { name, ok: true, required: false, detail: 'consistent with the worker hub' };
  return {
    name,
    ok: false,
    required: false,
    detail: warnings.join('; '),
    fix: `edit ${files.join(', ')} so the cortex-hub URL is ${hub.hubBase}/mcp`,
  };
}

async function getText(
  f: typeof fetch,
  url: string,
): Promise<{ status: number; text: string } | { error: string }> {
  try {
    const res = await f(url, { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
    return { status: res.status, text: (await res.text()).trim() };
  } catch (err) {
    return { error: messageOf(err) };
  }
}

export async function runDoctor(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  const f = ctx.fetchImpl ?? fetch;

  const hubOrErr = detectHubConfig({ flags: ctx.flags, env: ctx.env, homeDir: ctx.homeDir, repoPath: ctx.repo });
  const hub = 'error' in hubOrErr ? null : hubOrErr;
  const secrets = [hub?.apiKey ?? '', ctx.flags.apiKey ?? ''].filter((s) => s !== '');

  // 1 node
  const major = Number.parseInt(ctx.nodeVersion.replace(/^v/, ''), 10);
  checks.push({
    name: 'node',
    ok: major >= MIN_NODE_MAJOR,
    required: true,
    detail: ctx.nodeVersion,
    ...(major >= MIN_NODE_MAJOR ? {} : { fix: `install Node ${String(MIN_NODE_MAJOR)} or newer` }),
  });

  // 2 git
  let gitV: string | null = null;
  try {
    gitV = await (ctx.gitVersion ?? defaultGitVersion)();
  } catch {
    gitV = null;
  }
  checks.push(
    gitV === null
      ? { name: 'git', ok: false, required: true, detail: 'not found', fix: 'install git from https://git-scm.com' }
      : { name: 'git', ok: true, required: true, detail: gitV },
  );

  // 3 gh
  try {
    const r = await (ctx.gh ?? createGh())(['auth', 'status'], { cwd: ctx.repo });
    checks.push(
      r.code === 0
        ? { name: 'gh', ok: true, required: false, detail: 'logged in' }
        : {
            name: 'gh',
            ok: false,
            required: false,
            detail: 'not logged in — the worker will report compare URLs instead of opening pull requests',
            fix: 'gh auth login',
          },
    );
  } catch (err) {
    checks.push({
      name: 'gh',
      ok: false,
      required: false,
      detail: `not usable (${messageOf(err)}) — the worker will report compare URLs instead of opening pull requests`,
      fix: 'install the GitHub CLI from https://cli.github.com and run gh auth login',
    });
  }

  // 4 engines
  const engineEnv = Object.fromEntries(Object.entries(ctx.env).filter(([, v]) => v === undefined || !secrets.includes(v)));
  const adapters = ctx.adapters ?? createAdapters(ctx.engines, engineEnv);
  const engineChecks = await Promise.all(adapters.map((a) => engineCheck(a, ctx)));
  checks.push(...engineChecks);
  checks.push(
    engineChecks.some((c) => c.ok)
      ? {
          name: 'engines',
          ok: true,
          required: true,
          detail: `usable: ${engineChecks.filter((c) => c.ok).map((c) => c.name.replace('engine ', '')).join(', ')}`,
        }
      : {
          name: 'engines',
          ok: false,
          required: true,
          detail: ctx.probe ? 'no engine found and logged in' : 'no engine found',
          fix: `install one and log in to it once: ${ctx.engines.map((e) => `${e}: ${installHint(e, process.platform)}`).join('; ')}`,
        },
  );

  // 5 hub config
  checks.push(
    hub === null
      ? {
          name: 'hub config',
          ok: false,
          required: true,
          detail: 'error' in hubOrErr ? hubOrErr.error : 'not found',
          fix: 'pass --hub <url> and --api-key <key>, or set CORTEX_HUB_URL and CORTEX_API_KEY',
        }
      : {
          name: 'hub config',
          ok: true,
          required: true,
          detail: `${hub.hubBase} (hub from ${hub.source.hub}, key from ${hub.source.key})`,
        },
  );

  // 6 health, 7 version, 8 handshake
  const noHub = skipped('no hub config');
  if (hub === null) {
    checks.push({ name: 'hub health', ok: false, required: true, detail: noHub });
    checks.push({ name: 'worker version', ok: false, required: false, detail: noHub });
    checks.push({ name: 'handshake', ok: false, required: true, detail: noHub });
  } else {
    const health = await getText(f, `${hub.hubBase}/health`);
    checks.push(
      'error' in health
        ? { name: 'hub health', ok: false, required: true, detail: `cannot reach ${hub.hubBase}: ${health.error}`, fix: 'check the hub URL and your network' }
        : health.status === 200
          ? { name: 'hub health', ok: true, required: true, detail: `${hub.hubBase}/health answered 200` }
          : { name: 'hub health', ok: false, required: true, detail: `${hub.hubBase}/health answered ${String(health.status)}`, fix: 'check that the hub is running' },
    );

    const ver = await getText(f, `${hub.hubBase}/conductor/worker.version`);
    if ('error' in ver || ver.status !== 200) {
      const why = 'error' in ver ? ver.error : `HTTP ${String(ver.status)}`;
      checks.push({ name: 'worker version', ok: false, required: false, detail: `could not read the hub's worker version (${why})` });
    } else if (ver.text === WORKER_VERSION) {
      checks.push({ name: 'worker version', ok: true, required: false, detail: `${WORKER_VERSION} matches the hub` });
    } else {
      checks.push({
        name: 'worker version',
        ok: false,
        required: false,
        detail: `this worker is ${WORKER_VERSION}, the hub serves ${ver.text}`,
        fix: 'cortex-worker update',
      });
    }

    // a random id: the worker's own would make the hub replace a running worker (4000)
    const doctorId = `doctor-${randomBytes(3).toString('hex')}`;
    let result: 'open' | 401 | string;
    try {
      const url = buildWsUrl(hub.wsUrl, { apiKey: hub.apiKey, agentId: doctorId, hostname: os.hostname() });
      result = await (ctx.wsConnect ?? defaultWsConnect)(url, hub.apiKey);
      // the URL carries the key in its query: it never goes into a detail
      if (typeof result === 'string') result = result.split(url).join('<hub url>');
    } catch (err) {
      result = messageOf(err);
    }
    checks.push(
      result === 'open'
        ? { name: 'handshake', ok: true, required: true, detail: 'the hub accepted the key and the handshake' }
        : result === 401
          ? { name: 'handshake', ok: false, required: true, detail: 'the hub rejected the API key (401)', fix: 'check the key in --api-key, CORTEX_API_KEY or the MCP config' }
          : { name: 'handshake', ok: false, required: true, detail: `could not connect: ${result}` },
    );
  }

  // 9 origin
  let origin: string | null = null;
  try {
    origin = await originUrl(ctx.repo);
  } catch {
    origin = null;
  }
  checks.push(
    origin === null
      ? {
          name: 'origin',
          ok: false,
          required: true,
          detail: `${ctx.repo} has no git remote "origin"`,
          fix: 'run doctor inside a clone of the project, or pass --repo <path>',
        }
      : { name: 'origin', ok: true, required: true, detail: origin },
  );

  // 10 project mapping
  if (origin === null) {
    checks.push({ name: 'project mapping', ok: false, required: false, detail: skipped('no origin') });
  } else {
    const agentId = ctx.flags.agentId ?? defaultAgentId(os.hostname(), ctx.repo);
    const projectId = readState(workerPaths(agentId, ctx.homeDir).stateFile).lastRegistered?.projectId ?? null;
    checks.push({
      name: 'project mapping',
      ok: true,
      required: false,
      detail: projectId === null ? 'unknown until first start' : `project ${projectId}`,
    });
  }

  // 11 MCP configs
  checks.push(mcpCheck(ctx, hub));

  return checks.map((c) => ({
    ...c,
    detail: redact(c.detail, secrets),
    ...(c.fix === undefined ? {} : { fix: redact(c.fix, secrets) }),
  }));
}

export function formatChecks(checks: Check[]): string {
  return checks
    .map((c) => `${c.ok ? '✓' : '✗'} ${c.name} — ${c.detail}${c.fix === undefined ? '' : `\n    fix: ${c.fix}`}`)
    .join('\n');
}
