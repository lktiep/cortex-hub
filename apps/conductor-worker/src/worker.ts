import { CONDUCTOR_PROTOCOL_VERSION } from '@cortex/shared-types';
import type {
  AssignedTask,
  EngineInfo,
  Executor,
  RegisteredMsg,
  StatusUpdateMsg,
  TaskAssignedMsg,
  TaskRevokedMsg,
  WorkerRegisterMsg,
  WorkerToHubMsg,
} from '@cortex/shared-types';
import type { EngineAdapter } from './engines/types.js';
import { branchCheckedOutAt, sanitizeRemoteUrl } from './git.js';
import type { GhRun } from './git.js';
import type { HubClient } from './hub-client.js';
import type { Logger } from './logger.js';
import { worktreePath } from './paths.js';
import type { WorkerPaths } from './paths.js';
import { runTask } from './runner.js';
import type { AbortReason, RunOutcome, RunnerDeps } from './runner.js';
import { readState, writeState } from './state.js';
import type { WorkerState } from './state.js';
import { WORKER_VERSION } from './version.js';

export interface WorkerDeps {
  agentId: string;
  hostname: string;
  repo: string;
  remote: string;
  capabilities: string[];
  /** The engines found on this machine. */
  adapters: EngineAdapter[];
  engines: EngineInfo[];
  defaultExecutor: Executor | null;
  paths: WorkerPaths;
  logger: Logger;
  send: (m: WorkerToHubMsg) => boolean;
  sendReliable: HubClient['sendReliable'];
  gh: GhRun;
  env: NodeJS.ProcessEnv;
  engineTimeoutMs: number;
  identity: { name: string; email: string };
  isRegistered: () => boolean;
  /** Injectable for tests. */
  run?: typeof runTask;
}

/** The task this worker holds: being checked before `task.accept`, or running. */
interface Slot {
  task: AssignedTask;
  controller: AbortController;
  /** Settles once the slot is released and the outcome sent. */
  done: Promise<void>;
}

const IDLE: StatusUpdateMsg = { type: 'status.update', state: 'idle' };
const BUSY: StatusUpdateMsg = { type: 'status.update', state: 'busy' };

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function abortReason(signal: AbortSignal): AbortReason {
  return signal.reason === 'revoked' ? 'revoked' : 'stopping';
}

/**
 * Holds at most one task. An outcome is written to the state file as unconfirmed
 * before it is sent, so a restart can report it again (`task.resumed`) until the
 * hub moves on (a new task or `task.revoked`).
 */
export class Worker {
  private readonly deps: WorkerDeps;
  private readonly run: typeof runTask;
  private state: WorkerState;
  private current: Slot | null = null;
  private stopping = false;
  /** The hub version last warned about, so a reconnect does not repeat it. */
  private warnedHubVersion: string | null = null;
  private warnedNoProject = false;

  constructor(deps: WorkerDeps) {
    this.deps = deps;
    this.run = deps.run ?? runTask;
    this.state = readState(deps.paths.stateFile);
    // a group an earlier process recorded is not this one's to kill: its id may be reused by now
    if (this.state.engineGroup !== null) this.update({ engineGroup: null });
  }

  get busy(): boolean {
    return this.current !== null;
  }

  registerPayload(): WorkerRegisterMsg {
    const activeTaskId = this.current?.task.id ?? this.state.unconfirmed?.taskId ?? this.state.activeTaskId;
    return {
      type: 'worker.register',
      protocol: CONDUCTOR_PROTOCOL_VERSION,
      version: WORKER_VERSION,
      hostname: this.deps.hostname,
      os: process.platform,
      repo: sanitizeRemoteUrl(this.deps.remote),
      capabilities: this.deps.capabilities,
      engines: this.deps.engines,
      defaultExecutor: this.deps.defaultExecutor,
      ...(activeTaskId !== null ? { activeTaskId } : {}),
    };
  }

  onRegistered(m: RegisteredMsg): void {
    const { logger } = this.deps;
    this.update({ lastRegistered: { projectId: m.projectId, hubVersion: m.hubVersion, at: new Date().toISOString() } });
    if (m.hubVersion !== WORKER_VERSION && m.hubVersion !== this.warnedHubVersion) {
      this.warnedHubVersion = m.hubVersion;
      logger.warn(`hub is v${m.hubVersion}, worker is v${WORKER_VERSION} — run \`cortex-worker update\``);
    }
    if (m.projectId === null && !this.warnedNoProject) logger.warn("this repo's origin maps to no hub project");
    this.warnedNoProject = m.projectId === null;
  }

