import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path, { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CONDUCTOR_PROTOCOL_VERSION, EXECUTORS } from '@cortex/shared-types';
import type { Executor } from '@cortex/shared-types';
import { isAlive, printLogs, readPid, startDaemon, statusText, stopWorker } from './commands/daemon.js';
import { updateBundle } from './commands/update.js';
import { detectHubBase, detectHubConfig } from './config.js';
import { createAdapters, describeEngines } from './engines/index.js';
import type { EngineAdapter } from './engines/types.js';
import { createGh, originUrl } from './git.js';
import { HubClient } from './hub-client.js';
import type { FatalReason } from './hub-client.js';
import { createLogger } from './logger.js';
import type { Logger } from './logger.js';
import { defaultAgentId, workerPaths } from './paths.js';
import type { WorkerPaths } from './paths.js';
import { readState } from './state.js';
import { WORKER_VERSION } from './version.js';
import { Worker } from './worker.js';

export interface CliArgs {
  command: 'start' | 'stop' | 'status' | 'logs' | 'doctor' | 'update' | 'hub-url' | 'version' | 'help';
  daemon: boolean;
  follow: boolean;
  probe: boolean;
  agentId?: string;
  repo?: string;
  engines?: Executor[];
  capabilities?: string[];
  hub?: string;
  apiKey?: string;
  engineTimeoutMin?: number;
}

/** Tried in this order; the first one found is the default executor. */
export const DEFAULT_ENGINES: readonly Executor[] = ['agy', 'claude', 'codex', 'gemini'];
const DEFAULT_ENGINE_TIMEOUT_MIN = 90;
const DEFAULT_STOP_POLL_MS = 2_000;
/** How long a finished `start` may linger on a stray handle before it exits anyway. */
const EXIT_SAFETY_MS = 5_000;
const WORKER_IDENTITY = { name: 'Cortex Worker', email: 'cortex-worker@localhost' };

const RUN_COMMANDS = ['start', 'stop', 'status', 'logs', 'doctor', 'update', 'hub-url'] as const;
type RunCommand = (typeof RUN_COMMANDS)[number];
const isRunCommand = (s: string): s is RunCommand => (RUN_COMMANDS as readonly string[]).includes(s);
const isExecutor = (s: string): s is Executor => (EXECUTORS as readonly string[]).includes(s);

const INSTALL_HINTS: Record<Executor, string> = {
  agy:
    process.platform === 'win32'
      ? 'the PowerShell installer from https://antigravity.google/docs/getting-started?tab=cli'
      : 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
  gemini: 'npm install -g @google/gemini-cli',
};

/** A comma list, trimmed, without empty items or repeats. */
function commaList(raw: string): string[] {
  return [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => s !== ''))];
}

const bare = (command: CliArgs['command']): CliArgs => ({ command, daemon: false, follow: false, probe: false });

