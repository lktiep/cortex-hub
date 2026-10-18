import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultAgentId, sanitizeAgentId, workerPaths, workerRoot, worktreePath } from './paths.js';

describe('paths', () => {
  it('builds per-agent paths with path.join', () => {
    const p = workerPaths('a1', '/h');
    expect(p.pidFile).toBe(path.join('/h', '.cortex', 'worker', 'a1', 'worker.pid'));
    expect(p.logFile).toBe(path.join('/h', '.cortex', 'worker', 'a1', 'worker.log'));
    expect(p.stateFile).toBe(path.join('/h', '.cortex', 'worker', 'a1', 'state.json'));
    expect(p.stopFile).toBe(path.join('/h', '.cortex', 'worker', 'a1', 'worker.stop'));
    expect(p.startFile).toBe(path.join('/h', '.cortex', 'worker', 'a1', 'start.json'));
    expect(p.worktrees).toBe(path.join('/h', '.cortex', 'worker', 'a1', 'wt'));
    expect(p.root).toBe(workerRoot('/h'));
    expect(worktreePath(p, 't1')).toBe(path.join(p.home, 'wt', 't1'));
  });

  it('two agent ids never share a pid, log or state file', () => {
    const a = workerPaths('a1', '/h');
    const b = workerPaths('a2', '/h');
    expect(a.pidFile).not.toBe(b.pidFile);
    expect(a.logFile).not.toBe(b.logFile);
    expect(a.stateFile).not.toBe(b.stateFile);
  });

  it('sanitizeAgentId produces a safe id', () => {
    const s = sanitizeAgentId('My Box/../x');
    expect(s).toBe('my-box-..-x');
    expect(s).not.toMatch(/[/\\]/);
    expect(sanitizeAgentId('..')).toBe('worker');
    expect(sanitizeAgentId('.hidden')).toBe('hidden');
    expect(sanitizeAgentId('')).toBe('worker');
    expect(sanitizeAgentId('a'.repeat(100))).toHaveLength(64);
  });

  it('workerPaths cannot escape workerRoot', () => {
    const p = workerPaths('../../etc', '/h');
    expect(path.dirname(p.home)).toBe(workerRoot('/h'));
  });

  it('defaultAgentId joins host and repo basename', () => {
    expect(defaultAgentId('Box', '/src/My Repo')).toBe('box-my-repo');
  });

  it('worktreePath accepts hub ids and refuses unsafe ones', () => {
    const p = workerPaths('a1', '/h');
    expect(worktreePath(p, 'task_abc123')).toBe(path.join(p.worktrees, 'task_abc123'));
    for (const bad of ['../x', 'a/b', '', '..']) {
      expect(() => worktreePath(p, bad)).toThrow(`unsafe task id: ${bad}`);
    }
  });
});
