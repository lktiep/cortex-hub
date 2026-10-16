import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TaskCompleteMsg, TaskQuotaExhaustedMsg } from '@cortex/shared-types';

export interface WorkerState {
  activeTaskId: string | null;
  unconfirmed: { taskId: string; msg: TaskCompleteMsg | TaskQuotaExhaustedMsg } | null;
  lastRegistered: { projectId: string | null; hubVersion: string; at: string } | null;
}

const emptyState = (): WorkerState => ({ activeTaskId: null, unconfirmed: null, lastRegistered: null });

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function readState(file: string): WorkerState {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isObj(raw)) return emptyState();
    const activeTaskId = typeof raw.activeTaskId === 'string' ? raw.activeTaskId : null;
    const unconfirmed = isObj(raw.unconfirmed) && typeof raw.unconfirmed.taskId === 'string' && isObj(raw.unconfirmed.msg)
      ? (raw.unconfirmed as unknown as WorkerState['unconfirmed'])
      : null;
    const lastRegistered = isObj(raw.lastRegistered) && typeof raw.lastRegistered.hubVersion === 'string'
      ? (raw.lastRegistered as unknown as WorkerState['lastRegistered'])
      : null;
    return { activeTaskId, unconfirmed, lastRegistered };
  } catch {
    return emptyState();
  }
}

export function writeState(file: string, s: WorkerState): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, file);
}