export function parseCli(argv: string[]): CliArgs | { error: string } {
  const first = argv[0];
  if (first === undefined || first === 'help' || first === '--help' || first === '-h') return bare('help');
  if (first === 'version' || first === '--version' || first === '-v') return bare('version');
  if (!isRunCommand(first)) {
    return { error: first.startsWith('-') ? `expected a command before ${first}` : `unknown command: ${first}` };
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: argv.slice(1),
      strict: true,
      allowPositionals: true,
      options: {
        daemon: { type: 'boolean', short: 'd' },
        follow: { type: 'boolean', short: 'f' },
        probe: { type: 'boolean' },
        'agent-id': { type: 'string' },
        repo: { type: 'string' },
        engines: { type: 'string' },
        capabilities: { type: 'string' },
        hub: { type: 'string' },
        'api-key': { type: 'string' },
        'engine-timeout': { type: 'string' },
      },
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  const { values, positionals } = parsed;
  if (positionals.length > 0) return { error: `unexpected argument: ${positionals[0]}` };

  let engines: Executor[] = [...DEFAULT_ENGINES];
  if (values.engines !== undefined) {
    const names = commaList(values.engines);
    if (names.length === 0) return { error: `--engines needs at least one of ${EXECUTORS.join(', ')}` };
    const unknown = names.find((n) => !isExecutor(n));
    if (unknown !== undefined) return { error: `unknown engine: ${unknown} (expected ${EXECUTORS.join(', ')})` };
    engines = names.filter(isExecutor);
  }

  let engineTimeoutMin = DEFAULT_ENGINE_TIMEOUT_MIN;
  const timeout = values['engine-timeout'];
  if (timeout !== undefined) {
    const n = timeout.trim() === '' ? NaN : Number(timeout);
    if (!Number.isFinite(n) || n <= 0) {
      return { error: `--engine-timeout must be a positive number of minutes (got "${timeout}")` };
    }
    engineTimeoutMin = n;
  }

  if (values['agent-id'] === '') return { error: '--agent-id must not be empty' };

  const args: CliArgs = {
    command: first,
    daemon: values.daemon ?? false,
    follow: values.follow ?? false,
    probe: values.probe ?? false,
    engines,
    capabilities: values.capabilities === undefined ? [] : commaList(values.capabilities),
    engineTimeoutMin,
  };
  if (values['agent-id'] !== undefined) args.agentId = values['agent-id'];
  if (values.repo !== undefined) args.repo = values.repo;
  if (values.hub !== undefined) args.hub = values.hub;
  if (values['api-key'] !== undefined) args.apiKey = values['api-key'];
  return args;
}

function helpText(): string {
  return [
    `cortex-worker ${WORKER_VERSION} (protocol ${CONDUCTOR_PROTOCOL_VERSION})`,
    '',
    'Usage: cortex-worker <command> [options]',
    '',
    'Commands:',
    '  start      run the worker for this repo (foreground; -d to run it in the background)',
    '  stop       stop the background worker (waits up to 90 s for a task to wrap up)',
    '  status     show whether the worker runs, its task and its last registration',
    '  logs       print the last 200 log lines (-f to follow)',
    '  update     replace this cortex-worker.mjs with the hub\'s version',
    '  hub-url    print the hub URL the worker would use',
    '  doctor     check the setup (--probe also runs each engine)',
    '  version    print the worker version',
    '  help       show this help',
    '',
    'Options:',
    '  -d, --daemon              start in the background; output goes to the log',
    '  -f, --follow              logs: keep printing new lines',
    '  --agent-id <id>           worker identity (default: CORTEX_AGENT_ID, else <host>-<repo folder>)',
    '  --repo <path>             the repo to work in (default: the current directory)',
    `  --engines <list>          engines to look for, in order (default: ${DEFAULT_ENGINES.join(',')})`,
    '  --capabilities <list>     capability tags the hub can match tasks on',
    '  --hub <url>               hub URL (default: CORTEX_HUB_URL, else the cortex-hub MCP config)',
    '  --api-key <key>           hub api key (default: CORTEX_API_KEY, else the cortex-hub MCP config)',
    `  --engine-timeout <min>    minutes an engine may run per task (default: ${DEFAULT_ENGINE_TIMEOUT_MIN})`,
    '  --probe                   doctor: also run a tiny prompt through each engine',
  ].join('\n');
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** True when this module is the process entry script (follows symlinks; win32 paths compare case-insensitively). */
export function isEntrypoint(
  metaUrl: string,
  argv1: string | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!argv1) return false;
  try {
    const self = canonical(fileURLToPath(metaUrl));
    const entry = canonical(argv1);
    return platform === 'win32' ? self.toLowerCase() === entry.toLowerCase() : self === entry;
  } catch {
    return false;
  }
}

/** `env` without any entry whose value contains `secret`, whatever the variable is called. */
export function envWithoutSecret(env: NodeJS.ProcessEnv, secret: string): NodeJS.ProcessEnv {
  if (secret === '') return { ...env };
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || !v.includes(secret)) out[k] = v;
  }
  return out;
}

