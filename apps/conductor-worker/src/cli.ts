import { existsSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path, { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CONDUCTOR_PROTOCOL_VERSION, EXECUTORS } from '@cortex/shared-types';
import type { Executor } from '@cortex/shared-types';
import {
  formatAgentTable,
  listAgents,
  readStartConfig,
  rememberedEnv,
  resolveAgentRef,
  restartArgv,
  restartEnv,
  saveStartConfig,
} from './commands/agents.js';
import type { StartConfig } from './commands/agents.js';
import { defaultCheckDeps, runCheck, terminalAsk } from './commands/check.js';
import type { CheckDeps } from './commands/check.js';
import {
  DEFAULT_STOP_GRACE_MS,
  claimPidFile,
  isAlive,
  printLogs,
  readPid,
  startDaemon,
  statusText,
  stopWorker,
} from './commands/daemon.js';
import { runDoctor, formatChecks } from './commands/doctor.js';
import { printTranscript } from './commands/tail.js';
import type { DoctorContext } from './commands/doctor.js';
import { updateBundle } from './commands/update.js';
import { KEY_FROM_ENV, KEY_FROM_FLAG, detectHubBase, detectHubConfig } from './config.js';
import { createAdapters, describeEngines } from './engines/index.js';
import { installHint } from './engines/install.js';
import { defaultReadiness } from './env/readiness.js';
import type { EngineAdapter } from './engines/types.js';
import { createGh, originUrl } from './git.js';
import { HubClient } from './hub-client.js';
import type { FatalReason } from './hub-client.js';
import { createLogger, redact } from './logger.js';
import type { Logger } from './logger.js';
import { defaultAgentId, workerPaths } from './paths.js';
import type { WorkerPaths } from './paths.js';
import { readState } from './state.js';
import { WORKER_VERSION } from './version.js';
import { Worker } from './worker.js';

export interface CliArgs {
  command:
    | 'start'
    | 'stop'
    | 'restart'
    | 'status'
    | 'ls'
    | 'logs'
    | 'tail'
    | 'doctor'
    | 'check'
    | 'update'
    | 'hub-url'
    | 'version'
    | 'help';
  daemon: boolean;
  follow: boolean;
  probe: boolean;
  /** stop and restart: every agent on this machine. */
  all: boolean;
  /** check: install what is missing without asking. */
  yes?: boolean;
  /** check: skip the trial run when it passed before and nothing it rests on has changed. */
  ifChanged?: boolean;
  /** The agent named on the command line: a name or its number in `cw ls` (not for start). */
  agent?: string;
  agentId?: string;
  repo?: string;
  /** Always set, except for check without --engines: it then takes the agent's own. */
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

const RUN_COMMANDS = ['start', 'stop', 'restart', 'status', 'ls', 'logs', 'tail', 'doctor', 'check', 'update', 'hub-url'] as const;
/** The commands that take an agent after them. */
const AGENT_COMMANDS: ReadonlySet<string> = new Set(['start', 'stop', 'restart', 'status', 'logs', 'tail', 'doctor', 'check']);
type RunCommand = (typeof RUN_COMMANDS)[number];
const isRunCommand = (s: string): s is RunCommand => (RUN_COMMANDS as readonly string[]).includes(s);
const isExecutor = (s: string): s is Executor => (EXECUTORS as readonly string[]).includes(s);

/** A comma list, trimmed, without empty items or repeats. */
function commaList(raw: string): string[] {
  return [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => s !== ''))];
}