  /** Never throws: the hub client's event loop must survive any message. */
  handle(m: TaskAssignedMsg | TaskRevokedMsg): void {
    try {
      if (m.type === 'task.revoked') {
        this.onRevoked(m.taskId);
      } else if (!this.deps.isRegistered()) {
        this.deps.logger.warn(`task ${m.task.id}: ignored ${m.type} that arrived before the hub registered this worker`);
      } else if (m.type === 'task.resumed') {
        this.onResumed(m.task);
      } else {
        this.onAssigned(m.task, false);
      }
    } catch (err) {
      this.deps.logger.error(`handling ${String(m.type)} failed: ${messageOf(err)}`);
    }
  }

  /** Stops the running task without reporting it; its id stays in the state file for the next start. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.current?.controller.abort('stopping' satisfies AbortReason);
    await this.idle();
  }

  /** Resolves when no task is held. */
  async idle(): Promise<void> {
    while (this.current !== null) await this.current.done;
  }

  private log(taskId: string, m: string): void {
    this.deps.logger.info(`task ${taskId}: ${m}`);
  }

  private onResumed(task: AssignedTask): void {
    if (this.current?.task.id === task.id) {
      // the task held here: onAssigned tells a duplicate from a new attempt
      this.onAssigned(task, true);
      return;
    }
    const unconfirmed = this.state.unconfirmed;
    if (unconfirmed !== null && unconfirmed.taskId === task.id) {
      if (unconfirmed.msg.attempt === task.attempt) {
        this.log(task.id, `the hub has no outcome for attempt ${task.attempt}; sending it again`);
        this.deps.sendReliable(unconfirmed.msg);
        return;
      }
      this.log(
        task.id,
        `the stored outcome is for attempt ${String(unconfirmed.msg.attempt)}, the hub resumed attempt ${task.attempt}; running it`,
      );
      this.update({ unconfirmed: null });
    }
    this.onAssigned(task, true);
  }

  private onAssigned(task: AssignedTask, resumed: boolean): void {
    // read here, so a message without a task throws inside handle() rather than in the run
    const { id, attempt } = task;
    const current = this.current;
    // a duplicate is the same attempt; a new attempt of the held task waits like any other task
    if (current !== null && current.task.id === id && current.task.attempt === attempt) {
      this.log(id, `already running attempt ${attempt}; ignored ${resumed ? 'task.resumed' : 'task.assigned'}`);
      return;
    }
    if (current !== null || this.stopping) {
      const holding =
        current === null
          ? 'stopping'
          : current.task.id === id
            ? `still holding attempt ${current.task.attempt}`
            : `holding ${current.task.id}`;
      this.log(id, `attempt ${attempt} declined as busy (${holding})`);
      this.decline(task, 'busy');
      return;
    }
    const slot: Slot = { task, controller: new AbortController(), done: Promise.resolve() };
    this.current = slot;
    // released here whatever execute does; it also releases before sending the outcome
    slot.done = this.execute(slot, resumed)
      .catch((err: unknown) => {
        this.deps.logger.error(`task ${id}: ${messageOf(err)}`);
      })
      .finally(() => {
        this.release(slot);
      });
  }

  private onRevoked(taskId: string): void {
    // the reason is text for people; it is logged by the hub and never parsed here
    if (this.current?.task.id === taskId) {
      this.log(taskId, 'revoked by the hub; stopping it');
      this.current.controller.abort('revoked' satisfies AbortReason);
      return;
    }
    if (this.forget(taskId)) this.log(taskId, 'revoked by the hub; forgotten');
    else this.log(taskId, 'ignored task.revoked for a task this worker does not hold');
  }

  /** The adapter to run the task with, or why this worker cannot take it. A throw is a reason too. */
  private async check(task: AssignedTask): Promise<{ adapter: EngineAdapter } | { refusal: string }> {
    const host = this.deps.hostname;
    try {
      const executor = task.route.executor ?? this.deps.defaultExecutor;
      const adapter = executor === null ? undefined : this.deps.adapters.find((a) => a.executor === executor);
      if (adapter === undefined) {
        // only a route that names an engine is refused for that engine; otherwise the host has none to offer
        const named = task.route.executor;
        return { refusal: named !== null ? `executor ${named} not available on ${host}` : `no engine available on ${host}` };
      }
      // declined before accepting: spec §6.5 does not say a decline after task.accept is valid
      const own = worktreePath(this.deps.paths, task.id);
      const elsewhere = await branchCheckedOutAt(this.deps.repo, task.branch, own);
      if (elsewhere !== null) return { refusal: `branch-in-use: ${elsewhere}` };
      return { adapter };
    } catch (err) {
      return { refusal: messageOf(err) };
    }
  }