/** `--agent-id`, then `CORTEX_AGENT_ID`, then `<host>-<repo folder>`. */
export function resolveAgentId(args: CliArgs, env: NodeJS.ProcessEnv, hostname: string, cwd: string): string {
  if (args.agentId) return args.agentId;
  const fromEnv = env['CORTEX_AGENT_ID'];
  if (fromEnv) return fromEnv;
  return defaultAgentId(hostname, path.resolve(cwd, args.repo ?? '.'));
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fatalHint(reason: FatalReason, keySource: string): string {
  switch (reason) {
    case 'missing-key':
    case 'bad-key':
      return `check the key (it came from ${keySource})`;
    case 'agent-in-use':
      return 'another worker is connected with this agent id; pass --agent-id <id> to run a second one';
    case 'replaced':
      return 'another instance on this host took over this agent id';
  }
}

/**
 * Writes our pid into the pid file. Returns the pid of a live worker that holds it
 * instead, or null once it is ours. A stale file (dead pid, or garbage) is replaced.
 */
function claimPidFile(paths: WorkerPaths): number | null {
  mkdirSync(paths.home, { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    const pid = readPid(paths);
    if (pid !== null && pid !== process.pid && isAlive(pid)) return pid;
    rmSync(paths.pidFile, { force: true });
    try {
      writeFileSync(paths.pidFile, `${process.pid}\n`, { flag: 'wx' });
      return null;
    } catch (err) {
      // another start wrote it between our check and our write: look again
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`could not claim ${paths.pidFile}`);
}

/** Something to receive SIGINT and SIGTERM from; `process` in production. */
export interface SignalSource {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface StartOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  cwd?: string;
  hostname?: string;
  signals?: SignalSource;
  /** Called with 130 on a second signal; `process.exit` in production. */
  exit?: (code: number) => void;
  stopPollMs?: number;
  createAdapters?: (names: Executor[], env: NodeJS.ProcessEnv) => EngineAdapter[];
}

/**
 * Runs the worker until the stop file appears, a signal arrives (0) or the hub refuses
 * it for good (2). Returns 1 when it cannot start.
 */
export async function startForeground(args: CliArgs, opts: StartOptions = {}): Promise<number> {
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? os.homedir();
  const cwd = opts.cwd ?? process.cwd();
  const hostname = opts.hostname ?? os.hostname();
  const signals: SignalSource = opts.signals ?? process;
  const exit = opts.exit ?? ((code: number) => process.exit(code));

  const repo = path.resolve(cwd, args.repo ?? '.');
  let remote: string | null = null;
  try {
    remote = await originUrl(repo);
  } catch {
    remote = null;
  }
  if (remote === null) {
    console.error(`${repo} has no git remote "origin": run the worker inside a clone of the project, or pass --repo <path>`);
    return 1;
  }
  const agentId = resolveAgentId(args, env, hostname, cwd);
  const hub = detectHubConfig({ flags: { hub: args.hub, apiKey: args.apiKey }, env, homeDir, repoPath: repo });
  if ('error' in hub) {
    console.error(hub.error);
    return 1;
  }

  const paths = workerPaths(agentId, homeDir);
  const holder = claimPidFile(paths);
  if (holder !== null) {
    console.error(`already running (pid ${holder})`);
    return 1;
  }
  const release = (): void => {
    try {
      if (readPid(paths) === process.pid) rmSync(paths.pidFile, { force: true });
    } catch {
      // best effort
    }
  };

  let logger: Logger;
  try {
    // a stop file left by an earlier run must not stop this one
    rmSync(paths.stopFile, { force: true });
    logger = createLogger({ file: paths.logFile, stdout: env['CORTEX_WORKER_DAEMON'] !== '1' });
    logger.addSecret(hub.apiKey);
  } catch (err) {
    release();
    throw err;
  }
  logger.info(
    `cortex-worker ${WORKER_VERSION} starting as ${agentId} (pid ${process.pid}) in ${repo}; ` +
      `hub ${hub.hubBase} (from ${hub.source.hub}), key from ${hub.source.key}`,
  );

  // engines, their setup and test commands never see the key
  const childEnv = envWithoutSecret(env, hub.apiKey);
  const names = args.engines ?? [...DEFAULT_ENGINES];
  let described: Awaited<ReturnType<typeof describeEngines>>;
  try {
    described = await describeEngines((opts.createAdapters ?? createAdapters)(names, childEnv));
  } catch (err) {
    logger.error(`looking for engines failed: ${messageOf(err)}`);
    release();
    return 1;
  }
  if (described.available.length === 0) {
    logger.error(`no engine found (looked for ${names.join(', ')}). Install one and log in to it once:`);
    for (const n of names) logger.error(`  ${n}: ${INSTALL_HINTS[n]}`);
    release();
    return 1;
  }
  logger.info(`engines: ${described.engines.map((e) => e.executor).join(', ')}`);

  let finishing = false;
  let resolveDone: (code: number) => void = () => undefined;
  const done = new Promise<number>((r) => {
    resolveDone = r;
  });

  let client: HubClient;
  const worker = new Worker({
    agentId,
    hostname,
    repo,
    remote,
    capabilities: args.capabilities ?? [],
    adapters: described.available,
    engines: described.engines,
    defaultExecutor: described.defaultExecutor,
    paths,
    logger,
    send: (m) => client.send(m),
    sendReliable: (m) => client.sendReliable(m),
    gh: createGh(),
    env: childEnv,
    engineTimeoutMs: (args.engineTimeoutMin ?? DEFAULT_ENGINE_TIMEOUT_MIN) * 60_000,
    identity: WORKER_IDENTITY,
    isRegistered: () => client.registered,
  });

  const finish = async (code: number, why: string): Promise<void> => {
    if (finishing) return;
    finishing = true;
    clearInterval(stopPoll);
    logger.info(`stopping: ${why}`);
    try {
      await worker.stop();
    } catch (err) {
      logger.error(`stopping the task failed: ${messageOf(err)}`);
    }
    try {
      await client.stop();
    } catch (err) {
      logger.error(`closing the hub connection failed: ${messageOf(err)}`);
    }
    release();
    try {
      rmSync(paths.stopFile, { force: true });
    } catch {
      // best effort
    }
    signals.off('SIGINT', onSigint);
    signals.off('SIGTERM', onSigterm);
    logger.info(code === 0 ? 'stopped' : `stopped (exit ${code})`);
    resolveDone(code);
  };
  const onSignal = (name: string): void => {
    if (finishing) {
      // a second Ctrl-C: the user does not want to wait for the task to wrap up
      logger.warn(`${name} again: exiting now`);
      release();
      exit(130);
      return;
    }
    void finish(0, name);
  };
  const onSigint = (): void => onSignal('SIGINT');
  const onSigterm = (): void => onSignal('SIGTERM');
  const stopPoll = setInterval(() => {
    if (existsSync(paths.stopFile)) void finish(0, 'stop file');
  }, opts.stopPollMs ?? DEFAULT_STOP_POLL_MS);

  try {
    client = new HubClient({
      wsUrl: hub.wsUrl,
      apiKey: hub.apiKey,
      agentId,
      hostname,
      register: () => worker.registerPayload(),
      onRegistered: (m) => worker.onRegistered(m),
      onMessage: (m) => worker.handle(m),
      onFatal: (reason, detail) => {
        logger.error(`the hub refused this worker (${detail}): ${fatalHint(reason, hub.source.key)}`);
        void finish(2, `the hub refused this worker (${reason})`);
      },
      logger,
    });
  } catch (err) {
    clearInterval(stopPoll);
    logger.error(`cannot connect to ${hub.hubBase}: ${messageOf(err)}`);
    release();
    return 1;
  }
  signals.on('SIGINT', onSigint);
  signals.on('SIGTERM', onSigterm);
  client.start();
  return done;
}

export interface MainOptions extends StartOptions {
  fetch?: typeof fetch;
  /** The script `start -d` re-runs and `update` replaces; `process.argv[1]` by default. */
  scriptPath?: string;
}

export async function main(argv: string[], opts: MainOptions = {}): Promise<number> {
  const args = parseCli(argv);
  if ('error' in args) {
    console.error(args.error);
    console.error(helpText());
    return 2;
  }
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? os.homedir();
  const cwd = opts.cwd ?? process.cwd();
  const hostname = opts.hostname ?? os.hostname();
  const signals: SignalSource = opts.signals ?? process;
  const agentId = (): string => resolveAgentId(args, env, hostname, cwd);
  const hubBase = (): { hubBase: string } | { error: string } =>
    detectHubBase({ flags: { hub: args.hub }, env, homeDir, repoPath: path.resolve(cwd, args.repo ?? '.') });
  const script = opts.scriptPath ?? process.argv[1] ?? '';

  try {
    switch (args.command) {
      case 'help':
        console.log(helpText());
        return 0;
      case 'version':
        console.log(WORKER_VERSION);
        return 0;
      case 'doctor':
        console.error('doctor: not implemented yet');
        return 1;
      case 'hub-url': {
        const hub = hubBase();
        if ('error' in hub) {
          console.error(hub.error);
          return 1;
        }
        console.log(hub.hubBase);
        return 0;
      }
      case 'start': {
        if (!args.daemon) {
          const code = await startForeground(args, opts);
          // a stray handle must not keep a stopped worker alive
          const exit = opts.exit ?? ((c: number) => process.exit(c));
          setTimeout(() => exit(code), EXIT_SAFETY_MS).unref();
          return code;
        }
        if (script === '') {
          console.error('cannot tell which script to run in the background');
          return 1;
        }
        const paths = workerPaths(agentId(), homeDir);
        const r = await startDaemon(args, paths, script, argv.slice(1), { env });
        if ('error' in r) {
          console.error(r.error);
          return 1;
        }
        console.log(`cortex-worker started in the background (pid ${r.pid})`);
        console.log(`log: ${paths.logFile}`);
        return 0;
      }
      case 'stop': {
        const id = agentId();
        const paths = workerPaths(id, homeDir);
        const pid = readPid(paths);
        if (pid !== null && isAlive(pid)) {
          console.log(`stopping ${id} (pid ${pid}); a running task gets up to 90 s to push its work…`);
        }
        const r = await stopWorker(paths);
        console.log(
          r === 'not-running'
            ? `${id} is not running`
            : r === 'stopped'
              ? `${id} stopped`
              : `${id} did not stop in time and was killed`,
        );
        return 0;
      }
      case 'status': {
        const paths = workerPaths(agentId(), homeDir);
        console.log(statusText(paths, readState(paths.stateFile)));
        return 0;
      }
      case 'logs': {
        const paths = workerPaths(agentId(), homeDir);
        const ac = new AbortController();
        const abort = (): void => ac.abort();
        if (args.follow) {
          signals.on('SIGINT', abort);
          signals.on('SIGTERM', abort);
        }
        try {
          await printLogs(paths, { follow: args.follow, signal: ac.signal });
        } finally {
          signals.off('SIGINT', abort);
          signals.off('SIGTERM', abort);
        }
        return 0;
      }
      case 'update': {
        const hub = hubBase();
        if ('error' in hub) {
          console.error(hub.error);
          return 1;
        }
        if (script === '') {
          console.error('cannot tell which script to update');
          return 1;
        }
        const target = realpathSync(script);
        const r = await updateBundle(hub.hubBase, target, WORKER_VERSION, opts.fetch);
        console.log(
          r.updated
            ? `updated ${target} to v${r.version}; restart the worker to use v${r.version}`
            : `already v${r.version}`,
        );
        return 0;
      }
    }
  } catch (err) {
    console.error(`cortex-worker ${args.command}: ${messageOf(err)}`);
    return 1;
  }
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