const bare = (command: CliArgs['command']): CliArgs => ({ command, daemon: false, follow: false, probe: false, all: false });

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
        all: { type: 'boolean' },
        yes: { type: 'boolean', short: 'y' },
        'if-changed': { type: 'boolean' },
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
  if (positionals.length > 1) return { error: `unexpected argument: ${positionals[1]}` };
  const ref = positionals[0];
  if (ref !== undefined) {
    if (!AGENT_COMMANDS.has(first)) return { error: `unexpected argument: ${ref}` };
    if (values['agent-id'] !== undefined) return { error: 'give the agent once: as a name or with --agent-id' };
    if (first === 'start' && /^\d+$/.test(ref)) {
      return { error: `start takes a name, not a number; to start agent ${ref} of cw ls again: cw restart ${ref}` };
    }
  }
  if (values.all === true) {
    if (first !== 'stop' && first !== 'restart') return { error: '--all works with stop and restart' };
    if (ref !== undefined || values['agent-id'] !== undefined) return { error: '--all or an agent, not both' };
  }
  if (first !== 'check') {
    if (values.yes === true) return { error: '--yes works with check' };
    if (values['if-changed'] === true) return { error: '--if-changed works with check' };
  }

  let engines: Executor[] | undefined = first === 'check' ? undefined : [...DEFAULT_ENGINES];
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
    all: values.all ?? false,
    capabilities: values.capabilities === undefined ? [] : commaList(values.capabilities),
    engineTimeoutMin,
  };
  if (engines !== undefined) args.engines = engines;
  if (values.yes === true) args.yes = true;
  if (values['if-changed'] === true) args.ifChanged = true;
  if (values['agent-id'] !== undefined) args.agentId = values['agent-id'];
  if (ref !== undefined) {
    if (first === 'start') args.agentId = ref;
    else args.agent = ref;
  }
  if (values.repo !== undefined) args.repo = values.repo;
  if (values.hub !== undefined) args.hub = values.hub;
  if (values['api-key'] !== undefined) args.apiKey = values['api-key'];
  return args;
}

function helpText(): string {
  return [
    `cortex-worker ${WORKER_VERSION} (protocol ${CONDUCTOR_PROTOCOL_VERSION})`,
    '',
    'Usage: cw <command> [agent] [options]    (cw is the shortcut for cortex-worker)',
    '  [agent] is an agent name, or its number in `cw ls`',
    '',
    'Commands:',
    '  ls         list the agents on this machine, numbered',
    '  start      run the worker for this repo (foreground; -d to run it in the background)',
    `  stop       stop a background worker (waits up to ${DEFAULT_STOP_GRACE_MS / 1000} s for a task to wrap up)`,
    '  restart    stop it, then start it in the background with the settings it last started with',
    '  status     show whether it runs, its task and its last registration (no agent: list them)',
    '  logs       print its last 200 log lines (-f to follow)',
    '  tail       print the end of what the engine printed on its latest task (-f to follow)',
    '  update     replace this cortex-worker.mjs with the hub\'s version',
    '  hub-url    print the hub URL the worker would use',
    '  doctor     check the setup (--probe also runs each engine)',
    '  check      list what this machine lacks for the repo\'s tasks, offer to install it,',
    '             then run the setup and test commands once in a temporary worktree',
    '  version    print the worker version',
    '  help       show this help',
    '',
    'Options:',
    '  -d, --daemon              start in the background; output goes to the log',
    '  -f, --follow              logs, tail: keep printing new lines',
    '  --all                     stop, restart: every agent on this machine',
    '  --agent-id <id>           worker identity (default: CORTEX_AGENT_ID, else <host>-<repo folder>)',
    '  --repo <path>             the repo to work in (default: the current directory)',
    `  --engines <list>          engines to look for, in order (default: ${DEFAULT_ENGINES.join(',')})`,
    '  --capabilities <list>     capability tags the hub can match tasks on',
    '  --hub <url>               hub URL (default: CORTEX_HUB_URL, else the cortex-hub MCP config)',
    '  --api-key <key>           hub api key (default: CORTEX_API_KEY, else the cortex-hub MCP config)',
    `  --engine-timeout <min>    minutes an engine may run per task (default: ${DEFAULT_ENGINE_TIMEOUT_MIN})`,
    '  --probe                   doctor: also run a tiny prompt through each engine',
    '  -y, --yes                 check: install what is missing without asking',
    '  --if-changed              check: skip the trial run if it passed before and nothing it rests on changed',
    '',
    'Examples:',
    '  cw ls                     the agents, numbered',
    '  cw check                  can this machine do the tasks of the repo here?',
    '  cw check 2 --yes          the same for agent 2, installing what is missing without asking',
    '  cw logs 2 -f              follow the log of agent 2 (Ctrl+C to quit)',
    '  cw tail 2 -f              watch what the engine of agent 2 is doing on its task',
    '  cw restart --all          restart every agent, e.g. after cw update',
  ].join('\n');
}

