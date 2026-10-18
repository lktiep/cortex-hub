import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TaskCompleteMsg, TaskQuotaExhaustedMsg } from '@cortex/shared-types';

export interface WorkerState {
  activeTaskId: string | null;
  unconfirmed: { taskId: string; msg: TaskCompleteMsg | TaskQuotaExhaustedMsg } | null;
  lastRegistered: { projectId: string | null; hubVersion: string; at: string } | null;
  /**
   * The process group of the engine running now (POSIX; the engine leads it), so `stop` can
   * kill it after the grace period: the worker's own tree kill does not reach it. Null when no
   * engine runs, and always on Windows, where the worker's tree kill covers the engine.
   */
  engineGroup: number | null;
  /** What this machine lacks for the project's tasks, as the last check found; null when ready or unchecked. */
  notReady: string[] | null;
}

const emptyState = (): WorkerState => ({
  activeTaskId: null,
  unconfirmed: null,
  lastRegistered: null,
  engineGroup: null,
  notReady: null,
});

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function readState(file: string): WorkerState {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isObj(raw)) return emptyState();
    const activeTaskId = typeof raw.activeTaskId === 'string' ? raw.activeTaskId : null;
    const um = raw.unconfirmed;
    const unconfirmed: WorkerState['unconfirmed'] =
      isObj(um) &&
      typeof um.taskId === 'string' &&
      isObj(um.msg) &&
      (um.msg.type === 'task.complete' || um.msg.type === 'task.quota_exhausted')
        ? { taskId: um.taskId, msg: um.msg as unknown as TaskCompleteMsg | TaskQuotaExhaustedMsg }
        : null;
    const lr = raw.lastRegistered;
    const lastRegistered: WorkerState['lastRegistered'] =
      isObj(lr) &&
      typeof lr.hubVersion === 'string' &&
      (typeof lr.projectId === 'string' || lr.projectId === null) &&
      typeof lr.at === 'string'
        ? { projectId: lr.projectId, hubVersion: lr.hubVersion, at: lr.at }
        : null;
    const eg = raw.engineGroup;
    const engineGroup = typeof eg === 'number' && Number.isInteger(eg) && eg > 0 ? eg : null;
    const nr = raw.notReady;
    const notReady = Array.isArray(nr) && nr.length > 0 && nr.every((p) => typeof p === 'string') ? (nr as string[]) : null;
    return { activeTaskId, unconfirmed, lastRegistered, engineGroup, notReady };
  } catch {
    return emptyState();
  }
}

export function writeState(file: string, s: WorkerState): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best effort
    }
    throw err;
  }
}
