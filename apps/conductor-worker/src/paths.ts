import path from 'node:path';

export interface WorkerPaths {
  root: string;
  home: string;
  pidFile: string;
  logFile: string;
  stateFile: string;
  stopFile: string;
  worktrees: string;
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
    worktrees: path.join(home, 'wt'),
  };
}

export function worktreePath(p: WorkerPaths, taskId: string): string {
  return path.join(p.worktrees, taskId);
}

export function defaultAgentId(hostname: string, repoPath: string): string {
  return sanitizeAgentId(`${hostname}-${path.basename(repoPath)}`);
}
