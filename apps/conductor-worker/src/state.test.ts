import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readState, writeState, type WorkerState } from './state.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'cw-state-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const empty: WorkerState = { activeTaskId: null, unconfirmed: null, lastRegistered: null };

describe('state', () => {
  it('readState returns the empty state for a missing or corrupt file', () => {
    expect(readState(path.join(dir, 'missing.json'))).toEqual(empty);
    const bad = path.join(dir, 'bad.json');
    writeFileSync(bad, '{not json');
    expect(readState(bad)).toEqual(empty);
    const arr = path.join(dir, 'arr.json');
    writeFileSync(arr, '[1,2]');
    expect(readState(arr)).toEqual(empty);
  });

  it('writeState is atomic and round-trips', () => {
    const sub = path.join(dir, 'nested', 'deeper');
    const file = path.join(sub, 'state.json');
    const s: WorkerState = {
      activeTaskId: 't1',
      unconfirmed: null,
      lastRegistered: { projectId: null, hubVersion: '1.0.0', at: '2026-01-01T00:00:00.000Z' },
    };
    writeState(file, s);
    expect(readState(file)).toEqual(s);
    expect(readdirSync(sub)).toEqual(['state.json']);
    writeState(file, empty);
    expect(readState(file)).toEqual(empty);
    expect(readdirSync(sub)).toEqual(['state.json']);
  });

  it('readState of an existing dir path does not throw', () => {
    mkdirSync(path.join(dir, 'adir'));
    expect(readState(path.join(dir, 'adir'))).toEqual(empty);
  });

  it('drops invalid nested fields but keeps valid ones', () => {
    const f = path.join(dir, 'nested.json');
    const read = (o: unknown): WorkerState => {
      writeFileSync(f, JSON.stringify(o));
      return readState(f);
    };
    const lr = { projectId: null, hubVersion: '1', at: 'x' };
    expect(read({ lastRegistered: { ...lr, projectId: 42 } }).lastRegistered).toBeNull();
    expect(read({ lastRegistered: { projectId: 'p', hubVersion: '1' } }).lastRegistered).toBeNull();
    expect(read({ lastRegistered: lr }).lastRegistered).toEqual(lr);
    expect(read({ unconfirmed: { taskId: 't', msg: {} } }).unconfirmed).toBeNull();
    expect(read({ unconfirmed: { taskId: 't', msg: { type: 'bogus' } } }).unconfirmed).toBeNull();
    const ok = { taskId: 't', msg: { type: 'task.complete' } };
    expect(read({ unconfirmed: ok }).unconfirmed).toEqual(ok);
    const part = read({ activeTaskId: 't9', unconfirmed: { taskId: 1 }, lastRegistered: 5 });
    expect(part).toEqual({ activeTaskId: 't9', unconfirmed: null, lastRegistered: null });
  });
});
