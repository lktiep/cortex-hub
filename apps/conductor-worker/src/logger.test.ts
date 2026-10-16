import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createLogger, redact } from './logger.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'cw-log-'));
afterAll(() => {
  try {
    chmodSync(path.join(dir, 'ro'), 0o700);
  } catch {
    // may not exist
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('redact', () => {
  it('masks the api key and apiKey= query values', () => {
    expect(redact('key sekret-1 here', ['sekret-1'])).toBe('key *** here');
    expect(redact('GET /ws?apiKey=abc123&x=1', [])).toBe('GET /ws?apiKey=***&x=1');
    expect(redact('u?apikey=abc d', [])).toBe('u?apikey=*** d');
    expect(redact('u?APIKEY=abc"', [])).toBe('u?APIKEY=***"');
    expect(redact("u?apiKey=abc'q", [])).toBe("u?apiKey=***'q");
    expect(redact('u?apiKey=abc', [])).toBe('u?apiKey=***');
  });

  it('ignores empty secrets and replaces longer secrets first', () => {
    expect(redact('hello', [''])).toBe('hello');
    expect(redact('abcdef', ['abc', 'abcdef'])).toBe('***');
  });
});

describe('logger', () => {
  it('writes ISO level lines and redacts added secrets', () => {
    const file = path.join(dir, 'a.log');
    const log = createLogger({ file, stdout: false, now: () => new Date('2026-01-01T00:00:00.000Z') });
    log.addSecret('topsecret');
    log.info('hi topsecret');
    log.warn('w');
    log.error('e');
    expect(readFileSync(file, 'utf8')).toBe(
      '2026-01-01T00:00:00.000Z INFO hi ***\n2026-01-01T00:00:00.000Z WARN w\n2026-01-01T00:00:00.000Z ERROR e\n',
    );
  });

  it('redacts on stdout too', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const log = createLogger({ stdout: true });
      log.addSecret('zzz');
      log.info('a zzz b');
      expect(spy.mock.calls.map((c) => String(c[0])).join('')).toContain('a *** b');
    } finally {
      spy.mockRestore();
    }
  });

  it('rotates at maxBytes and keeps one old file', () => {
    const file = path.join(dir, 'worker.log');
    const log = createLogger({ file, stdout: false, maxBytes: 100 });
    for (let i = 0; i < 4; i++) log.info(`line-${i}-${'x'.repeat(30)}`);
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(existsSync(`${file}.2`)).toBe(false);
    const cur = readFileSync(file, 'utf8');
    const old = readFileSync(`${file}.1`, 'utf8');
    expect(cur.length).toBeLessThanOrEqual(100);
    expect(old).toContain('line-');
    for (let i = 4; i < 12; i++) log.info(`line-${i}-${'x'.repeat(30)}`);
    expect(existsSync(`${file}.2`)).toBe(false);
    expect(readFileSync(`${file}.1`, 'utf8')).not.toContain('line-0-');
  });

  it('rotation survives a pre-existing oversize file', () => {
    const file = path.join(dir, 'pre.log');
    writeFileSync(file, 'y'.repeat(500));
    const log = createLogger({ file, stdout: false, maxBytes: 100 });
    log.info('new');
    expect(readFileSync(`${file}.1`, 'utf8')).toBe('y'.repeat(500));
    expect(readFileSync(file, 'utf8')).toContain('new');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('does not throw on a read-only dir', () => {
    const ro = path.join(dir, 'ro');
    mkdirSync(ro);
    chmodSync(ro, 0o500);
    const log = createLogger({ file: path.join(ro, 'w.log'), stdout: false });
    expect(() => log.info('x')).not.toThrow();
  });

  it('does not throw when the log path is unwritable (file as dir)', () => {
    const blocker = path.join(dir, 'blocker');
    writeFileSync(blocker, '');
    const log = createLogger({ file: path.join(blocker, 'w.log'), stdout: false });
    expect(() => log.error('x')).not.toThrow();
  });
});