  private async execute(slot: Slot, resumed: boolean): Promise<void> {
    const { task } = slot;
    const { signal } = slot.controller;
    const checked = await this.check(task);
    if (signal.aborted) {
      this.release(slot);
      const reason = abortReason(signal);
      this.log(task.id, `${reason} before it was accepted; not started`);
      if (reason === 'revoked') {
        this.forget(task.id);
        // the hub may still count the offered task against this worker until it hears idle
        this.deps.send(IDLE);
      }
      // 'stopping' sends nothing: the next start registers with whatever the state file holds
      return;
    }
    if ('refusal' in checked) {
      this.release(slot);
      this.log(task.id, `declined: ${checked.refusal}`);
      this.decline(task, checked.refusal);
      return;
    }

    // persisted before task.accept, so a restart after the hub saw it registers with this task;
    // the hub has moved on from any outcome it had not confirmed
    this.update({ activeTaskId: task.id, unconfirmed: null });
    this.deps.sendReliable({ type: 'task.accept', taskId: task.id });
    this.deps.send(BUSY);
    this.log(task.id, `accepted attempt ${task.attempt} on ${checked.adapter.executor}${resumed ? ' (resumed)' : ''}`);

    let outcome: RunOutcome;
    try {
      outcome = await this.run(task, this.runnerDeps(checked.adapter), signal, { resumed });
    } catch (err) {
      const error = `the runner threw: ${messageOf(err)}`;
      this.deps.logger.error(`task ${task.id}: ${error}`);
      outcome = signal.aborted
        ? { kind: 'aborted', reason: abortReason(signal) }
        : {
            kind: 'failed',
            msg: {
              type: 'task.complete',
              taskId: task.id,
              status: 'failed',
              result: { summary: error, error },
              attempt: task.attempt,
            },
          };
    }
    this.release(slot);
    this.settle(task, outcome);
  }

  private settle(task: AssignedTask, outcome: RunOutcome): void {
    switch (outcome.kind) {
      case 'completed':
      case 'failed':
      case 'quota':
        // persisted first: a crash after this point still reports the outcome on restart
        this.update({ activeTaskId: null, unconfirmed: { taskId: task.id, msg: outcome.msg } });
        this.deps.sendReliable(outcome.msg);
        this.deps.send(IDLE);
        return;
      case 'declined':
        this.decline(task, outcome.reason);
        this.update({ activeTaskId: null });
        this.deps.send(IDLE);
        return;
      case 'aborted':
        if (outcome.reason === 'revoked') {
          this.update({ activeTaskId: null });
          this.deps.send(IDLE);
        }
        // 'stopping' keeps activeTaskId: the next start registers with it and is resumed or revoked
        return;
    }
  }

  private runnerDeps(adapter: EngineAdapter): RunnerDeps {
    const { repo, remote, paths, gh, logger, env, engineTimeoutMs, identity } = this.deps;
    return {
      repo,
      remote,
      paths,
      adapter,
      send: (m) => {
        this.deps.send(m);
      },
      gh,
      logger,
      env,
      engineTimeoutMs,
      identity,
      // recorded so `stop` can kill the engine if this process does not stop in time
      onEngineGroup: (engineGroup) => {
        this.update({ engineGroup });
      },
    };
  }

  private decline(task: AssignedTask, reason: string): void {
    this.deps.sendReliable({ type: 'task.decline', taskId: task.id, reason, attempt: task.attempt });
  }

  private release(slot: Slot): void {
    if (this.current === slot) this.current = null;
  }

  /** Drops the task from the state file; false when the state did not hold it. */
  private forget(taskId: string): boolean {
    const patch: Partial<WorkerState> = {};
    if (this.state.unconfirmed?.taskId === taskId) patch.unconfirmed = null;
    if (this.state.activeTaskId === taskId) patch.activeTaskId = null;
    if (Object.keys(patch).length === 0) return false;
    this.update(patch);
    return true;
  }

  /** Updates the state in memory, then on disk; a failed write is logged, not thrown. */
  private update(patch: Partial<WorkerState>): void {
    this.state = { ...this.state, ...patch };
    try {
      writeState(this.deps.paths.stateFile, this.state);
    } catch (err) {
      this.deps.logger.error(`could not write the worker state to ${this.deps.paths.stateFile}: ${messageOf(err)}`);
    }
  }
}
