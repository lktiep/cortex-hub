import path from 'node:path';

export interface WorkerPaths {
  root: string;
  home: string;
  pidFile: string;
  logFile: string;
  stateFile: string;
  stopFile: string;
  /** The settings `start` ran with, so `restart` can run it again (may hold the key; owner-only). */
  startFile: string;
  worktrees: string;
  /** Each task's full engine output, `<taskId>.log` (owner-only; the newest few are kept). */
  transcripts: string;
}

export function workerRoot(homeDir: string): string {
  return path.join(homeDir, '.cortex', 'worker');
}

export function sanitizeAgentId(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 64);
  return cleaned === '' ? 'worker' : cleaned;
}

export function workerPaths(agentId: string, homeDir: string): WorkerPaths {
  const root = workerRoot(homeDir);
  const home = path.join(root, sanitizeAgentId(agentId));
  return {
    root,
    home,
    pidFile: path.join(home, 'worker.pid'),
    logFile: path.join(home, 'worker.log'),
    stateFile: path.join(home, 'state.json'),
    stopFile: path.join(home, 'worker.stop'),
    startFile: path.join(home, 'start.json'),
    worktrees: path.join(home, 'wt'),
    transcripts: path.join(home, 'tasks'),
  };
}

export function worktreePath(p: WorkerPaths, taskId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) throw new Error(`unsafe task id: ${taskId}`);
  return path.join(p.worktrees, taskId);
}

export function defaultAgentId(hostname: string, repoPath: string): string {
  return sanitizeAgentId(`${hostname}-${path.basename(repoPath)}`);
}
