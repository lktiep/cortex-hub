import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newestTranscript, openTranscript } from './transcript.js';

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'cw-transcript-'));
  dirs.push(d);
  return path.join(d, 'tasks');
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Writes `<dir>/<name>.log` dated `secondsAgo` in the past. */
function oldLog(dir: string, name: string, secondsAgo: number): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.log`);
  writeFileSync(file, `${name}\n`);
  const at = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(file, at, at);
  return file;
}

describe('openTranscript', () => {
  it('writes the header and each entry on its own line, and appends on a retry', () => {
    const dir = freshDir();
    const t = openTranscript(dir, 't1', '--- task t1 attempt 1');
    expect(t.file).toBe(path.join(dir, 't1.log'));
    t.write('one');
    t.write('two\n');
    t.close();
    const again = openTranscript(dir, 't1', '--- task t1 attempt 2');
    again.write('three');
    again.close();
    expect(readFileSync(path.join(dir, 't1.log'), 'utf8')).toBe(
      '--- task t1 attempt 1\none\ntwo\n--- task t1 attempt 2\nthree\n',
    );
  });

  it.skipIf(process.platform === 'win32')('is readable by its owner only', () => {
    const dir = freshDir();
    const t = openTranscript(dir, 't1', 'h');
    t.close();
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(dir, 't1.log')).mode & 0o777).toBe(0o600);
  });

  it('keeps the newest transcripts, the new one among them', () => {
    const dir = freshDir();
    for (let i = 0; i < 5; i++) oldLog(dir, `old${i}`, 100 - i);
    writeFileSync(path.join(dir, 'notes.txt'), 'not a transcript\n');
    openTranscript(dir, 'new', 'h', { kept: 3 }).close();
    expect(readdirSync(dir).sort()).toEqual(['new.log', 'notes.txt', 'old3.log', 'old4.log']);
  });

  it('stops at the size cap with a note, written once', () => {
    const dir = freshDir();
    const t = openTranscript(dir, 't1', 'head', { maxBytes: 1024 * 1024 });
    t.write('x'.repeat(1024 * 1024));
    t.write('more');
    t.close();
    expect(readFileSync(path.join(dir, 't1.log'), 'utf8')).toBe(
      'head\n(the transcript reached 1 MB; the rest is not kept)\n',
    );
  });

  it('opens nothing for an unsafe task id, and writing to it does nothing', () => {
    const dir = freshDir();
    const t = openTranscript(dir, '../evil', 'h');
    expect(t.file).toBeNull();
    expect(() => {
      t.write('x');
      t.close();
    }).not.toThrow();
    expect(newestTranscript(dir)).toBeNull();
  });

  it('writing after close does nothing', () => {
    const dir = freshDir();
    const t = openTranscript(dir, 't1', 'h');
    t.close();
    t.write('late');
    expect(readFileSync(path.join(dir, 't1.log'), 'utf8')).toBe('h\n');
  });
});

describe('newestTranscript', () => {
  it('is the most recently written transcript, or null', () => {
    const dir = freshDir();
    expect(newestTranscript(dir)).toBeNull();
    oldLog(dir, 'a', 50);
    const b = oldLog(dir, 'b', 10);
    oldLog(dir, 'c', 30);
    expect(newestTranscript(dir)).toBe(b);
  });
});
