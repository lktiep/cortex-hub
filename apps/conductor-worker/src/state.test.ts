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
});