/** Printed under the agent list. */
const AGENT_HINT = [
  '',
  'cw status <#|name>     details of one agent',
  'cw logs <#|name> -f    follow its log (Ctrl+C to quit)',
  'cw tail <#|name> -f    follow what its engine prints on the current task',
  'cw restart <#|name>    restart it with the settings it last started with (--all: every agent)',
  'cw stop <#|name>       stop it (--all: every agent)',
].join('\n');

function agentList(homeDir: string): string {
  const agents = listAgents(homeDir);
  return agents.length === 0 ? formatAgentTable(agents) : `${formatAgentTable(agents)}\n${AGENT_HINT}`;
}

function stopLine(id: string, r: Awaited<ReturnType<typeof stopWorker>>): string {
  return r === 'not-running' ? `${id} is not running` : r === 'stopped' ? `${id} stopped` : `${id} did not stop in time and was killed`;
}

const graceNote = `a running task gets up to ${DEFAULT_STOP_GRACE_MS / 1000} s to push its work…`;

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

/**
 * Deletes from `env`, in place, every entry whose value is exactly `secret`, whatever the
 * variable is called. Exact, not a substring: a short key would otherwise take PATH with it.
 */
export function scrubSecret(env: NodeJS.ProcessEnv, secret: string): void {
  if (secret === '') return;
  for (const [k, v] of Object.entries(env)) {
    if (v === secret) delete env[k];
  }
}

/** A copy of `env` without any entry whose value is exactly `secret`. */
export function envWithoutSecret(env: NodeJS.ProcessEnv, secret: string): NodeJS.ProcessEnv {
  const out = { ...env };
  scrubSecret(out, secret);
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
  /** Called with 130 on the second signal; `process.exit` in production. */
  exit?: (code: number) => void;
  stopPollMs?: number;
  createAdapters?: (names: Executor[], env: NodeJS.ProcessEnv) => EngineAdapter[];
}

/**
 * Runs the worker until the stop file appears, a signal arrives (0) or the hub refuses
 * it for good (2). Returns 1 when it cannot start. A second signal calls `exit(130)` at once.
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
  // git, gh and repo hooks inherit process.env (git.ts), so the key leaves it, whatever the
  // variable; engines and their setup/test commands get the same scrubbed env
  scrubSecret(process.env, hub.apiKey);
  const childEnv = envWithoutSecret(env, hub.apiKey);

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
    for (const n of names) logger.error(`  ${n}: ${installHint(n, process.platform)}`);
    release();
    return 1;
  }
  logger.info(`engines: ${described.engines.map((e) => e.executor).join(', ')}`);
  const skipReadiness = env['CORTEX_SKIP_READINESS'] === '1';
  if (skipReadiness) logger.warn('CORTEX_SKIP_READINESS=1: taking tasks without checking that this machine has what they need');

  const saved: StartConfig = {
    agentId,
    repo,
    hub: hub.hubBase,
    engines: names,
    capabilities: args.capabilities ?? [],
    engineTimeoutMin: args.engineTimeoutMin ?? DEFAULT_ENGINE_TIMEOUT_MIN,
    env: rememberedEnv(childEnv),
  };
  // a key from an MCP config is read there again on restart; only one given to the worker is kept
  if (hub.source.key === KEY_FROM_FLAG || hub.source.key === KEY_FROM_ENV) saved.apiKey = hub.apiKey;
  try {
    saveStartConfig(paths.startFile, saved);
  } catch (err) {
    logger.warn(`could not save the start settings, so cw restart cannot restart this agent: ${messageOf(err)}`);
  }

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
    // what `cw check` would mark ✗ declines each task as busy until it is fixed
    ...(skipReadiness ? {} : { readiness: defaultReadiness(repo, process.platform, childEnv) }),
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
  let signalCount = 0;
  const onSignal = (name: string): void => {
    signalCount++;
    if (signalCount >= 2) {
      // a second Ctrl-C: the user does not want to wait for the task to wrap up
      logger.warn(`${name} again: exiting now`);
      release();
      exit(130);
      return;
    }
    if (finishing) {
      // the stop file or the hub started the shutdown: this signal joins it
      logger.info(`${name}: already stopping; send it again to exit at once`);
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
  /** Replaces parts of the doctor context (tests inject fetch, gh, engines and the socket). */
  doctor?: Partial<DoctorContext>;
  /** Replaces parts of what check probes and runs with. */
  check?: Partial<CheckDeps>;
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
  /** The agent the command line names (a name or its `cw ls` number), else --agent-id, else CORTEX_AGENT_ID. */
  const namedAgent = (): string | { error: string } | null => {
    if (args.agent !== undefined) return resolveAgentRef(args.agent, listAgents(homeDir));
    return args.agentId ?? (env['CORTEX_AGENT_ID'] || null);
  };
  /**
   * The agent for stop, logs, tail and restart: the named one, else this repo's own when it has
   * one (or when there are no agents), else the only agent. With several, it asks which.
   */
  const pickAgent = (verb: string): string | { error: string } => {
    const named = namedAgent();
    if (named !== null) return named;
    const own = resolveAgentId(args, env, hostname, cwd);
    const agents = listAgents(homeDir);
    if (agents.length === 0 || agents.some((a) => a.id === own)) return own;
    const only = agents.length === 1 ? agents[0] : undefined;
    if (only !== undefined) return only.id;
    return { error: `${formatAgentTable(agents)}\n\nwhich agent? cw ${verb} <#|name>` };
  };
  const hubBase = (): { hubBase: string } | { error: string } =>
    detectHubBase({ flags: { hub: args.hub }, env, homeDir, repoPath: path.resolve(cwd, args.repo ?? '.') });
  const script = opts.scriptPath ?? process.argv[1] ?? '';

  /** Stops the agents, then starts each in the background with its saved settings. */
  const restart = async (): Promise<number> => {
    if (script === '') {
      console.error('cannot tell which script to run in the background');
      return 1;
    }
    const targets: Array<{ id: string; paths: WorkerPaths; config: StartConfig }> = [];
    if (args.all) {
      for (const a of listAgents(homeDir)) {
        if (a.config !== null) targets.push({ id: a.id, paths: a.paths, config: a.config });
        else console.log(`skipping ${a.id}: no saved start settings yet (start it once with: cw start ${a.id} -d)`);
      }
      if (targets.length === 0) {
        console.error('nothing to restart: no agent has saved start settings yet');
        return 1;
      }
    } else {
      const id = pickAgent('restart');
      if (typeof id !== 'string') {
        console.error(id.error);
        return 1;
      }
      const paths = workerPaths(id, homeDir);
      const config = readStartConfig(paths.startFile);
      if (config === null) {
        console.error(
          `${id} has no saved start settings yet: start it once with cw start ${id} -d --repo <path> ` +
            '(a worker of this version remembers them from then on)',
        );
        return 1;
      }
      targets.push({ id, paths, config });
    }

    const live = targets.filter((t) => {
      const pid = readPid(t.paths);
      return pid !== null && isAlive(pid);
    });
    if (live.length > 0) console.log(`stopping ${live.map((t) => t.id).join(', ')}; ${graceNote}`);
    await Promise.all(targets.map((t) => stopWorker(t.paths)));

    let failed = false;
    for (const t of targets) {
      const argv2 = restartArgv(t.config);
      const startArgs = parseCli(['start', ...argv2]);
      const r =
        'error' in startArgs
          ? startArgs
          : await startDaemon(startArgs, t.paths, script, argv2, { env: restartEnv(env, t.config) });
      if ('error' in r) {
        console.error(`${t.id}: ${r.error}`);
        failed = true;
      } else {
        console.log(`${t.id} started in the background (pid ${r.pid})`);
      }
    }
    return failed ? 1 : 0;
  };

  try {
    switch (args.command) {
      case 'help':
        console.log(helpText());
        return 0;
      case 'version':
        console.log(WORKER_VERSION);
        return 0;
      case 'doctor': {
        const named = namedAgent();
        if (named !== null && typeof named !== 'string') {
          console.error(named.error);
          return 1;
        }
        const doctorAgent = named ?? agentId();
        const repo = path.resolve(cwd, args.repo ?? '.');
        const checks = await runDoctor({
          nodeVersion: process.version,
          repo,
          homeDir,
          env,
          flags: { hub: args.hub, apiKey: args.apiKey, agentId: doctorAgent },
          engines: args.engines ?? [...DEFAULT_ENGINES],
          probe: args.probe,
          ...opts.doctor,
        });
        const hub = detectHubConfig({ flags: { hub: args.hub, apiKey: args.apiKey }, env, homeDir, repoPath: repo });
        const secrets = 'error' in hub ? [] : [hub.apiKey];
        if (args.apiKey !== undefined) secrets.push(args.apiKey);
        console.log(redact(formatChecks(checks), secrets));
        return checks.some((c) => c.required && !c.ok) ? 1 : 0;
      }
      case 'check': {
        const named = namedAgent();
        if (named !== null && typeof named !== 'string') {
          console.error(named.error);
          return 1;
        }
        // the agent's own repo, engines and setup/test commands, unless the command line says otherwise
        const cfg = readStartConfig(workerPaths(named ?? agentId(), homeDir).startFile);
        const repo = path.resolve(cwd, args.repo ?? cfg?.repo ?? '.');
        const baseEnv = cfg === null ? { ...env } : restartEnv(env, cfg);
        const hub = detectHubConfig({ flags: { hub: args.hub ?? cfg?.hub, apiKey: args.apiKey }, env: baseEnv, homeDir, repoPath: repo });
        // the project's own commands run here, as in a task: the hub key stays out of their reach
        const checkEnv = { ...baseEnv };
        for (const key of ['error' in hub ? '' : hub.apiKey, args.apiKey ?? '']) {
          scrubSecret(checkEnv, key);
          scrubSecret(process.env, key);
        }
        delete checkEnv['CORTEX_API_KEY'];
        const ac = new AbortController();
        const abort = (): void => ac.abort();
        signals.on('SIGINT', abort);
        signals.on('SIGTERM', abort);
        try {
          const deps = defaultCheckDeps({
            platform: process.platform,
            env: checkEnv,
            signal: ac.signal,
            ask: terminalAsk(ac),
            out: (line) => console.log(line),
          });
          return await runCheck(
            { repo, engines: args.engines ?? cfg?.engines ?? [...DEFAULT_ENGINES], homeDir, yes: args.yes === true, ifChanged: args.ifChanged === true },
            { ...deps, ...opts.check },
          );
        } finally {
          signals.off('SIGINT', abort);
          signals.off('SIGTERM', abort);
        }
      }
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
        console.log(`see it: cw status ${path.basename(paths.home)}    follow its log: cw logs ${path.basename(paths.home)} -f`);
        return 0;
      }
      case 'ls':
        console.log(agentList(homeDir));
        return 0;
      case 'stop': {
        if (args.all) {
          const live = listAgents(homeDir).filter((a) => a.pid !== null);
          if (live.length === 0) {
            console.log('no agent is running');
            return 0;
          }
          console.log(`stopping ${live.map((a) => a.id).join(', ')}; ${graceNote}`);
          const results = await Promise.all(live.map((a) => stopWorker(a.paths)));
          live.forEach((a, i) => console.log(stopLine(a.id, results[i] ?? 'not-running')));
          return 0;
        }
        const id = pickAgent('stop');
        if (typeof id !== 'string') {
          console.error(id.error);
          return 1;
        }
        const paths = workerPaths(id, homeDir);
        const pid = readPid(paths);
        if (pid !== null && isAlive(pid)) console.log(`stopping ${id} (pid ${pid}); ${graceNote}`);
        console.log(stopLine(id, await stopWorker(paths)));
        return 0;
      }
      case 'restart':
        return await restart();
      case 'status': {
        const named = namedAgent();
        if (named === null) {
          console.log(agentList(homeDir));
          return 0;
        }
        if (typeof named !== 'string') {
          console.error(named.error);
          return 1;
        }
        const paths = workerPaths(named, homeDir);
        console.log(statusText(paths, readState(paths.stateFile)));
        return 0;
      }
      case 'logs': {
        const id = pickAgent('logs');
        if (typeof id !== 'string') {
          console.error(id.error);
          return 1;
        }
        const paths = workerPaths(id, homeDir);
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
      case 'tail': {
        const id = pickAgent('tail');
        if (typeof id !== 'string') {
          console.error(id.error);
          return 1;
        }
        const paths = workerPaths(id, homeDir);
        const ac = new AbortController();
        const abort = (): void => ac.abort();
        if (args.follow) {
          signals.on('SIGINT', abort);
          signals.on('SIGTERM', abort);
        }
        try {
          await printTranscript(paths, { follow: args.follow, signal: ac.signal });
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
